import { beforeEach, describe, expect, it, vi } from "vitest";
import { NyxaraSession } from "../src/session.js";

function fakeCore() {
  return {
    events: { on: vi.fn(() => () => undefined) },
    configureAgent: vi.fn(),
    startWorkflow: vi.fn(() => ({ id: "workflow-1" })),
    createPlan: vi.fn(),
    approvePlan: vi.fn(),
    runApprovedPlan: vi.fn(async () => ({ status: "waiting_for_permission" })),
    rejectPlan: vi.fn(),
    pauseWorkflow: vi.fn(),
    resumeWorkflow: vi.fn(),
    abortWorkflow: vi.fn(),
    resolveWorkflowPermission: vi.fn(async () => ({ status: "paused" })),
    getWorkflowSnapshot: vi.fn(() => ({ status: "awaiting_plan_approval", tasks: [] })),
  };
}

function createSession(core = fakeCore()) {
  const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };
  const output = { appendLine: vi.fn() };
  return { session: new NyxaraSession({ secrets }, output, "https://example.invalid/v1", core as any), core, secrets, output };
}

describe("NyxaraSession Core boundary", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("constructs without provider calls, context builds, repository scans, Git, or timers", () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch");
    const { session } = createSession();
    expect(session.workflowId).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("constructs the real provider/Core adapters without fetching credentials or doing background work", () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch");
    const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };
    const output = { appendLine: vi.fn() };
    const session = new NyxaraSession({ secrets }, output, "https://example.invalid/v1");
    expect(session.workflowId).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
    expect(output.appendLine).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("configures Planner, Executor, and Reviewer independently and preserves routed model IDs exactly", () => {
    const { session, core } = createSession();
    const values: Record<string, string> = {
      "nyxara.planner.provider": "openai-compatible",
      "nyxara.planner.model": "ha-op/gpt-5.6-sol",
      "nyxara.executor.provider": "openai-compatible",
      "nyxara.executor.model": "executor/model:exact",
      "nyxara.reviewer.provider": "review-provider",
      "nyxara.reviewer.model": "reviewer/model@exact",
    };
    session.configureAgents((key) => values[key] ?? "");
    expect(core.configureAgent.mock.calls).toEqual([
      [{ role: "planner", providerId: "openai-compatible", modelId: "ha-op/gpt-5.6-sol" }],
      [{ role: "executor", providerId: "openai-compatible", modelId: "executor/model:exact" }],
      [{ role: "reviewer", providerId: "review-provider", modelId: "reviewer/model@exact" }],
    ]);
    expect(session.configured).toBe(true);
  });

  it("remains Not configured until all three role models are present", () => {
    const { session } = createSession();
    const values: Record<string, string> = {
      "nyxara.planner.provider": "openai-compatible",
      "nyxara.planner.model": "planner/exact",
    };
    session.configureAgents((key) => values[key] ?? "");
    expect(session.configured).toBe(false);
  });

  it("projects the Core plan result and never creates a client-side plan", async () => {
    const { session, core } = createSession();
    const result = { plan: { id: "plan-1", objective: "tiny", tasks: [] }, model: { modelId: "m" } };
    core.createPlan.mockResolvedValue(result);
    await expect(session.generate("tiny task", "/workspace", "default")).resolves.toBe(result);
    expect(core.startWorkflow).toHaveBeenCalledWith({ workspace: "/workspace", prompt: "tiny task" });
    expect(core.createPlan).toHaveBeenCalledWith({ workspaceRoot: "/workspace", prompt: "tiny task", workflowId: "workflow-1", planningProfileId: "default" });
    expect(session.currentPlan).toBe(result.plan);
  });

  it("Approve & Run delegates to existing Core approval and run APIs", async () => {
    const { session, core } = createSession();
    session.workflowId = "workflow-1";
    session.plan = { plan: { id: "plan-1" } } as any;
    await session.approveAndRun();
    expect(core.approvePlan).toHaveBeenCalledWith("workflow-1", "plan-1");
    expect(core.runApprovedPlan).toHaveBeenCalledWith({ workflowId: "workflow-1", planId: "plan-1" });
    expect(core.approvePlan.mock.invocationCallOrder[0]).toBeLessThan(core.runApprovedPlan.mock.invocationCallOrder[0]);
  });

  it("Reject Plan delegates to the existing Core reject API", () => {
    const { session, core } = createSession();
    session.workflowId = "workflow-1";
    session.plan = { plan: { id: "plan-1" } } as any;
    session.rejectPlan();
    expect(core.rejectPlan).toHaveBeenCalledWith("workflow-1", "plan-1");
  });

  it.each(["allow", "deny"] as const)("forwards the exact pending request ID for %s", async (decision) => {
    const { session, core } = createSession();
    session.workflowId = "workflow-1";
    await session.resolvePermission("pending-request/exact", decision);
    expect(core.resolveWorkflowPermission).toHaveBeenCalledWith({ workflowId: "workflow-1", permissionRequestId: "pending-request/exact", decision });
  });

  it("abort delegates to Core", () => {
    const { session, core } = createSession();
    session.workflowId = "workflow-1";
    session.abort();
    expect(core.abortWorkflow).toHaveBeenCalledWith("workflow-1");
  });
});
