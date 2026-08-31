import { describe, expect, it, vi } from "vitest";
import { NyxaraOrchestrator, type ExecutionPlan } from "../src/index.js";

const plan: ExecutionPlan = {
  id: "18d64629-e102-4b50-9a7d-23ea14e99891",
  createdAt: "2026-08-31T00:00:00.000Z",
  objective: "objective",
  tasks: [
    { id: "T1", title: "one", description: "one", dependencies: [], acceptanceCriteria: ["ok"] },
    { id: "T2", title: "two", description: "two", dependencies: ["T1"], acceptanceCriteria: ["ok"] },
    { id: "T3", title: "three", description: "three", dependencies: ["T1"], acceptanceCriteria: ["ok"] },
    { id: "T4", title: "four", description: "four", dependencies: ["T2", "T3"], acceptanceCriteria: ["ok"] },
  ],
};

function setup() {
  const nyxara = new NyxaraOrchestrator();
  const workflow = nyxara.startWorkflow({ workspace: "/workspace", prompt: "objective" });
  const core = nyxara as any;
  core.planRuntime.register(plan, workflow.id);
  core.workflowEngine.transition(workflow.id, "planning");
  core.workflowEngine.transition(workflow.id, "awaiting_plan_approval", { planId: plan.id });
  nyxara.approvePlan(workflow.id, plan.id);
  return { nyxara, workflow };
}

const pipelineResult = (taskId: string, status: "passed" | "failed" = "passed") => ({
  status, taskId,
  execution: { taskId, status: "completed", summary: "ok", changedFiles: [`${taskId}.ts`], toolCalls: 0, modelTurns: 0, diff: { files: [], truncated: false }, git: {} as any },
  validation: { status: "passed", steps: [], packageManager: null, startedAt: "", completedAt: "", durationMs: 0, taskId },
  executorContext: {} as any, reviewSkipped: false,
});

describe("autonomous approved-plan scheduler", () => {
  it("runs a diamond in stable plan order and aggregates the result", async () => {
    const { nyxara, workflow } = setup();
    const order: string[] = [];
    nyxara.events.on("workflow.task_selected", () => { throw new Error("isolated listener"); });
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input: any) => { order.push(input.taskId); return pipelineResult(input.taskId) as any; });
    const result = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    expect(order).toEqual(["T1", "T2", "T3", "T4"]);
    expect(result.status).toBe("completed");
    expect(result.completedTaskIds).toEqual(order);
    expect(result.changedFiles).toEqual(["T1.ts", "T2.ts", "T3.ts", "T4.ts"]);
    expect(nyxara.getWorkflowSnapshot(workflow.id).progress).toEqual({ completed: 4, total: 4 });
  });

  it("stops on failure, blocks transitive dependents, and does not run siblings", async () => {
    const { nyxara, workflow } = setup();
    const order: string[] = [];
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input: any) => { order.push(input.taskId); return pipelineResult(input.taskId, input.taskId === "T2" ? "failed" : "passed") as any; });
    const result = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id });
    expect(order).toEqual(["T1", "T2"]);
    expect(result.status).toBe("failed");
    expect(result.failedTaskIds).toEqual(["T2"]);
    expect(result.blockedTaskIds).toEqual(["T4"]);
    expect(nyxara.getWorkflowSnapshot(workflow.id).status).toBe("failed");
  });

  it("rejects unapproved plans before any task pipeline call", async () => {
    const nyxara = new NyxaraOrchestrator();
    const workflow = nyxara.startWorkflow({ workspace: "/workspace", prompt: "objective" });
    const core = nyxara as any;
    core.planRuntime.register(plan, workflow.id);
    core.workflowEngine.transition(workflow.id, "planning");
    core.workflowEngine.transition(workflow.id, "awaiting_plan_approval", { planId: plan.id });
    const run = vi.spyOn(nyxara, "runTaskPipeline");
    await expect(nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id })).rejects.toMatchObject({ code: "plan_not_awaiting_approval" });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a passed task complete when aborted before the next task", async () => {
    const { nyxara, workflow } = setup();
    const controller = new AbortController();
    const order: string[] = [];
    vi.spyOn(nyxara, "runTaskPipeline").mockImplementation(async (input: any) => {
      order.push(input.taskId);
      controller.abort();
      return pipelineResult(input.taskId) as any;
    });
    const result = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: plan.id, signal: controller.signal });
    expect(order).toEqual(["T1"]);
    expect(result.status).toBe("aborted");
    expect(result.completedTaskIds).toEqual(["T1"]);
    expect(nyxara.getWorkflowSnapshot(workflow.id).status).toBe("aborted");
  });
});
