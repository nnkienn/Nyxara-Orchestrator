import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskHistoryStore } from "../src/task-history-store.js";
import { createTaskSession, deterministicTaskTitle, safeWorkspaceIdentity, sanitizeTaskSession } from "../src/task-session.js";

const roots: string[] = [];
const workspace = safeWorkspaceIdentity("Private Project", "/home/person/private/project");
const input = (requirement: string, id: string, now: string) => ({ requirement, id, now, workspaceIdentity: workspace });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "nyxara-history-")); roots.push(value); return value; }

describe("TaskSession local history domain", () => {
  it("creates, updates, retrieves, and lists sessions newest first", () => {
    const store = new TaskHistoryStore();
    store.create(input("Older task", "old", "2026-01-01T00:00:00.000Z"));
    store.create(input("Newer task", "new", "2026-01-02T00:00:00.000Z"));
    expect(store.list().map((task) => task.id)).toEqual(["new", "old"]);
    expect(store.update("old", { status: "completed", updatedAt: "2026-01-03T00:00:00.000Z" })?.status).toBe("completed");
    expect(store.get("old")?.title).toBe("Older task");
  });

  it("enforces deterministic titles, whitespace normalization, and bounds without a provider call", () => {
    const provider = vi.fn();
    expect(deterministicTaskTitle("\n  Add   pagination   now \nDetails")).toBe("Add pagination now");
    expect(deterministicTaskTitle("x".repeat(200))).toHaveLength(100);
    expect(provider).not.toHaveBeenCalled();
  });

  it("bounds retention, never evicts active work, and evicts the oldest terminal task", () => {
    const store = new TaskHistoryStore(undefined, 3);
    store.create(input("Active", "active", "2026-01-01T00:00:00.000Z"));
    for (let index = 1; index <= 4; index += 1) {
      const id = `done-${index}`; const stamp = `2026-01-0${index + 1}T00:00:00.000Z`;
      store.create(input(id, id, stamp)); store.update(id, { status: "completed", updatedAt: stamp });
    }
    expect(store.list().map((task) => task.id)).toEqual(["done-4", "done-3", "active"]);
    expect(store.get("active")).toBeDefined();
    expect(store.get("done-1")).toBeUndefined();
  });

  it("changes bounded retention immediately and rejects unlimited or invalid values", () => {
    const store = new TaskHistoryStore(undefined, 100); store.create(input("Active", "active", "2026-01-01T00:00:00.000Z"));
    for (let index = 0; index < 25; index += 1) { const id = `done-${index}`; store.create(input(id, id, `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`)); store.update(id, { status: "completed" }); }
    store.setRetention(20); expect(store.retention).toBe(20); expect(store.list()).toHaveLength(20); expect(store.get("active")).toBeDefined(); expect(store.get("done-0")).toBeUndefined(); store.setRetention(100); expect(store.retention).toBe(100); expect(() => store.setRetention(Infinity)).toThrow(); expect(() => store.setRetention(21)).toThrow();
  });

  it("deletes only terminal tasks and clear preserves every active task", () => {
    const store = new TaskHistoryStore();
    store.create(input("Active", "active", "2026-01-01T00:00:00.000Z"));
    store.create(input("Done", "done", "2026-01-02T00:00:00.000Z"));
    store.update("done", { status: "completed" });
    expect(() => store.delete("active")).toThrow("active task");
    expect(store.delete("done")).toBe(true);
    store.create(input("Failed", "failed", "2026-01-03T00:00:00.000Z")); store.update("failed", { status: "failed" });
    expect(store.clear()).toBe(1);
    expect(store.list().map((task) => task.id)).toEqual(["active"]);
  });

  it("searches title and requirement locally and scopes without exposing full paths", () => {
    const other = safeWorkspaceIdentity("Other", "/secret/other");
    const store = new TaskHistoryStore();
    store.create(input("Fix Notification API", "one", "2026-01-01T00:00:00.000Z"));
    store.create({ requirement: "Refactor auth", workspaceIdentity: other, id: "two", now: "2026-01-02T00:00:00.000Z" });
    expect(store.search("notification").map((task) => task.id)).toEqual(["one"]);
    expect(store.list({ workspaceId: workspace.id }).map((task) => task.id)).toEqual(["one"]);
    expect(JSON.stringify(store.list())).not.toContain("/home/person");
  });

  it("prioritizes the current workspace when browsing all workspaces", () => {
    const other = safeWorkspaceIdentity("Other", "/secret/other");
    const store = new TaskHistoryStore();
    store.create(input("Current but older", "current", "2026-01-01T00:00:00.000Z"));
    store.create({ requirement: "Other but newer", workspaceIdentity: other, id: "other", now: "2026-01-02T00:00:00.000Z" });
    expect(store.list({ allWorkspaces: true, workspaceId: workspace.id }).map((task) => task.id)).toEqual(["current", "other"]);
  });
});

