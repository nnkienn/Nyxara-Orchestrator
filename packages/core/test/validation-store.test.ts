import { describe, expect, it } from "vitest";
import { ValidationStore, type ValidationResult } from "../src/index.js";

let clock = 0;
function validation(
  status: "passed" | "failed",
  taskId?: string,
  planId?: string,
): ValidationResult {
  clock += 1;
  return {
    status,
    packageManager: "pnpm",
    steps: [
      {
        kind: "test",
        status: status === "passed" ? "passed" : "failed",
        required: true,
        source: "discovered",
        durationMs: 5,
        stdout: "verbose stdout for " + (taskId ?? "global") + " #" + clock,
        stderr: "verbose stderr payload",
      },
    ],
    startedAt: "2026-08-30T00:00:0" + (clock % 10) + ".000Z",
    completedAt: "2026-08-30T00:00:0" + (clock % 10) + ".500Z",
    durationMs: 500,
    ...(planId ? { planId } : {}),
    ...(taskId ? { taskId } : {}),
  } as ValidationResult;
}

describe("ValidationStore task awareness", () => {
  it("keeps validation results separate per task", () => {
    const store = new ValidationStore();
    const a = validation("passed", "A");
    const b = validation("failed", "B");
    store.set(a);
    store.set(b);

    expect(store.getLatest({ taskId: "A" })?.status).toBe("passed");
    expect(store.getLatest({ taskId: "B" })?.status).toBe("failed");
  });

  it("does not let one task overwrite another", () => {
    const store = new ValidationStore();
    store.set(validation("passed", "A"));
    store.set(validation("failed", "B"));
    store.set(validation("passed", "B"));

    expect(store.getLatest({ taskId: "A" })?.status).toBe("passed");
    expect(store.getHistory({ taskId: "A" })).toHaveLength(1);
    expect(
      store.getHistory({ taskId: "B" }).map((entry) => entry.status),
    ).toEqual(["failed", "passed"]);
  });

  it("returns bounded repair history in order (A1 FAIL, A2 FAIL, A3 PASS)", () => {
    const store = new ValidationStore();
    store.set(validation("failed", "A"));
    store.set(validation("failed", "A"));
    store.set(validation("passed", "A"));

    const history = store.getHistory({ taskId: "A" });
    expect(history.map((entry) => entry.status)).toEqual([
      "failed",
      "failed",
      "passed",
    ]);
    expect(store.getLatest({ taskId: "A" })?.status).toBe("passed");
  });

  it("bounds history to the configured window", () => {
    const store = new ValidationStore({ maxHistoryPerTask: 2 });
    store.set(validation("failed", "A"));
    store.set(validation("failed", "A"));
    store.set(validation("passed", "A"));

    const history = store.getHistory({ taskId: "A" });
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.status)).toEqual(["failed", "passed"]);
  });

  it("retains command output only for the newest entry", () => {
    const store = new ValidationStore();
    store.set(validation("failed", "A"));
    store.set(validation("passed", "A"));

    const [older, newest] = store.getHistory({ taskId: "A" });
    expect(older?.steps[0]?.stdout).toBeUndefined();
    expect(older?.steps[0]?.stderr).toBeUndefined();
    expect(newest?.steps[0]?.stdout).toBeDefined();
  });

  it("distinguishes plan-scoped tasks and falls back for plan-agnostic lookups", () => {
    const store = new ValidationStore();
    store.set(validation("passed", "T1", "plan-1"));
    store.set(validation("failed", "T1", "plan-2"));

    expect(store.getLatest({ taskId: "T1", planId: "plan-1" })?.status).toBe(
      "passed",
    );
    expect(store.getLatest({ taskId: "T1", planId: "plan-2" })?.status).toBe(
      "failed",
    );
    // No plan given: the most recently updated entry for the task wins.
    expect(store.getLatest({ taskId: "T1" })?.status).toBe("failed");
    expect(store.getHistory({ taskId: "T1", planId: "plan-missing" })).toEqual(
      [],
    );
  });

  it("bounds the number of tracked tasks", () => {
    const store = new ValidationStore({ maxTrackedTasks: 2 });
    store.set(validation("passed", "A"));
    store.set(validation("passed", "B"));
    store.set(validation("passed", "C"));

    expect(store.getHistory({ taskId: "A" })).toEqual([]);
    expect(store.getHistory({ taskId: "C" })).toHaveLength(1);
  });

  it("still exposes the global latest result for legacy callers", () => {
    const store = new ValidationStore();
    store.set(validation("passed", "A"));
    const anon = validation("failed");
    store.set(anon);

    expect(store.getLatest()?.status).toBe("failed");
  });

  it("rejects non-positive limits", () => {
    expect(() => new ValidationStore({ maxHistoryPerTask: 0 })).toThrow();
    expect(() => new ValidationStore({ maxTrackedTasks: -1 })).toThrow();
  });
});
