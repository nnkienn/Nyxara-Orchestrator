import { describe, expect, it } from "vitest";
import { buildWorkspaceState } from "../src/workspace-state.js";

const provider = { id: "gateway", type: "openai-compatible", displayName: "Gateway", modelId: "route/model", baseUrl: "https://example.invalid/v1", authStrategy: "api_key" } as const;
const roles = ["planner", "executor", "reviewer"].map((role) => ({ role, providerId: provider.id, providerName: provider.displayName, modelId: provider.modelId }));

function build(overrides: Record<string, unknown> = {}) {
  return buildWorkspaceState({ version: "0.1.0-alpha.7", configured: true, folders: 1, providers: [provider], defaultProviderId: provider.id, roles, validation: new Map(), ...overrides } as any);
}

const plan = {
  id: "plan-1",
  createdAt: "2026-09-03T00:00:00.000Z",
  objective: "Add pagination",
  summary: "Keep the API compatible",
  tasks: [{ id: "task-1", title: "Update query", description: "Add bounded paging", dependencies: [], acceptanceCriteria: ["Tests pass"], risk: "low" }],
  risks: [{ description: "Offset drift", severity: "low", mitigation: "Stable ordering" }],
};

describe("workspace Webview state projection", () => {
  it("projects provider/model and detects advanced routing", () => {
    expect(build().providerLabel).toBe("Gateway · route/model");
    const advanced = build({ roles: [{ role: "planner", providerId: "gateway", modelId: "a" }, { role: "executor", providerId: "gateway", modelId: "b" }, { role: "reviewer", providerId: "gateway", modelId: "a" }] });
    expect(advanced.advancedRouting).toBe(true);
    expect(advanced.providerLabel).toBe("Advanced routing");
  });

  it("projects the structured plan without raw planner envelopes", () => {
    const state = build({ prompt: "Add pagination", plan, snapshot: { workflowId: "w", status: "awaiting_plan_approval", updatedAt: "now", tasks: [] } });
    expect(state.plan).toMatchObject({ objective: "Add pagination", tasks: [{ title: "Update query", acceptanceCriteria: ["Tests pass"], risk: "low" }], risks: [{ severity: "low" }] });
    expect(JSON.stringify(state)).not.toContain("providerResponse");
  });

  it.each([
    ["created", "Analyzing"], ["planning", "Planning"], ["awaiting_plan_approval", "Awaiting approval"], ["executing", "Executing"], ["validating", "Validating"], ["reviewing", "Reviewing"], ["repairing", "Repairing"], ["waiting_for_permission", "Waiting for permission"], ["paused", "Paused"], ["completed", "Completed"], ["failed", "Failed"], ["aborted", "Aborted"],
  ])("maps Core state %s to %s", (status, stage) => {
    const state = build({ plan, snapshot: { workflowId: "w", status, updatedAt: "now", tasks: [] } });
    expect(state.workflow?.stage).toBe(stage);
  });

  it("projects task progress and only bounded permission metadata", () => {
    const state = build({ plan, snapshot: { workflowId: "w", status: "waiting_for_permission", updatedAt: "now", currentTaskId: "task-1", progress: { completed: 0, total: 1 }, tasks: [{ taskId: "task-1", executionStatus: "running" }], pendingPermission: { id: "permission/exact", workflowId: "w", planId: "plan-1", taskId: "task-1", capability: "write", resource: "src/a.ts", reason: "Apply the approved change", requestedAt: "now" } } });
    expect(state.workflow).toMatchObject({ progress: { completed: 0, total: 1 }, currentTaskId: "task-1", tasks: [{ title: "Update query", status: "running" }], permission: { id: "permission/exact", action: "write · src/a.ts", reason: "Apply the approved change" } });
  });

  it("projects validation, review, repair, and authoritative Core usage", () => {
    const usage = { totalTokens: 7073, totalProviderCalls: 4, totalDurationMs: 20620, repairCycles: 1, usageSource: "provider_reported", validation: { status: "passed", durationMs: 3, steps: [{ name: "typecheck", status: "passed", durationMs: 1 }, { name: "lint", status: "skipped", durationMs: 0 }] }, review: { status: "needs_more_context", calls: 2, providerDurationMs: 4, totalDurationMs: 5 } };
    const state = build({ plan, snapshot: { workflowId: "w", status: "completed", updatedAt: "now", tasks: [], usage }, result: { workflowId: "w", planId: "plan-1", status: "completed", changedFiles: ["a.ts", "b.ts"], durationMs: 20620, repairCycles: 1, usage } });
    expect(state.validation).toEqual([{ kind: "typecheck", status: "passed", durationMs: 1 }, { kind: "lint", status: "skipped", durationMs: 0 }]);
    expect(state.reviewStatus).toBe("needs_more_context");
    expect(state.completion).toEqual({ status: "completed", changedFiles: 2, tokens: 7073, modelCalls: 4, durationMs: 20620, repairCycles: 1 });
  });

  it("preserves unavailable usage as null instead of recalculating it", () => {
    const state = build({ snapshot: { workflowId: "w", status: "completed", updatedAt: "now", tasks: [], usage: { totalTokens: null, totalProviderCalls: 0, totalDurationMs: null, repairCycles: 0, usageSource: "unavailable" } } });
    expect(state.completion).toMatchObject({ tokens: null, modelCalls: 0, durationMs: null, repairCycles: 0 });
  });

  it("never projects credentials or unknown raw payload fields", () => {
    const secret = "sk-fake-never-render";
    const state = build({ providers: [{ ...provider, apiKey: secret }], snapshot: { workflowId: "w", status: "failed", updatedAt: "now", tasks: [], rawProviderResponse: secret, error: { code: "provider_error", message: "Provider unavailable" } } });
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(state.workflow?.error?.message).toBe("Provider unavailable");
  });

  it("bounds every model-controlled plan and error field", () => {
    const huge = "x".repeat(5_000);
    const state = build({ prompt: huge, plan: { ...plan, objective: huge, tasks: [{ ...plan.tasks[0], title: huge, description: huge, acceptanceCriteria: [huge] }] }, snapshot: { workflowId: "w", status: "failed", updatedAt: "now", tasks: [], error: { code: "failed", message: huge } } });
    expect(state.prompt).toHaveLength(5_000);
    expect(state.plan?.objective).toHaveLength(2_000);
    expect(state.plan?.tasks[0]?.title).toHaveLength(300);
    expect(state.plan?.tasks[0]?.acceptanceCriteria[0]).toHaveLength(500);
    expect(state.workflow?.error?.message).toHaveLength(240);
  });
});
