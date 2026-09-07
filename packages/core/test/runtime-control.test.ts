import { describe, expect, it, vi } from "vitest";
import { NyxaraOrchestrator, type ExecutionPlan } from "../src/index.js";

function makePlan(): ExecutionPlan {
  return {
    id: "28d64629-e102-4b50-9a7d-23ea14e99891",
    createdAt: "2026-08-31T00:00:00.000Z",
    objective: "runtime control",
    tasks: [
      { id: "T1", title: "one", description: "one", dependencies: [], acceptanceCriteria: ["ok"] },
      { id: "T2", title: "two", description: "two", dependencies: ["T1"], acceptanceCriteria: ["ok"] },
      { id: "T3", title: "three", description: "three", dependencies: ["T2"], acceptanceCriteria: ["ok"] },
    ],
  };
}

function setup() {
  const plan = makePlan();
  const nyxara = new NyxaraOrchestrator();
  const workflow = nyxara.startWorkflow({ workspace: "/workspace", prompt: "runtime control" });
  const core = nyxara as any;
  core.planRuntime.register(plan, workflow.id);
  core.workflowEngine.transition(workflow.id, "planning");
  core.workflowEngine.transition(workflow.id, "awaiting_plan_approval", { planId: plan.id });
  nyxara.approvePlan(workflow.id, plan.id);
  return { nyxara, workflow, plan, core };
}