describe("TaskHistoryStore persistence", () => {
  it("survives reload with schema version 1 and atomically removes the temporary file", async () => {
    const directory = await root();
    const store = new TaskHistoryStore(directory);
    store.create(input("Persist me", "persist", "2026-01-01T00:00:00.000Z"));
    store.update("persist", { status: "completed" });
    await store.flush();
    const file = JSON.parse(await readFile(path.join(directory, "task-history.v1.json"), "utf8"));
    expect(file.schemaVersion).toBe(1);
    expect(await readFile(path.join(directory, "task-history.v1.json.tmp"), "utf8").catch(() => undefined)).toBeUndefined();
    expect(new TaskHistoryStore(directory).get("persist")?.status).toBe("completed");
  });

  it("ignores malformed records, preserves valid records, and never crashes on corrupt JSON", async () => {
    const directory = await root(); const diagnostics: string[] = [];
    const valid = createTaskSession(input("Valid", "valid", "2026-01-01T00:00:00.000Z"));
    await writeFile(path.join(directory, "task-history.v1.json"), JSON.stringify({ schemaVersion: 1, sessions: [{ bad: true }, valid] }));
    expect(new TaskHistoryStore(directory, 50, (message) => diagnostics.push(message)).list()).toHaveLength(1);
    expect(diagnostics).toContain("Ignored one malformed local task history record.");
    await writeFile(path.join(directory, "task-history.v1.json"), "{broken");
    expect(() => new TaskHistoryStore(directory, 50, (message) => diagnostics.push(message))).not.toThrow();
  });

  it("marks persisted planning/executing work interrupted while leaving terminal states unchanged", async () => {
    const directory = await root(); const store = new TaskHistoryStore(directory);
    for (const [id, status] of [["planning", "planning"], ["running", "executing"], ["complete", "completed"], ["failed", "failed"]] as const) {
      store.create(input(id, id, `2026-01-0${store.list().length + 1}T00:00:00.000Z`)); store.update(id, { status });
    }
    await store.flush();
    const reloaded = new TaskHistoryStore(directory);
    expect(reloaded.markInterrupted()).toBe(2);
    expect(reloaded.get("planning")?.status).toBe("interrupted");
    expect(reloaded.get("running")?.status).toBe("interrupted");
    expect(reloaded.get("complete")?.status).toBe("completed");
    expect(reloaded.get("failed")?.status).toBe("failed");
  });

  it("preserves a matching authoritative active workflow while interrupting stale projections", () => {
    const store = new TaskHistoryStore();
    store.create(input("Authoritative", "authoritative", "2026-01-01T00:00:00.000Z"));
    store.update("authoritative", { status: "executing", workflowId: "workflow-live" });
    store.create(input("Stale", "stale", "2026-01-02T00:00:00.000Z"));
    store.update("stale", { status: "planning", workflowId: "workflow-stale" });
    expect(store.markInterrupted(new Set(["workflow-live"]))).toBe(1);
    expect(store.get("authoritative")?.status).toBe("executing");
    expect(store.get("stale")?.status).toBe("interrupted");
  });

  it("allowlists safe summaries and excludes secrets and raw provider/tool/validation/diff data", () => {
    const dirty: any = { ...createTaskSession(input("Safe requirement", "safe", "2026-01-01T00:00:00.000Z")), apiKey: "sk-secret", oauthToken: "oauth-secret", authorization: "Bearer secret", providerRawResponse: "RAW_PROVIDER", toolOutput: "RAW_TOOL", fullDiff: "RAW_DIFF", validationStdout: "RAW_STDOUT", validationStderr: "RAW_STDERR", environment: { SECRET: "ENV_SECRET" }, usageSummary: { totalTokens: 7073, providerCalls: 4, toolCalls: 9, workflowDurationMs: 20600.5, repairCycles: 1 } };
    const text = JSON.stringify(sanitizeTaskSession(dirty));
    expect(text).toContain("7073");
    for (const forbidden of ["sk-secret", "oauth-secret", "Bearer secret", "RAW_PROVIDER", "RAW_TOOL", "RAW_DIFF", "RAW_STDOUT", "RAW_STDERR", "ENV_SECRET"]) expect(text).not.toContain(forbidden);
  });
});
