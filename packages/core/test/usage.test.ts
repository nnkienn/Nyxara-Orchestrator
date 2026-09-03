import { describe, expect, it } from "vitest";
import { aggregateWorkflowUsage, normalizeUsage } from "@nyxara/shared";

describe("workflow usage accounting", () => {
  it("normalizes provider formats and leaves missing usage unavailable", () => {
    expect(normalizeUsage({ prompt_tokens: 3, completion_tokens: 2 })).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5, usageSource: "provider_reported" });
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, usageSource: "unavailable" });
    expect(normalizeUsage({ inputTokens: 4, outputTokens: 1, usageSource: "estimated" }).usageSource).toBe("estimated");
  });

  it("aggregates roles, tasks, models and safe derived metrics", () => {
    const usage = aggregateWorkflowUsage("wf", [
      { role: "planner", providerId: "p1", requestedModelId: "route/model", resolvedModelId: "model", inputTokens: 10, outputTokens: 5, totalTokens: 15, providerDurationMs: 20 },
      { role: "executor", taskId: "T1", providerId: "p2", requestedModelId: "other", resolvedModelId: "resolved", inputTokens: 20, outputTokens: 10, totalTokens: 30, providerDurationMs: 30, toolCalls: 2, contextBytes: 1024 },
      { role: "reviewer", taskId: "T1", providerId: "p1", requestedModelId: "route/model", resolvedModelId: "model", inputTokens: 5, outputTokens: 5, totalTokens: 10, providerDurationMs: 10 },
    ], { contextBytes: 1024, totalDurationMs: 100, toolDurationMs: 10, validationDurationMs: 10 });
    expect(usage.totalTokens).toBe(55);
    expect(usage.executor.totalTokens).toBe(30);
    expect(usage.tasks[0]).toMatchObject({ taskId: "T1", totalTokens: 30, toolCalls: 2 });
    expect(usage.byProviderModel).toHaveLength(3);
    expect(usage.byProviderModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "planner", providerId: "p1" }),
      expect.objectContaining({ role: "reviewer", providerId: "p1" }),
    ]));
    expect(usage.localOrchestrationDurationMs).toBe(20);
    expect(usage.planner).toMatchObject({ requestedModelId: "route/model", resolvedModelId: "model" });
    expect(usage.planner.costSource).toBe("unavailable");
    expect(JSON.stringify(usage)).not.toMatch(/prompt|source code|api.?key/i);
  });

  it("never reports a negative local duration", () => {
    const usage = aggregateWorkflowUsage("wf", [{ role: "planner", providerDurationMs: 50 }], { totalDurationMs: 10, toolDurationMs: 10, validationDurationMs: 10 });
    expect(usage.localOrchestrationDurationMs).toBe(0);
  });

  it("preserves provider cost without estimating unavailable cost", () => {
    const reported = aggregateWorkflowUsage("wf", [{ role: "planner", providerReportedCost: 0.25, currency: "USD" }]);
    expect(reported.planner).toMatchObject({ providerReportedCost: 0.25, currency: "USD", costSource: "provider_reported" });
    const missing = aggregateWorkflowUsage("wf", [{ role: "planner" }]);
    expect(missing.planner).toMatchObject({ providerReportedCost: null, currency: null, costSource: "unavailable" });
  });

  it("attributes multiple executor and repair calls without losing unavailable fields", () => {
    const usage = aggregateWorkflowUsage("wf", [
      { role: "executor", taskId: "T1", providerId: "p", requestedModelId: "route/a", resolvedModelId: "a", inputTokens: 10, outputTokens: 2, providerDurationMs: 5, contextBytes: 100, toolCalls: 1 },
      { role: "executor", taskId: "T1", providerId: "p", requestedModelId: "route/a", resolvedModelId: "a", inputTokens: 5, outputTokens: 1, providerDurationMs: 4, contextBytes: 100, toolCalls: 2 },
      { role: "executor", taskId: "T2", providerId: "p", requestedModelId: "route/b", resolvedModelId: "b", providerDurationMs: 3 },
      { role: "repair", taskId: "T2", providerId: "p", requestedModelId: "route/b", resolvedModelId: "b", inputTokens: 3, outputTokens: 1, providerDurationMs: 2 },
    ], { repairCycles: 1, repairDurationMs: 8, validation: { status: "passed", durationMs: 2, steps: [{ name: "test", status: "passed", durationMs: 2 }] } });
    expect(usage.executor).toMatchObject({ calls: 3, requestedModelId: null, totalTokens: null });
    expect(usage.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "T1", executorCalls: 2, totalTokens: 18, toolCalls: 3, contextBytes: 200 }),
      expect.objectContaining({ taskId: "T2", totalTokens: null }),
    ]));
    expect(usage.repairSummary).toMatchObject({ cycles: 1, calls: 1, tokens: 4, totalDurationMs: 8 });
    expect(usage.validation?.steps[0]).toEqual({ name: "test", status: "passed", durationMs: 2 });
  });
});
