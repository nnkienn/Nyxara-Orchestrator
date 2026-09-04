import { describe, expect, it } from "vitest";
import type { RoleUsage, WorkflowUsage } from "@nyxara/core";
import {
  MAX_PERFORMANCE_EXECUTOR_TASKS,
  MAX_PERFORMANCE_TOOL_NAMES,
  MAX_PERFORMANCE_VALIDATION_STEPS,
  buildLegacyPerformanceProjection,
  buildPerformanceProjection,
  executionProfileLabel,
  formatPerformanceBytes,
  sanitizePerformanceProjection,
} from "../src/performance-projection.js";

function role(name: RoleUsage["role"], overrides: Partial<RoleUsage> = {}): RoleUsage {
  return {
    role: name,
    providerConfigId: `${name}-config`,
    providerId: `${name}-adapter`,
    requestedModelId: `${name}/requested`,
    resolvedModelId: `${name}-resolved`,
    executionProfileSummary: { kind: "provider_default" },
    calls: 1,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    usageSource: "provider_reported",
    providerDurationMs: 1_000,
    contextFiles: 1,
    contextBytes: 100,
    contextTruncated: false,
    targetedExpansions: 0,
    providerReportedCost: null,
    estimatedCost: null,
    currency: null,
    costSource: "unavailable",
    ...overrides,
  };
}