function result(taskId: string) {
  return {
    status: "passed", taskId,
    execution: { taskId, status: "completed", summary: "ok", changedFiles: [`${taskId}.ts`], toolCalls: 0, modelTurns: 1, diff: { files: [], truncated: false }, git: {} },
    validation: { status: "passed", steps: [], packageManager: null, startedAt: "", completedAt: "", durationMs: 0, taskId },
    executorContext: {}, reviewSkipped: false,
  } as any;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("workflow runtime control", () => {
  it("retains the exact command in the pending permission without executing before approval", async () => {
    const { nyxara, workflow, plan } = setup();
    const command = { command: "python3", args: ["apps/web/scripts/planet-compare.py", "baseline"], cwd: "/workspace" };
    let executed = 0;
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => {
      if (input.taskId === "T1") {
        const decision = await input.resolvePermission!({ capability: "run_command", workspaceRoot: "/workspace", command });
        if (decision !== "allow") throw codedError("command_blocked");
        executed += 1;
      }
      return result(input.taskId);
    });
    const waiting = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    expect(waiting.permission.command).toEqual(command);
    expect(waiting.permission.command?.args).not.toBe(command.args);
    expect(executed).toBe(0);
    expect((await nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" })).status).toBe("completed");
    expect(executed).toBe(1);
  });

  it("retains actionable no-command validation diagnostics without changing failure semantics", async () => {
    const { nyxara, workflow, plan } = setup();
    const pipeline = vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => ({ ...result(input.taskId), status: "failed", validation: { ...result(input.taskId).validation, status: "failed", errorCode: "no_validation_commands" } }));
    const failed = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    expect(failed).toMatchObject({ status: "failed", failure: { code: "no_validation_commands", message: expect.stringContaining("workspace root") }, blockedTaskIds: ["T2", "T3"] });
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(nyxara.getWorkflowSnapshot(workflow.id).error?.code).toBe("no_validation_commands");
  });

  it("forwards existing pipeline options as an isolated snapshot across pause/resume", async () => {
    const { nyxara, workflow, plan } = setup();
    const options = { allowRepair: false, repairLimits: { maxRepairCycles: 2 }, validation: { failFast: false, test: { enabled: false, timeoutMs: 1234 } }, reviewerLimits: { maxReviewerTurns: 1 } };
    const snapshot = structuredClone(options);
    const pipeline = vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => result(input.taskId));
    nyxara.events.on("workflow.task_completed", ({ taskId }) => { if (taskId === "T1") nyxara.pauseWorkflow(workflow.id); });
    expect((await nyxara.runApprovedPlan({ ...options, workflowId: workflow.id, planId: plan.id })).status).toBe("paused");
    options.repairLimits.maxRepairCycles = 5;
    options.validation.test.enabled = true;
    options.reviewerLimits.maxReviewerTurns = 4;
    expect((await nyxara.resumeWorkflow(workflow.id)).status).toBe("completed");
    expect(pipeline).toHaveBeenCalledTimes(3);
    for (const [input] of pipeline.mock.calls) expect(input).toMatchObject(snapshot);
  });
  it("pauses between tasks and resumes without rerunning completed work", async () => {
    const { nyxara, workflow, plan } = setup();
    const calls: string[] = [];
    const pauseEvents: string[] = [];
    nyxara.events.on("workflow.pause_requested", () => pauseEvents.push("requested"));
    nyxara.events.on("workflow.paused", () => pauseEvents.push("paused"));
    nyxara.events.on("workflow.resumed", () => pauseEvents.push("resumed"));
    nyxara.events.on("workflow.task_completed", ({ taskId }) => { if (taskId === "T1") nyxara.pauseWorkflow(workflow.id); });
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => { calls.push(input.taskId); return result(input.taskId); });

    const paused = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    expect(paused.status).toBe("paused");
    expect(calls).toEqual(["T1"]);
    expect(nyxara.getWorkflowSnapshot(workflow.id)).toMatchObject({ status: "paused", progress: { completed: 1, total: 3 } });

    const completed = await nyxara.resumeWorkflow(workflow.id);
    expect(completed.status).toBe("completed");
    expect(calls).toEqual(["T1", "T2", "T3"]);
    expect(pauseEvents).toEqual(["requested", "paused", "resumed"]);
  });

  it("waits for an in-flight bounded task before pausing", async () => {
    const { nyxara, workflow, plan } = setup();
    let release!: () => void;
    const boundary = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => { calls.push(input.taskId); if (input.taskId === "T1") await boundary; return result(input.taskId); });
    const running = nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    await vi.waitFor(() => expect(calls).toEqual(["T1"]));
    const requested = nyxara.pauseWorkflow(workflow.id);
    expect(requested.pauseRequested).toBe(true);
    expect(requested.status).not.toBe("paused");
    release();
    expect((await running).status).toBe("paused");
    expect(calls).toEqual(["T1"]);
    nyxara.abortWorkflow(workflow.id);
  });

  it("rejects a plan changed while paused before starting another task", async () => {
    const { nyxara, workflow, plan } = setup();
    const calls: string[] = [];
    nyxara.events.on("workflow.task_completed", ({ taskId }) => { if (taskId === "T1") nyxara.pauseWorkflow(workflow.id); });
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => { calls.push(input.taskId); return result(input.taskId); });
    expect((await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id })).status).toBe("paused");
    (plan.tasks[1] as { title: string }).title = "mutated";
    await expect(nyxara.resumeWorkflow(workflow.id)).rejects.toMatchObject({ code: "plan_changed_after_approval" });
    expect(calls).toEqual(["T1"]);
    nyxara.abortWorkflow(workflow.id);
  });

  it("allows the exact pending operation once and continues the same scheduler", async () => {
    const { nyxara, workflow, plan, core } = setup();
    const taskCalls: string[] = [];
    let operationCalls = 0;
    const advance = vi.spyOn(core, "advanceApprovedWorkflow");
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => {
      taskCalls.push(input.taskId);
      if (input.taskId === "T2") {
        const decision = await input.resolvePermission!({ capability: "modify_workspace_file", workspaceRoot: "/workspace", resource: ".env", write: { bytes: 10, large: false, sensitivity: "environment" } });
        if (decision !== "allow") throw codedError("write_permission_denied");
        operationCalls += 1;
      }
      return result(input.taskId);
    });
    const waiting = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    expect(waiting.status).toBe("waiting_for_permission");
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    expect(operationCalls).toBe(0);
    expect(waiting.snapshot.pendingPermission).toEqual(waiting.permission);
    const completed = await nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" });
    expect(completed.status).toBe("completed");
    expect(taskCalls).toEqual(["T1", "T2", "T3"]);
    expect(operationCalls).toBe(1);
    expect(advance).toHaveBeenCalledTimes(2);
    await expect(nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" })).rejects.toMatchObject({ code: "invalid_workflow_transition" });
  });

  it("rejects a wrong request ID and keeps the workflow waiting", async () => {
    const { nyxara, workflow, plan } = setup();
    let operationCalls = 0;
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => {
      const decision = await input.resolvePermission!({ capability: "run_command", workspaceRoot: "/workspace" });
      if (decision === "allow") operationCalls += 1;
      else throw codedError("command_blocked");
      return result(input.taskId);
    });
    const waiting = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    await expect(nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: "stale", decision: "allow" })).rejects.toMatchObject({ code: "invalid_workflow_transition" });
    expect(nyxara.getWorkflowSnapshot(workflow.id).status).toBe("waiting_for_permission");
    expect(operationCalls).toBe(0);
    nyxara.abortWorkflow(workflow.id);
  });

  it("denies without executing and fails before the next task", async () => {
    const { nyxara, workflow, plan } = setup();
    const calls: string[] = [];
    let operationCalls = 0;
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => {
      calls.push(input.taskId);
      if (input.taskId === "T1") {
        const decision = await input.resolvePermission!({ capability: "modify_workspace_file", workspaceRoot: "/workspace", resource: ".env" });
        if (decision === "allow") operationCalls += 1;
        else throw codedError("write_permission_denied");
      }
      return result(input.taskId);
    });
    const waiting = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    const failed = await nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: waiting.permission.id, decision: "deny" });
    expect(failed.status).toBe("failed");
    expect(calls).toEqual(["T1"]);
    expect(operationCalls).toBe(0);
  });

  it("aborts paused and waiting workflows and invalidates continuation", async () => {
    const pausedSetup = setup();
    pausedSetup.nyxara.events.on("workflow.task_completed", () => pausedSetup.nyxara.pauseWorkflow(pausedSetup.workflow.id));
    vi.spyOn(pausedSetup.nyxara, "runTaskPipeline").mockImplementation(async (input) => result(input.taskId));
    expect((await pausedSetup.nyxara.runApprovedPlan({ workflowId: pausedSetup.workflow.id, planId: pausedSetup.plan.id })).status).toBe("paused");
    expect(pausedSetup.nyxara.abortWorkflow(pausedSetup.workflow.id).status).toBe("aborted");
    await expect(pausedSetup.nyxara.resumeWorkflow(pausedSetup.workflow.id)).rejects.toMatchObject({ code: "invalid_workflow_transition" });

    const waitingSetup = setup();
    vi.spyOn(waitingSetup.nyxara, "runTaskPipeline").mockImplementation(async (input) => { await input.resolvePermission!({ capability: "run_command", workspaceRoot: "/workspace" }); throw codedError("command_blocked"); });
    const waiting = await waitingSetup.nyxara.runApprovedPlan({ workflowId: waitingSetup.workflow.id, planId: waitingSetup.plan.id });
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    expect(waitingSetup.nyxara.abortWorkflow(waitingSetup.workflow.id).status).toBe("aborted");
    expect(waitingSetup.nyxara.getWorkflowSnapshot(waitingSetup.workflow.id).pendingPermission).toBeUndefined();
    await expect(waitingSetup.nyxara.resolveWorkflowPermission({ workflowId: waitingSetup.workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" })).rejects.toMatchObject({ code: "invalid_workflow_transition" });
  });

  it("emits isolated metadata-only permission events in order", async () => {
    const { nyxara, workflow, plan } = setup();
    const events: Array<{ name: string; payload: unknown }> = [];
    nyxara.events.on("workflow.permission_requested", () => { throw new Error("isolated UI"); });
    for (const name of ["workflow.permission_requested", "workflow.permission_allowed"] as const) nyxara.events.on(name, (payload) => events.push({ name, payload }));
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => { if (input.taskId === "T1") { const decision = await input.resolvePermission!({ capability: "modify_workspace_file", workspaceRoot: "/workspace", resource: ".env" }); if (decision !== "allow") throw codedError("denied"); } return result(input.taskId); });
    const waiting = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    await nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" });
    expect(events.map((event) => event.name)).toEqual(["workflow.permission_requested", "workflow.permission_allowed"]);
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
    expect(events[0]!.payload).not.toHaveProperty("arguments");
  });

  it("rejects resume for a completed workflow", async () => {
    const { nyxara, workflow, plan } = setup();
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input) => result(input.taskId));
    expect((await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id })).status).toBe("completed");
    await expect(nyxara.resumeWorkflow(workflow.id)).rejects.toMatchObject({ code: "invalid_workflow_transition" });
  });
});
