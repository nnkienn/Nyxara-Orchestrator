import type { GenerateRequest, ModelProvider } from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  NyxaraOrchestrator,
  PlanRuntimeStore,
  planFingerprint,
  type ExecutionPlan,
} from "../src/index.js";

const draft = {
  objective: "Add pagination",
  tasks: [{
    id: "T1",
    title: "Implement pagination",
    description: "Add bounded pagination.",
    dependencies: [],
    acceptanceCriteria: ["Pagination is covered"],
    relevantFiles: ["src/index.ts"],
  }],
};

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: "18d64629-e102-4b50-9a7d-23ea14e99891",
    createdAt: "2026-08-31T00:00:00.000Z",
    ...draft,
    ...overrides,
  };
}

function provider(generate = vi.fn(async (request: GenerateRequest) => ({
  provider: "fake", model: request.model, text: JSON.stringify(draft),
}))): ModelProvider {
  return {
    id: "fake", displayName: "Fake",
    capabilities: () => ({ modelDiscovery: true, textGeneration: true, structuredOutput: true }),
    listModels: async () => [{ id: "model", name: "Model", provider: "fake" }],
    generate,
  };
}

async function planned() {
  const generate = vi.fn(async (request: GenerateRequest) => ({
    provider: "fake", model: request.model, text: JSON.stringify(draft),
  }));
  const nyxara = new NyxaraOrchestrator({
    providers: [provider(generate)],
    agents: [{ role: "planner", providerId: "fake", modelId: "model" }],
  });
  const workflow = nyxara.startWorkflow({ workspace: process.cwd(), prompt: draft.objective });
  const result = await nyxara.createPlan({
    workflowId: workflow.id,
    workspaceRoot: process.cwd(),
    prompt: draft.objective,
    contextBudget: { maxFiles: 1, maxBytes: 1024, maxBytesPerFile: 1024 },
  });
  return { nyxara, workflow, result, generate };
}

describe("Phase 8A plan approval", () => {
  it("moves a new plan to draft/awaiting, approves without AI, and snapshots compact metadata", async () => {
    const { nyxara, workflow, result, generate } = await planned();
    const awaiting = vi.fn();
    const approvedEvent = vi.fn();
    nyxara.events.on("plan.awaiting_approval", awaiting);
    nyxara.events.on("plan.approved", approvedEvent);

    expect(nyxara.getPlanRuntimeState(result.plan.id).status).toBe("draft");
    expect(nyxara.getWorkflowState(workflow.id).status).toBe("awaiting_plan_approval");
    expect(nyxara.getWorkflowSnapshot(workflow.id).plan).toMatchObject({
      planId: result.plan.id, status: "draft", taskCount: 1,
    });
    const calls = generate.mock.calls.length;
    const approved = nyxara.approvePlan(workflow.id, result.plan.id);
    expect(generate).toHaveBeenCalledTimes(calls);
    expect(approved).toMatchObject({ status: "approved", approval: { approvedBy: "user", taskCount: 1 } });
    expect(nyxara.getWorkflowState(workflow.id).status).toBe("approved");
    expect(nyxara.getWorkflowSnapshot(workflow.id).plan).toMatchObject({ status: "approved", taskCount: 1 });
    expect(approvedEvent).toHaveBeenCalledWith(expect.not.objectContaining({ objective: expect.anything(), tasks: expect.anything() }));
    expect(() => nyxara.approvePlan(workflow.id, result.plan.id)).toThrow(expect.objectContaining({ code: "plan_already_approved" }));
  });

  it("rejects a draft into a terminal, non-executable workflow", async () => {
    const { nyxara, workflow, result } = await planned();
    const rejectedEvent = vi.fn();
    nyxara.events.on("plan.rejected", rejectedEvent);
    expect(nyxara.rejectPlan(workflow.id, result.plan.id).status).toBe("rejected");
    expect(nyxara.getWorkflowState(workflow.id)).toMatchObject({ status: "failed", error: { code: "plan_rejected" } });
    expect(nyxara.getWorkflowSnapshot(workflow.id).plan?.status).toBe("rejected");
    expect(() => nyxara.assertPlanExecutable(result.plan)).toThrow(expect.objectContaining({ code: "plan_rejected" }));
    expect(() => nyxara.approvePlan(workflow.id, result.plan.id)).toThrow(expect.objectContaining({ code: "plan_rejected" }));
    expect(rejectedEvent).toHaveBeenCalledWith(expect.not.objectContaining({ objective: expect.anything(), tasks: expect.anything() }));
  });

  it("replaces only drafts and makes the old draft non-executable", async () => {
    const { nyxara, workflow, result } = await planned();
    const replacement = plan({ id: "82075d5f-7e64-4ac7-8b22-7ed59b63c8de" });
    expect(nyxara.replaceDraftPlan(workflow.id, replacement).status).toBe("draft");
    expect(nyxara.getPlanRuntimeState(result.plan.id).status).toBe("rejected");
    expect(nyxara.getWorkflowState(workflow.id).planId).toBe(replacement.id);
    nyxara.approvePlan(workflow.id, replacement.id);
    expect(() => nyxara.replaceDraftPlan(workflow.id, plan())).toThrow(expect.objectContaining({ code: "invalid_plan_state" }));
  });
});

describe("plan fingerprint and execution guard", () => {
  it("hashes only stable execution-relevant content", () => {
    expect(planFingerprint(plan())).toBe(planFingerprint(plan({ createdAt: "2027-01-01T00:00:00.000Z" })));
  });

  it.each([
    ["objective", plan({ objective: "Changed" })],
    ["description", plan({ tasks: [{ ...draft.tasks[0], description: "Changed" }] })],
    ["dependency", plan({ tasks: [{ ...draft.tasks[0], dependencies: ["T2"] }, { ...draft.tasks[0], id: "T2" }] })],
    ["acceptance", plan({ tasks: [{ ...draft.tasks[0], acceptanceCriteria: ["Changed"] }] })],
  ])("detects changed %s", (_name, changed) => {
    const store = new PlanRuntimeStore();
    store.register(plan(), "workflow");
    store.approve(plan().id, "2026-08-31T01:00:00.000Z");
    expect(() => store.assertIntegrity(plan().id, changed)).toThrow(expect.objectContaining({ code: "plan_changed_after_approval" }));
  });

  it("blocks draft/rejected and permits an unchanged approved plan", () => {
    const store = new PlanRuntimeStore();
    store.register(plan(), "workflow");
    expect(() => store.assertExecutable(plan())).toThrow(expect.objectContaining({ code: "plan_not_awaiting_approval" }));
    store.approve(plan().id, "2026-08-31T01:00:00.000Z");
    expect(() => store.assertExecutable(plan())).not.toThrow();
  });
});