function fullUsage(overrides: Partial<WorkflowUsage> = {}): WorkflowUsage {
  return {
    workflowId: "workflow-1",
    planner: role("planner", { providerConfigId: "claude-work", providerId: "anthropic", requestedModelId: "claude-sonnet", resolvedModelId: "claude-sonnet", executionProfileSummary: { kind: "provider_default" }, calls: 1, inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, providerDurationMs: 3_000 }),
    executor: role("executor", { providerConfigId: "openai-work", providerId: "openai", requestedModelId: "ha-op/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, calls: 2, inputTokens: 2_900, outputTokens: 810, totalTokens: 3_710, providerDurationMs: 12_100 }),
    reviewer: role("reviewer", { providerConfigId: "gemini-work", providerId: "gemini", requestedModelId: "gemini-2.5-pro", resolvedModelId: "gemini-2.5-pro", executionProfileSummary: { kind: "gemini_thinking_level", value: "high" }, calls: 1, inputTokens: 1_200, outputTokens: 400, totalTokens: 1_600, providerDurationMs: 4_100 }),
    repair: role("repair", { providerConfigId: "openai-work", providerId: "openai", requestedModelId: "ha-op/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, calls: 1, inputTokens: 480, outputTokens: 83, totalTokens: 563, providerDurationMs: 1_400 }),
    tasks: [{ taskId: "task-1", executorCalls: 1, inputTokens: 1_000, outputTokens: 240, totalTokens: 1_240, usageSource: "provider_reported", providerDurationMs: 3_200, toolCalls: 2, toolDurationMs: 410, contextFiles: 4, contextBytes: 2_000, contextTruncated: false, targetedExpansions: 0 }],
    totalProviderCalls: 5,
    totalInputTokens: 5_580,
    totalOutputTokens: 1_493,
    totalTokens: 7_073,
    totalProviderDurationMs: 20_600,
    totalToolCalls: 14,
    modelRequestedToolCalls: 16,
    executedToolCalls: 14,
    successfulToolCalls: 12,
    failedToolCalls: 2,
    invalidToolCalls: 2,
    toolCallsByName: { read_file: 5, search_code: 3, apply_patch: 2, run_command: 4 },
    toolDurationMs: 2_400,
    usageSource: "provider_reported",
    providerReportedCost: 0.034,
    estimatedCost: null,
    currency: "USD",
    costSource: "provider_reported",
    totalDurationMs: 25_000,
    repairCycles: 1,
    repairSummary: { cycles: 1, calls: 1, providerDurationMs: 1_400, totalDurationMs: 2_100, tokens: 563 },
    validation: { status: "passed", durationMs: 6_500, steps: [{ name: "typecheck", status: "passed", durationMs: 800 }, { name: "lint", status: "skipped", durationMs: null }, { name: "tests", status: "passed", durationMs: 4_200 }, { name: "build", status: "passed", durationMs: 1_300 }] },
    review: { status: "passed", calls: 1, providerDurationMs: 4_100, totalDurationMs: 4_500 },
    contextFiles: 18,
    contextBytes: 76_000,
    contextTruncated: false,
    targetedExpansions: 2,
    localOrchestrationDurationMs: 1_500,
    ...overrides,
  };
}

describe("PerformanceProjection", () => {
  it("maps full Core usage once into every bounded public section", () => {
    const value = buildPerformanceProjection({ usage: fullUsage(), terminalStatus: "completed", providers: [{ id: "claude-work", displayName: "Claude Work" }, { id: "openai-work", displayName: "OpenAI Work" }, { id: "gemini-work", displayName: "Gemini Work" }], executorTaskTitles: { "task-1": "Update service" } });
    expect(value.detailLevel).toBe("detailed");
    expect(value.overview).toEqual({ terminalStatus: "completed", inputTokens: 5_580, outputTokens: 1_493, totalTokens: 7_073, workflowDurationMs: 25_000, providerCalls: 5, toolCalls: 14, repairCycles: 1, usageSource: "provider_reported", validationStatus: "passed", reviewStatus: "passed", cost: 0.034, currency: "USD", costSource: "provider_reported" });
    expect(value.roles.map((item) => [item.role, item.totalTokens, item.providerDurationMs])).toEqual([["planner", 1_200, 3_000], ["executor", 3_710, 12_100], ["reviewer", 1_600, 4_100], ["repair", 563, 1_400]]);
    expect(value.roles[1]).toMatchObject({ providerConfigId: "openai-work", providerId: "openai", providerName: "OpenAI Work", requestedModelId: "ha-op/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileLabel: "Reasoning · Medium" });
    expect(value.executorTasks).toEqual([{ taskId: "task-1", title: "Update service", inputTokens: 1_000, outputTokens: 240, totalTokens: 1_240, providerDurationMs: 3_200, providerCalls: 1, toolCalls: 2, toolDurationMs: 410 }]);
    expect(value.latency).toEqual({ workflowDurationMs: 25_000, totalProviderDurationMs: 20_600, providerByRole: { planner: 3_000, executor: 12_100, reviewer: 4_100, repair: 1_400 }, toolDurationMs: 2_400, validationDurationMs: 6_500, reviewDurationMs: 4_500, repairDurationMs: 2_100, localOrchestrationDurationMs: 1_500 });
    expect(value.context).toEqual({ files: 18, bytes: 76_000, truncated: false, targetedExpansions: 2 });
    expect(value.tools).toEqual({ requestedByModel: 16, executed: 14, successful: 12, failed: 2, invalid: 2, durationMs: 2_400, byName: [{ name: "read_file", count: 5 }, { name: "run_command", count: 4 }, { name: "search_code", count: 3 }, { name: "apply_patch", count: 2 }] });
    expect(value.validation.steps).toEqual(fullUsage().validation?.steps);
    expect(value.review).toMatchObject({ status: "passed", durationMs: 4_500, contextExpansions: null, role: { role: "reviewer", totalTokens: 1_600 } });
    expect(value.repair).toMatchObject({ cycles: 1, durationMs: 2_100, providerCalls: 1, inputTokens: 480, outputTokens: 83, totalTokens: 563, providerDurationMs: 1_400, usesExecutorProfile: true, executionProfileLabel: "Reasoning · Medium" });
    expect(value.cost).toEqual({ amount: 0.034, currency: "USD", source: "provider_reported" });
  });

  it("keeps missing values null, preserves authoritative zero, and rejects negative durations", () => {
    const value = buildPerformanceProjection({ usage: { workflowId: "missing", planner: undefined, executor: undefined, reviewer: undefined, repair: undefined, tasks: [], totalProviderCalls: 0, totalInputTokens: null, totalOutputTokens: null, totalTokens: null, totalProviderDurationMs: -1, totalToolCalls: 0, usageSource: "unavailable", providerReportedCost: null, estimatedCost: null, currency: null, costSource: "unavailable", totalDurationMs: -5, repairCycles: 0, toolDurationMs: -2, localOrchestrationDurationMs: -3 } as any });
    expect(value.overview).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, workflowDurationMs: null, providerCalls: 0, toolCalls: 0, repairCycles: 0 });
    expect(value.roles.every((item) => item.calls === null && item.totalTokens === null)).toBe(true);
    expect(value.latency).toMatchObject({ workflowDurationMs: null, totalProviderDurationMs: null, toolDurationMs: null, localOrchestrationDurationMs: null });
    expect(value.cost.amount).toBeNull();
  });

  it("preserves role separation and all native-safe execution summary labels", () => {
    expect(executionProfileLabel({ kind: "provider_default" })).toBe("Provider Default");
    expect(executionProfileLabel({ kind: "openai_reasoning", value: "medium" })).toBe("Reasoning · Medium");
    expect(executionProfileLabel({ kind: "anthropic_thinking", enabled: true, budgetTokens: 8192 })).toBe("Thinking · Enabled · Budget 8,192");
    expect(executionProfileLabel({ kind: "gemini_thinking_budget", budgetTokens: 4096 })).toBe("Thinking Budget · 4,096");
    expect(executionProfileLabel({ kind: "gemini_thinking_level", value: "high" })).toBe("Thinking Level · High");
    expect(buildPerformanceProjection({ usage: fullUsage() }).roles.map((item) => item.role)).toEqual(["planner", "executor", "reviewer", "repair"]);
  });

  it("does not reconstruct executor attribution and bounds Core-owned task, tool, and validation collections", () => {
    const tasks = Array.from({ length: 40 }, (_, index) => ({ ...fullUsage().tasks[0]!, taskId: `task-${index}` }));
    const toolCallsByName = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`tool-${index}`, index]));
    const steps = Array.from({ length: 40 }, (_, index) => ({ name: `step-${index}`, status: "passed", durationMs: index }));
    const value = buildPerformanceProjection({ usage: fullUsage({ tasks, toolCallsByName, validation: { status: "passed", durationMs: 1, steps } }) });
    expect(value.executorTasks).toHaveLength(MAX_PERFORMANCE_EXECUTOR_TASKS);
    expect(value.tools.byName).toHaveLength(MAX_PERFORMANCE_TOOL_NAMES);
    expect(value.validation.steps).toHaveLength(MAX_PERFORMANCE_VALIDATION_STEPS);
    expect(buildPerformanceProjection({ usage: fullUsage({ tasks: [] }) }).executorTasks).toEqual([]);
  });

  it("copies overlapping measured timings without summing them", () => {
    const value = buildPerformanceProjection({ usage: fullUsage({ totalDurationMs: 10, totalProviderDurationMs: 20, toolDurationMs: 30, localOrchestrationDurationMs: null }) });
    expect(value.latency).toMatchObject({ workflowDurationMs: 10, totalProviderDurationMs: 20, toolDurationMs: 30, localOrchestrationDurationMs: null });
  });

  it("formats bytes at presentation boundaries", () => {
    expect(formatPerformanceBytes(null)).toBe("-");
    expect(formatPerformanceBytes(512)).toBe("512 B");
    expect(formatPerformanceBytes(12_700)).toBe("12.4 KB");
    expect(formatPerformanceBytes(1_258_291)).toBe("1.2 MB");
    expect(formatPerformanceBytes(-1)).toBe("-");
  });

  it("retains only provider-reported or already-provenanced Core cost and never infers dollars from tokens", () => {
    expect(buildPerformanceProjection({ usage: fullUsage() }).cost).toEqual({ amount: 0.034, currency: "USD", source: "provider_reported" });
    expect(buildPerformanceProjection({ usage: fullUsage({ totalTokens: 9_999_999, providerReportedCost: null, estimatedCost: null, currency: null, costSource: "unavailable" }) }).cost).toEqual({ amount: null, currency: null, source: "unavailable" });
    expect(buildPerformanceProjection({ usage: fullUsage({ providerReportedCost: null, estimatedCost: 0.02, costSource: "configured_price" }) }).cost.amount).toBe(0.02);
  });

  it("maps old summaries to legacy overview only", () => {
    const value = buildLegacyPerformanceProjection({ totalTokens: 7_073, providerCalls: 3, toolCalls: 1, workflowDurationMs: 20_600, repairCycles: 0 }, "completed");
    expect(value.detailLevel).toBe("legacy");
    expect(value.overview).toMatchObject({ totalTokens: 7_073, workflowDurationMs: 20_600, providerCalls: 3, toolCalls: 1, repairCycles: 0 });
    expect(value.overview.inputTokens).toBeNull();
    expect(value.roles.every((item) => item.calls === null)).toBe(true);
    expect(value.executorTasks).toEqual([]);
  });

  it("revalidates persisted projections and drops raw/private payloads", () => {
    const dirty: any = buildPerformanceProjection({ usage: fullUsage(), providers: [{ id: "openai-work", displayName: "OpenAI Work" }] });
    dirty.apiKey = "sk-secret-value";
    dirty.authorization = "Bearer secret";
    dirty.source = "RAW_SOURCE";
    dirty.diff = "RAW_DIFF";
    dirty.tools.arguments = { path: "/secret" };
    dirty.tools.output = "RAW_TOOL_OUTPUT";
    dirty.validation.stdout = "RAW_STDOUT";
    dirty.review.rawResponse = "RAW_REVIEW";
    dirty.review.hiddenReasoning = "RAW_REASONING";
    dirty.review.thinkingSignature = "RAW_SIGNATURE";
    dirty.roles[0].providerName = "apiKey=sk-provider-secret-value";
    const safe = sanitizePerformanceProjection(dirty);
    const text = JSON.stringify(safe);
    expect(safe?.roles[1]).toMatchObject({ providerConfigId: "openai-work", requestedModelId: "ha-op/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol" });
    for (const forbidden of ["sk-secret-value", "sk-provider-secret-value", "Bearer secret", "RAW_SOURCE", "RAW_DIFF", "/secret", "RAW_TOOL_OUTPUT", "RAW_STDOUT", "RAW_REVIEW", "RAW_REASONING", "RAW_SIGNATURE"]) expect(text).not.toContain(forbidden);
    expect(text).toContain("[redacted]");
  });
});
