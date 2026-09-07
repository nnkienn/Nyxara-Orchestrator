import { beforeEach, describe, expect, it, vi } from "vitest";
import { NyxaraSession } from "../src/session.js";
import { resolveWorkflowSettings } from "../src/workflow-settings.js";

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

  it("logs command outcomes and validation codes without arguments or output", () => {
    const { session, core, output } = createSession();
    session.workflowId = "workflow-1";
    const listeners = core.events.on.mock.calls as unknown as Array<[string, (event: unknown) => void]>;
    listeners.find(([name]) => name === "tool.failed")![1]({ tool: "run_command", code: "command_timeout", args: ["private-argument"], stdout: "private-output" });
    listeners.find(([name]) => name === "validation.failed")![1]({ errorCode: "no_validation_commands", stdout: "private-output" });
    expect(output.appendLine).toHaveBeenCalledWith("Command tool failed (command_timeout)");
    expect(output.appendLine).toHaveBeenCalledWith("Validation failed (no_validation_commands)");
    expect(JSON.stringify(output.appendLine.mock.calls)).not.toContain("private-");
  });

  it("logs only safe Planner completion metrics for the active workflow", () => {
    const { session, core, output } = createSession();
    session.workflowId = "workflow-1";
    session.onChange = vi.fn();
    const listener = (core.events.on.mock.calls as unknown as Array<[string, (event: unknown) => void]>)
      .find(([name]) => name === "provider.generation.completed")![1];
    const event = {
      role: "planner", workflowId: "workflow-1", finishReason: "length", textLength: 123,
      providerDurationMs: 79_838, contextFiles: 4, contextBytes: 8_000, contextTruncated: false,
      text: "private-provider-response", responseId: "private-response-id", providerId: "private-provider-name",
    };
    listener(event);
    expect(output.appendLine).toHaveBeenCalledExactlyOnceWith('Planner response received: {"characters":123,"finishReason":"length","providerDurationMs":79838,"contextFiles":4,"contextBytes":8000,"contextTruncated":false}');
    expect(session.onChange).not.toHaveBeenCalled();
    expect(core.createPlan).not.toHaveBeenCalled();
    listener({ ...event, role: "executor" });
    listener({ ...event, workflowId: "old-workflow" });
    listener({ ...event, workflowId: undefined });
    expect(output.appendLine).toHaveBeenCalledOnce();
    listener({ ...event, finishReason: "secret-unknown-stop", textLength: Number.NaN, providerDurationMs: -1, contextFiles: undefined, contextBytes: Infinity, contextTruncated: undefined });
    expect(output.appendLine).toHaveBeenLastCalledWith('Planner response received: {"characters":null,"finishReason":"unknown","providerDurationMs":null,"contextFiles":null,"contextBytes":null,"contextTruncated":null}');
    expect(JSON.stringify(output.appendLine.mock.calls)).not.toMatch(/private-|secret-/);
  });

  it("snapshots settings at task generation, preserving the plan through approval and resume", async () => {
    const core = fakeCore();
    let settings = resolveWorkflowSettings({ allowRepair: false, repairLimits: { maxRepairCycles: 1 }, validation: { failFast: false }, reviewerLimits: { maxReviewerTurns: 1 } });
    const original = structuredClone(settings);
    const read = vi.fn(() => settings);
    const session = new NyxaraSession({ secrets: { get: vi.fn() } }, { appendLine: vi.fn() }, [], core as any, read);
    core.createPlan.mockResolvedValue({ plan: { id: "plan-1", tasks: [] } });
    core.resumeWorkflow.mockResolvedValue({ status: "paused" });
    await session.generate("task", "/workspace", "default");
    settings = resolveWorkflowSettings({ repairLimits: { maxRepairCycles: 5 } });
    await session.regenerate("task revised", "/workspace", "default");
    await session.approveAndRun();
    expect(core.runApprovedPlan).toHaveBeenLastCalledWith({ ...original, workflowId: "workflow-1", planId: "plan-1" });
    await session.resume();
    expect(read).toHaveBeenCalledTimes(1);
    expect(core.resumeWorkflow).toHaveBeenCalledWith("workflow-1");
    core.getWorkflowSnapshot.mockReturnValue({ status: "completed", tasks: [] });
    session.resetPresentation();
    await session.generate("next task", "/workspace", "default");
    await session.approveAndRun();
    expect(core.runApprovedPlan).toHaveBeenLastCalledWith({ ...settings, workflowId: "workflow-1", planId: "plan-1" });
    expect(read).toHaveBeenCalledTimes(2);
  });

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
      [{ role: "planner", providerId: "openai-compatible", modelId: "ha-op/gpt-5.6-sol", executionOptions: { kind: "provider_default" } }],
      [{ role: "executor", providerId: "openai-compatible", modelId: "executor/model:exact", executionOptions: { kind: "provider_default" } }],
      [{ role: "reviewer", providerId: "review-provider", modelId: "reviewer/model@exact", executionOptions: { kind: "provider_default" } }],
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
    expect(core.createPlan).toHaveBeenCalledWith({ workspaceRoot: "/workspace", prompt: "tiny task", workflowId: "workflow-1", planningProfileId: "default", signal: expect.any(AbortSignal) });
    expect(session.currentPlan).toBe(result.plan);
  });

  it("forwards cheap editor request signals to Core planning", async () => {
    const { session, core } = createSession();
    const result = { plan: { id: "plan-1", objective: "tiny", tasks: [] }, model: { modelId: "m" } };
    core.createPlan.mockResolvedValue(result);
    const requestSignals = { activeFilePath: "src/current.ts", selection: { path: "src/current.ts", lineCount: 3 } };
    await session.generate("fix this", "/workspace", "default", requestSignals);
    expect(core.createPlan).toHaveBeenCalledWith(expect.objectContaining({ requestSignals }));
  });

  it("forwards Abort to an in-flight planning request without waiting for its timeout", async () => {
    const { session, core } = createSession();
    let signal: AbortSignal | undefined;
    core.createPlan.mockImplementation((input) => new Promise((_resolve, reject) => {
      signal = input.signal;
      signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
    }));
    const assertion = expect(session.generate("task", "/workspace", "default")).rejects.toMatchObject({ name: "AbortError" });
    session.abort();
    await assertion;
    expect(core.abortWorkflow).toHaveBeenCalledWith("workflow-1");
    expect(signal?.aborted).toBe(true);
    expect(session.currentPlan).toBeUndefined();
  });

  it("cancels regeneration while preserving the previous plan projection", async () => {
    const { session, core } = createSession();
    const original = { plan: { id: "plan-1", tasks: [] } };
    core.createPlan.mockResolvedValueOnce(original);
    await session.generate("task", "/workspace", "default");
    core.createPlan.mockImplementation((input) => new Promise((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    }));
    const assertion = expect(session.regenerate("revised task", "/workspace", "default")).rejects.toMatchObject({ name: "AbortError" });
    session.abort();
    await assertion;
    expect(session.currentPlan).toBe(original.plan);
  });

  it("does not retain a completed planning controller or poison the next task", async () => {
    const { session, core } = createSession();
    core.createPlan.mockResolvedValue({ plan: { id: "plan-1", tasks: [] } });
    await session.generate("task", "/workspace", "default");
    const completedSignal = core.createPlan.mock.calls[0]![0].signal as AbortSignal;
    session.abort();
    expect(completedSignal.aborted).toBe(false);
    await session.generate("next task", "/workspace", "default");
    const nextSignal = core.createPlan.mock.calls[1]![0].signal as AbortSignal;
    expect(nextSignal).not.toBe(completedSignal);
    expect(nextSignal.aborted).toBe(false);
  });

  it("cleans up after a failed plan and uses a fresh cancellation signal for retry", async () => {
    const { session, core } = createSession();
    core.createPlan.mockRejectedValueOnce(new Error("Provider timed out"));
    await expect(session.generate("task", "/workspace", "default")).rejects.toThrow("Provider timed out");
    const previousSignal = core.createPlan.mock.calls[0]![0].signal as AbortSignal;
    session.abort();
    expect(previousSignal.aborted).toBe(false);
    core.createPlan.mockResolvedValueOnce({ plan: { id: "plan-2", tasks: [] } });
    await session.generate("retry", "/workspace", "default");
    expect(core.createPlan.mock.calls[1]![0].signal).not.toBe(previousSignal);
  });

  it("does not publish a late planner response after Abort", async () => {
    const { session, core } = createSession();
    let complete: (value: unknown) => void = () => undefined;
    core.createPlan.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const assertion = expect(session.generate("task", "/workspace", "default")).rejects.toMatchObject({ name: "AbortError" });
    session.abort();
    complete({ plan: { id: "late-plan", tasks: [] } });
    await assertion;
    expect(session.currentPlan).toBeUndefined();
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

  it("refuses to reset presentation while a workflow is active and never aborts silently", () => {
    const { session, core } = createSession();
    session.workflowId = "workflow-1";
    expect(() => session.resetPresentation()).toThrow("Finish or abort");
    expect(core.abortWorkflow).not.toHaveBeenCalled();
  });

  it("clears only presentation state after a terminal workflow", () => {
    const { session, core } = createSession();
    core.getWorkflowSnapshot.mockReturnValue({ workflowId: "workflow-1", status: "completed", updatedAt: "now", tasks: [] });
    session.workflowId = "workflow-1";
    session.prompt = "task";
    session.plan = { plan: { id: "plan-1" } } as any;
    session.result = { status: "completed" } as any;
    session.validation.set("test", "passed");
    session.reviewStatus = "passed";
    session.repairCycle = 1;
    session.resetPresentation();
    expect(session.workflowId).toBeUndefined();
    expect(session.prompt).toBeUndefined();
    expect(session.currentPlan).toBeUndefined();
    expect(session.validation.size).toBe(0);
    expect(session.reviewStatus).toBeUndefined();
    expect(session.repairCycle).toBeUndefined();
    expect(core.abortWorkflow).not.toHaveBeenCalled();
  });

  it("projects existing review and repair events without implementing workflow semantics", () => {
    const core = fakeCore();
    const listeners = new Map<string, (event: any) => void>();
    core.events.on.mockImplementation((name: string, listener: (event: any) => void) => { listeners.set(name, listener); return () => undefined; });
    const { session } = createSession(core);
    listeners.get("review.validation_passed")?.({ status: "needs_more_context" });
    listeners.get("repair.cycle_started")?.({ cycle: 2 });
    expect(session.reviewStatus).toBe("needs_more_context");
    expect(session.repairCycle).toBe(2);
  });
});
