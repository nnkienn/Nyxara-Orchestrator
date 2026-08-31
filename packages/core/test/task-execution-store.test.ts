import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  ExecutorError,
  TASK_TRANSITIONS,
  TaskExecutionStore,
  type ExecutionPlan,
  type ExecutionResult,
  type TaskExecutionStatus,
} from "../src/index.js";

function plan(id: string, taskIds: readonly string[] = ["T1"]): ExecutionPlan {
  return {
    id,
    objective: "Bound retained execution state",
    tasks: taskIds.map((taskId, index) => ({
      id: taskId,
      title: "Task " + taskId,
      description: "Work for " + taskId,
      dependencies: index === 0 ? [] : [taskIds[index - 1]!],
      acceptanceCriteria: ["Criterion for " + taskId],
    })),
    createdAt: "2026-08-30T00:00:00.000Z",
  } as ExecutionPlan;
}

function result(
  taskId: string,
  status: "completed" | "failed" = "completed",
): ExecutionResult {
  return {
    taskId,
    status,
    summary: "Did the work for " + taskId,
    changedFiles: ["src/" + taskId + ".ts"],
    toolCalls: 2,
    modelTurns: 3,
    diff: { files: ["src/" + taskId + ".ts"], truncated: false },
    git: {
      initialStatus: { files: [] },
      finalStatus: { files: [] },
      diff: { diff: "diff --git a/src/x b/src/x\n+heavy diff text", truncated: false },
      initialDiffFiles: [],
    },
  } as unknown as ExecutionResult;
}

describe("Task runtime transitions", () => {
  it("declares the legal transition table explicitly", () => {
    expect(TASK_TRANSITIONS).toEqual({
      pending: ["ready", "blocked"],
      ready: ["running", "pending", "blocked"],
      running: ["completed", "failed"],
      completed: [],
      failed: ["running"],
      blocked: ["pending", "ready"],
    });
  });

  it("allows failed -> running only so repair can retry", () => {
    expect(canTransitionTask("failed", "running")).toBe(true);
    expect(canTransitionTask("completed", "running")).toBe(false);
    expect(canTransitionTask("failed", "completed")).toBe(false);
  });

  it("rejects arbitrary mutation of terminal task state", () => {
    const illegal: ReadonlyArray<[TaskExecutionStatus, TaskExecutionStatus]> = [
      ["pending", "running"],
      ["pending", "completed"],
      ["ready", "completed"],
      ["running", "blocked"],
      ["completed", "failed"],
      ["completed", "pending"],
      ["blocked", "running"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransitionTask(from, to)).toBe(false);
    }
  });

  it("treats a no-op transition as legal", () => {
    expect(canTransitionTask("running", "running")).toBe(true);
  });

  it("rejects an illegal transition at the store boundary", () => {
    const store = new TaskExecutionStore();
    const current = plan("plan-illegal");

    // finish() without begin() would be running -> completed from "ready".
    expect(() => store.finish(current, result("T1"))).toThrow(ExecutorError);
  });

  it("moves a task through begin and finish, tracking attempts", () => {
    const store = new TaskExecutionStore();
    const current = plan("plan-happy");

    expect(store.get(current, "T1")?.status).toBe("ready");
    const started = store.begin(current, "T1");
    expect(started.state.status).toBe("running");
    expect(started.state.attempts).toBe(1);

    const finished = store.finish(current, result("T1"));
    expect(finished.status).toBe("completed");
    expect(finished.attempts).toBe(1);
  });

  it("permits a repair retry after failure", () => {
    const store = new TaskExecutionStore();
    const current = plan("plan-retry");

    store.begin(current, "T1");
    store.fail(current, "T1");
    expect(store.get(current, "T1")?.status).toBe("failed");

    const retried = store.begin(current, "T1");
    expect(retried.state.status).toBe("running");
    expect(retried.state.attempts).toBe(2);
  });

  it("blocks a dependent task when its dependency fails", () => {
    const store = new TaskExecutionStore();
    const current = plan("plan-blocked", ["T1", "T2"]);

    expect(store.get(current, "T2")?.status).toBe("pending");
    store.begin(current, "T1");
    store.fail(current, "T1");

    expect(store.get(current, "T2")?.status).toBe("blocked");
    expect(() => store.begin(current, "T2")).toThrow(ExecutorError);
  });

  it("rejects an unknown task", () => {
    const store = new TaskExecutionStore();
    expect(() => store.begin(plan("plan-unknown"), "T9")).toThrow(ExecutorError);
  });
});

describe("TaskExecutionStore retention bounds", () => {
  it("evicts the oldest plan beyond maxPlans", () => {
    const store = new TaskExecutionStore(undefined, { maxPlans: 2 });
    const first = plan("plan-1");
    const second = plan("plan-2");
    const third = plan("plan-3");

    store.begin(first, "T1");
    store.finish(first, result("T1"));
    store.list(second);
    store.list(third);

    // The evicted plan is re-seeded from scratch instead of growing forever.
    expect(store.get(first, "T1")?.status).toBe("ready");
    expect(store.get(first, "T1")?.attempts).toBe(0);
  });

  it("never evicts a plan that still has a running task", () => {
    const store = new TaskExecutionStore(undefined, { maxPlans: 1 });
    const active = plan("plan-active");
    const other = plan("plan-other");

    store.begin(active, "T1");
    store.list(other);

    expect(store.get(active, "T1")?.status).toBe("running");
    expect(store.get(active, "T1")?.attempts).toBe(1);
  });

  it("rejects a plan larger than the task retention bound", () => {
    const store = new TaskExecutionStore(undefined, { maxTasksPerPlan: 2 });
    const oversized = plan("plan-oversized", ["T1", "T2", "T3"]);

    expect(() => store.list(oversized)).toThrow(ExecutorError);
  });

  it("keeps heavy evidence for the newest terminal task and compacts the rest", () => {
    const store = new TaskExecutionStore();
    const current = plan("plan-compaction", ["T1", "T2"]);

    store.begin(current, "T1");
    store.finish(current, result("T1"));
    expect(store.get(current, "T1")?.result).toBeDefined();

    store.begin(current, "T2");
    store.finish(current, result("T2"));

    const superseded = store.get(current, "T1")!;
    const newest = store.get(current, "T2")!;

    // Superseded task releases the full ExecutionResult but keeps its summary.
    expect(superseded.result).toBeUndefined();
    expect(superseded.resultSummary).toMatchObject({
      taskId: "T1",
      status: "completed",
      changedFiles: ["src/T1.ts"],
      diffFiles: ["src/T1.ts"],
      diffTruncated: false,
    });
    expect(newest.result).toBeDefined();
  });

  it("retains no git snapshots or raw diff text in a compacted summary", () => {
    const store = new TaskExecutionStore();
    const current = plan("plan-summary", ["T1", "T2"]);

    store.begin(current, "T1");
    store.finish(current, result("T1"));
    store.begin(current, "T2");
    store.finish(current, result("T2"));

    const serialized = JSON.stringify(store.get(current, "T1"));
    expect(serialized).not.toContain("heavy diff text");
    expect(serialized).not.toContain("initialStatus");
  });
});
