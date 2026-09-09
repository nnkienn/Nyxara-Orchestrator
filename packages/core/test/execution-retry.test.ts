import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProviderError, type GenerateRequest, type ModelProvider } from "@nyxara/provider-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxaraOrchestrator, type ValidationResult } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("manual recovery of an approved Executor attempt", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-retry-"));
    await writeFile(join(workspace, "state.ts"), "export const partial = false;\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(workspace, { recursive: true, force: true }); });

  async function setup(options: { partialWrite?: boolean; validationFails?: boolean; reviewFails?: boolean; failedTask?: string } = {}) {
    let failures = 1;
    const failedTask = options.failedTask ?? "T2";
    const generate = vi.fn(async (request: GenerateRequest) => {
      const reply = (text: object) => ({ provider: "fake", model: request.model, text: JSON.stringify(text) });
      if (request.prompt.includes("You are the Planner role")) return reply({ objective: "Check three tasks", tasks: ["T1", "T2", "T3"].map((id, index) => ({ id, title: `Check ${id}`, description: `Inspect state for ${id}`, dependencies: index ? [`T${index}`] : [], acceptanceCriteria: ["checked"], relevantFiles: ["state.ts"] })) });
      if (request.prompt.includes("You are the Reviewer role")) {
        if (options.reviewFails) throw new ProviderError("review unavailable", { code: "timeout_error", providerId: "fake" });
        return reply({ status: "passed", summary: "checked", findings: [], criteria: [{ criterion: "checked", status: "satisfied", reason: "checked" }] });
      }
      if (request.prompt.includes(`Task ID: ${failedTask}`) && failures > 0 && !options.validationFails && !options.reviewFails) {
        if (options.partialWrite && !request.conversation) return { provider: "fake", model: request.model, text: "", toolCalls: [{ id: "partial-write", name: "write_file", arguments: { path: "state.ts", content: "export const partial = true;\n" } }] };
        failures -= 1;
        throw new ProviderError("Provider request failed with status 502", { code: "provider_error", providerId: "fake", statusCode: 502 });
      }
      return reply({ status: "completed", summary: "checked" });
    });
    const provider: ModelProvider = {
      id: "fake", displayName: "Fake", capabilities: () => ({ modelDiscovery: true, textGeneration: true, toolCalling: true }),
      listModels: async () => ["first", "second"].map((id) => ({ id, name: id, provider: "fake" })), generate,
    };
    const core = new NyxaraOrchestrator({ providers: [provider], agents: ["planner", "executor", "reviewer"].map((role) => ({ role: role as "planner" | "executor" | "reviewer", providerId: "fake", modelId: "first" })) });
    const validate = vi.spyOn(core, "validate").mockImplementation(async () => ({ status: options.validationFails ? "failed" : "passed", startedAt: "", completedAt: "", durationMs: 1, packageManager: null, steps: [] } as unknown as ValidationResult));
    const pipeline = vi.spyOn(core, "runTaskPipeline");
    const workflow = core.startWorkflow({ workspace, prompt: "Check all three tasks in this repository" });
    const planned = await core.createPlan({ workflowId: workflow.id, workspaceRoot: workspace, prompt: workflow.prompt });
    const plan = planned.plan;
    const retry = { workflowId: workflow.id, planId: plan.id, taskId: failedTask };
    const approve = vi.spyOn(core, "approvePlan");
    core.approvePlan(workflow.id, plan.id);
    const settings = { validation: { failFast: false }, repairLimits: { maxRepairCycles: 1 }, reviewerLimits: { maxReviewerTurns: 1 }, allowRepair: false };
    const failure = await core.runApprovedPlan({ ...retry, ...settings });
    return { core, provider, generate, workflow, plan, retry, failure, approve, validate, pipeline, settings };
  }

  it("retains the approved plan and completed tasks, uses the corrected model, and validates/reviews on retry", async () => {
    const run = await setup();
    expect(run.failure).toMatchObject({ status: "failed", completedTaskIds: ["T1"], failedTaskIds: ["T2"] });
    const original = structuredClone(run.plan);
    const approval = run.core.getPlanRuntimeState(run.plan.id);
    expect(run.core.getWorkflowSnapshot(run.workflow.id).executionRetry).toEqual({ planId: run.plan.id, taskId: "T2", attempt: 2 });
    run.core.configureAgent({ role: "executor", providerId: "fake", modelId: "second" });
    run.settings.validation.failFast = true;
    expect(await run.core.retryWorkflowExecution(run.retry)).toMatchObject({ status: "completed", completedTaskIds: ["T1", "T2", "T3"], failedTaskIds: [] });
    expect(run.plan).toEqual(original);
    expect(run.core.getPlanRuntimeState(run.plan.id)).toEqual(approval);
    expect(run.approve).toHaveBeenCalledTimes(1);
    expect(run.generate.mock.calls.filter(([request]) => request.prompt.includes("You are the Planner role"))).toHaveLength(1);
    expect(run.pipeline.mock.calls.map(([input]) => input.taskId)).toEqual(["T1", "T2", "T2", "T3"]);
    expect(run.pipeline.mock.calls[2]![0]).toMatchObject({ validation: { failFast: false }, repairLimits: { maxRepairCycles: 1 }, reviewerLimits: { maxReviewerTurns: 1 } });
    expect(run.pipeline.mock.calls[2]![0].plannerContext).toBeUndefined();
    expect(run.generate.mock.calls.filter(([request]) => request.prompt.includes("You are the Executor role")).map(([request]) => request.model)).toEqual(["first", "first", "second", "second"]);
    expect(run.validate).toHaveBeenCalledTimes(3);
    expect(run.core.getTaskExecutionStates(run.plan).map((task) => task.attempts)).toEqual([1, 2, 1]);
    const snapshot = run.core.getWorkflowSnapshot(run.workflow.id);
    expect(snapshot).toMatchObject({ status: "completed", progress: { completed: 3, total: 3 } });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.failedTaskId).toBeUndefined();
    expect(snapshot.executionRetry).toBeUndefined();
  });

  it("restores the exact failed task and approved plan in a fresh Core runtime", async () => {
    const run = await setup();
    const snapshot = run.core.getWorkflowSnapshot(run.workflow.id);
    const approval = run.core.getPlanRuntimeState(run.plan.id);
    expect(run.core.getWorkflowState(run.workflow.id).failedTaskId).toBe("T2");
    const fresh = new NyxaraOrchestrator({
      providers: [run.provider],
      agents: ["planner", "executor", "reviewer"].map((role) => ({ role: role as "planner" | "executor" | "reviewer", providerId: "fake", modelId: "second" })),
    });
    vi.spyOn(fresh, "validate").mockResolvedValue({ status: "passed", startedAt: "", completedAt: "", durationMs: 1, packageManager: null, steps: [] } as unknown as ValidationResult);
    fresh.restoreApprovedExecution({
      workflow: run.core.getWorkflowState(run.workflow.id),
      tasks: snapshot.tasks,
      plan: run.plan,
      approvedAt: approval.approvedAt!,
      approvedPlanFingerprint: approval.approval!.planFingerprint,
      taskExecutionStates: run.core.getTaskExecutionStates(run.plan),
      pipelineConfig: run.settings,
      allowRepair: false,
      result: run.failure as any,
    });
    expect(fresh.getWorkflowSnapshot(run.workflow.id).executionRetry).toEqual({ planId: run.plan.id, taskId: "T2", attempt: 2 });
    await expect(fresh.retryWorkflowExecution(run.retry)).resolves.toMatchObject({ status: "completed", completedTaskIds: ["T1", "T2", "T3"] });
  });

  it("keeps partial writes and refreshes failed-task context instead of replaying stale Planner content", async () => {
    const run = await setup({ partialWrite: true });
    expect(await readFile(join(workspace, "state.ts"), "utf8")).toContain("partial = true");
    const outcome = await run.core.retryWorkflowExecution(run.retry);
    expect(outcome).toMatchObject({ status: "completed", changedFiles: ["state.ts"], usage: { executedToolCalls: 1, successfulToolCalls: 1, toolCallsByName: { write_file: 1 } } });
    const requests = run.generate.mock.calls.map(([request]) => request).filter((request) => request.prompt.includes("Task ID: T2"));
    expect(requests.at(-1)!.prompt).toContain("partial = true");
    expect(requests.at(-1)!.conversation).toBeUndefined();
    expect(requests.at(-1)!.prompt).not.toContain("Prior conversation");
    expect(Buffer.byteLength(JSON.stringify(requests.at(-1)), "utf8")).toBeLessThanOrEqual(192 * 1024);
    const retriedTask = run.core.getTaskExecutionStates(run.plan).find((task) => task.taskId === "T2");
    expect(retriedTask?.resultSummary?.contextMetrics).toMatchObject({ providerCalls: 1 });
    expect(retriedTask?.resultSummary?.contextMetrics?.totalEstimatedInputTokens).toBeLessThanOrEqual(256 * 1024);
    expect(run.pipeline.mock.calls.map(([input]) => input.taskId)).toEqual(["T1", "T2", "T2", "T3"]);
  });

  it("rejects stale IDs and a changed approved plan without a new provider call", async () => {
    const run = await setup();
    const calls = run.generate.mock.calls.length;
    await expect(run.core.retryWorkflowExecution({ ...run.retry, taskId: "T3" })).rejects.toMatchObject({ code: "invalid_workflow_transition" });
    await expect(run.core.retryWorkflowExecution({ ...run.retry, planId: "stale" })).rejects.toMatchObject({ code: "plan_workflow_mismatch" });
    await expect(run.core.retryWorkflowExecution({ ...run.retry, workflowId: "stale" })).rejects.toMatchObject({ code: "workflow_not_found" });
    (run.plan.tasks[1] as { description: string }).description = "unauthorized change";
    await expect(run.core.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "plan_changed_after_approval" });
    expect(run.generate).toHaveBeenCalledTimes(calls);
    expect(run.core.getWorkflowSnapshot(run.workflow.id).executionRetry).toBeUndefined();
  });

  it("coalesces neither user approvals nor duplicate retries: only one concurrent retry starts", async () => {
    const run = await setup();
    const outcomes = await Promise.allSettled([run.core.retryWorkflowExecution(run.retry), run.core.retryWorkflowExecution(run.retry)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(run.pipeline.mock.calls.map(([input]) => input.taskId)).toEqual(["T1", "T2", "T2", "T3"]);
    await expect(run.core.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "invalid_workflow_transition" });
  });

  it.each([{ validationFails: true }, { reviewFails: true }])("does not rerun successfully executed work after a later-stage failure: %o", async (options) => {
    const run = await setup(options);
    expect(run.failure.status).toBe("failed");
    expect(run.core.getWorkflowSnapshot(run.workflow.id).executionRetry).toBeUndefined();
    await expect(run.core.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "invalid_workflow_transition" });
    expect(run.pipeline).toHaveBeenCalledTimes(1);
  });

  it("does not recover evicted state or reconstruct execution from a summary", async () => {
    const run = await setup();
    (run.core as any).taskExecutions.plans.clear();
    expect(run.core.getWorkflowSnapshot(run.workflow.id).executionRetry).toBeUndefined();
    await expect(run.core.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "invalid_workflow_transition" });
    const fresh = new NyxaraOrchestrator();
    await expect(fresh.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "workflow_not_found" });
  });

  it("still waits for permission and supports pause/resume after an explicit retry", async () => {
    const run = await setup();
    run.generate.mockImplementationOnce(async (request) => ({ provider: "fake", model: request.model, text: "", toolCalls: [{ id: "sensitive", name: "write_file", arguments: { path: ".env", content: "RETRY_FIXTURE=1\n" } }] }));
    const waiting = await run.core.retryWorkflowExecution(run.retry);
    expect(waiting.status).toBe("waiting_for_permission");
    await expect(readFile(join(workspace, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(run.core.getWorkflowSnapshot(run.workflow.id).executionRetry).toBeUndefined();
    if (waiting.status !== "waiting_for_permission") throw new Error("Expected a permission gate");
    const stopPausing = run.core.events.on("workflow.task_completed", (event) => { if (event.taskId === "T2") run.core.pauseWorkflow(run.workflow.id); });
    expect((await run.core.resolveWorkflowPermission({ workflowId: run.workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" })).status).toBe("paused");
    stopPausing();
    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("RETRY_FIXTURE=1\n");
    expect((await run.core.resumeWorkflow(run.workflow.id)).status).toBe("completed");
    expect(run.pipeline.mock.calls.map(([input]) => input.taskId)).toEqual(["T1", "T2", "T2", "T3"]);
  });

  it("rejects retry while active and never resurrects an aborted attempt", async () => {
    const run = await setup();
    run.generate.mockImplementationOnce(async (request) => ({ provider: "fake", model: request.model, text: "", toolCalls: [{ id: "sensitive", name: "write_file", arguments: { path: ".env", content: "RETRY_FIXTURE=1\n" } }] }));
    expect((await run.core.retryWorkflowExecution(run.retry)).status).toBe("waiting_for_permission");
    await expect(run.core.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "invalid_workflow_transition" });
    run.core.abortWorkflow(run.workflow.id);
    await (run.core as any).workflowRuntimes.get(run.workflow.id).advancing;
    expect(run.core.getWorkflowSnapshot(run.workflow.id).executionRetry).toBeUndefined();
    await expect(run.core.retryWorkflowExecution(run.retry)).rejects.toMatchObject({ code: "invalid_workflow_transition" });
    await expect(readFile(join(workspace, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
