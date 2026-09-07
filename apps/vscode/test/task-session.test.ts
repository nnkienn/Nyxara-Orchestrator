import { describe, expect, it } from "vitest";
import { buildPerformanceProjection } from "../src/performance-projection.js";
import { MAX_HISTORY_CRITERIA, MAX_HISTORY_DEPENDENCIES, MAX_HISTORY_RISKS, MAX_HISTORY_TASKS, MAX_HISTORY_VALIDATION_STEPS, createTaskSession, projectTaskSession, safeWorkspaceIdentity, sanitizeTaskSession, taskSessionStatus } from "../src/task-session.js";
import type { WorkspaceViewState } from "../src/workspace-state.js";

const workspace = safeWorkspaceIdentity("Project", "/private/home/project");
const base = createTaskSession({ id: "session", now: "2026-09-03T00:00:00.000Z", requirement: "Add pagination", workspaceIdentity: workspace, providerSummary: { provider: "Gateway", model: "route/model" } });
const state = (overrides: Partial<WorkspaceViewState> = {}): WorkspaceViewState => ({ version: "test", configured: true, workspace: { available: true, multiple: false }, providerLabel: "Gateway", advancedRouting: false, providers: [], history: { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "current" }, validation: [], repairCycles: null, ...overrides });
const performance = buildPerformanceProjection({ usage: { workflowId: "w", planner: { role: "planner", providerConfigId: "removed-provider", providerId: "openai", requestedModelId: "route/gpt", resolvedModelId: "gpt", executionProfileSummary: { kind: "provider_default" }, calls: 1, inputTokens: 8, outputTokens: 2, totalTokens: 10, usageSource: "provider_reported", providerDurationMs: 50 }, executor: { role: "executor", calls: 0 }, reviewer: { role: "reviewer", calls: 0 }, repair: { role: "repair", calls: 0 }, tasks: [], totalProviderCalls: 1, totalInputTokens: 8, totalOutputTokens: 2, totalTokens: 10, totalProviderDurationMs: 50, totalToolCalls: 0, usageSource: "provider_reported", providerReportedCost: null, estimatedCost: null, currency: null, costSource: "unavailable", totalDurationMs: 80, repairCycles: 0 } as any, providers: [{ id: "removed-provider", displayName: "OpenAI Work" }], terminalStatus: "completed" });

describe("TaskSession projection", () => {
  it("preserves every grouped criterion through history save and reload", () => {
    const criteria = Array.from({ length: 8 }, (_, index) => `Original check ${index + 1}`);
    const grouped = [`${criteria[0]}\n${criteria[1]}`, `${criteria[2]}\n${criteria[3]}`, ...criteria.slice(4)];
    const projected = projectTaskSession(base, state({
      plan: { id: "p", objective: "Objective", tasks: [{ id: "T7", title: "Verify", description: "Check metrics", dependencies: [], acceptanceCriteria: grouped }], risks: [] },
      workflow: { id: "w", status: "awaiting_plan_approval", stage: "Awaiting Approval", active: true, approvalStatus: "draft", tasks: [] },
    }));
    const restored = sanitizeTaskSession(JSON.parse(JSON.stringify(projected)));
    expect(restored?.planSummary?.approvalStatus).toBe("draft");
    expect(restored?.planSummary?.tasks[0]?.acceptanceCriteria.flatMap(criterion => criterion.split("\n"))).toEqual(criteria);
  });
  it.each([
    ["planning", "planning"], ["awaiting_plan_approval", "awaiting_approval"], ["executing", "executing"], ["validating", "validating"], ["reviewing", "reviewing"], ["repairing", "repairing"], ["waiting_for_permission", "waiting_for_permission"], ["paused", "paused"], ["completed", "completed"], ["failed", "failed"], ["aborted", "aborted"],
  ])("maps authoritative Core %s to history %s", (core, expected) => expect(taskSessionStatus(core)).toBe(expected));

  it("projects bounded plan, execution, validation, review, repair, and exact authoritative usage", () => {
    const projected = projectTaskSession(base, state({
      plan: { id: "p", objective: "Objective", tasks: [{ id: "one", title: "Task", description: "not persisted", acceptanceCriteria: ["Pass"], dependencies: [], risk: "low" }], risks: [] },
      workflow: { id: "w", status: "completed", stage: "Completed", active: false, approvalStatus: "approved", progress: { completed: 1, total: 1 }, currentTaskId: "one", tasks: [{ id: "one", title: "Task", status: "completed" }] },
      validation: [{ kind: "typecheck", status: "passed", durationMs: 12.25 }], reviewStatus: "passed", reviewFindingCount: 2, repairCycles: 1,
      repairUsage: { durationMs: 40.5, tokens: 6 }, usage: { tokens: 7073, modelCalls: 4, toolCalls: 9, durationMs: 20600.5, repairCycles: 1 },
      performance,
      completion: { status: "completed", changedFiles: 2, tokens: 7073, modelCalls: 4, durationMs: 20600.5, repairCycles: 1 },
    }), "2026-09-03T00:01:00.000Z");
    expect(projected.status).toBe("completed");
    expect(projected.planSummary?.approvalStatus).toBe("approved");
    expect(projected.executionSummary).toMatchObject({ completed: 1, total: 1, currentTaskTitle: "Task" });
    expect(projected.validationSummary).toEqual({ status: "passed", steps: [{ name: "typecheck", status: "passed", durationMs: 12.25 }] });
    expect(projected.reviewSummary).toEqual({ status: "passed", findingCount: 2, ruleViolationCount: null });
    expect(projected.repairSummary).toEqual({ cycles: 1, outcome: "completed", durationMs: 40.5, tokens: 6 });
    expect(projected.usageSummary).toEqual({ inputTokens: 8, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 10, providerCalls: 1, toolCalls: 0, workflowDurationMs: 80, repairCycles: 0 });
    expect(projected.performanceSummary?.roles[0]).toMatchObject({ providerConfigId: "removed-provider", providerName: "OpenAI Work", requestedModelId: "route/gpt", resolvedModelId: "gpt" });
    expect(JSON.stringify(projected)).not.toContain("not persisted");
  });

  it("uses authoritative failed Validation even when all steps were skipped", () => {
    const projected = projectTaskSession(base, state({
      workflow: { id: "w", status: "failed", stage: "Failed", active: false, tasks: [], occurredStages: ["validation"] },
      validation: [{ kind: "typecheck", status: "skipped", durationMs: 0 }],
      performance: { ...performance, validation: { status: "failed", durationMs: 77, steps: [] } },
    }));
    expect(projected.validationSummary?.status).toBe("failed");
  });

  it("never turns skipped-only Validation into a pass without authoritative evidence", () => {
    expect(projectTaskSession(base, state({ validation: [{ kind: "typecheck", status: "skipped" }] })).validationSummary?.status).toBe("unavailable");
  });

  it("corrects legacy skipped-only pass summaries from persisted authoritative failure on reload", () => {
    const saved = { ...base, status: "failed", validationSummary: { status: "passed", steps: [{ name: "typecheck", status: "skipped", durationMs: 0 }] }, performanceSummary: { ...performance, validation: { status: "failed", durationMs: 77, steps: [] } } };
    expect(sanitizeTaskSession(JSON.parse(JSON.stringify(saved)))?.validationSummary?.status).toBe("failed");
    expect(saved.validationSummary.status).toBe("passed");
    expect(sanitizeTaskSession({ ...saved, performanceSummary: undefined })?.validationSummary?.status).toBe("unavailable");
  });

  it("keeps unavailable authoritative usage null and does not independently calculate it", () => {
    const projected = projectTaskSession(base, state({ workflow: { id: "w", status: "completed", stage: "Completed", active: false, tasks: [] }, completion: { status: "completed", changedFiles: null, tokens: null, modelCalls: null, durationMs: null, repairCycles: null } }));
    expect(projected.usageSummary).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, providerCalls: null, toolCalls: null, workflowDurationMs: null, repairCycles: null });
  });

  it("records a rejected task without stages that never ran", () => {
    const projected = projectTaskSession(base, state({
      plan: { id: "p", objective: "Objective", tasks: [{ id: "one", title: "Task", description: "detail", acceptanceCriteria: ["Pass"], dependencies: [] }], risks: [] },
      workflow: { id: "w", status: "failed", stage: "Plan Rejected", active: false, approvalStatus: "rejected", outcome: "rejected", occurredStages: ["planning", "approval"], tasks: [] },
      completion: { status: "rejected", outcome: "rejected", changedFiles: 0, tokens: 120, modelCalls: 1, durationMs: 900, repairCycles: null, tokenParts: [] },
    }), "2026-09-03T00:01:00.000Z");
    expect(projected.status).toBe("rejected");
    expect(projected.planSummary?.approvalStatus).toBe("rejected");
    expect(projected.occurredStages).toEqual(["planning", "approval"]);
    // Nothing executed, so no stage summaries and no failure message are stored.
    expect(projected.executionSummary).toBeUndefined();
    expect(projected.validationSummary).toBeUndefined();
    expect(projected.reviewSummary).toBeUndefined();
    expect(projected.repairSummary).toBeUndefined();
    expect(projected.failureSummary).toBeUndefined();
  });

  it("maps a legacy rejection record to the Rejected outcome", () => {
    const legacy = sanitizeTaskSession({
      ...base,
      status: "failed",
      planSummary: { objective: "Objective", approvalStatus: "rejected", tasks: [], risks: [] },
      failureSummary: { stage: "Failed", message: "Plan rejected by user" },
    });
    expect(legacy?.status).toBe("rejected");
    expect(legacy?.failureSummary).toBeUndefined();
  });

  it("maps a legacy reason field to Rejected and removes fixed-template stages that never occurred", () => {
    const legacy = sanitizeTaskSession({
      ...base,
      status: "failed",
      reason: "Plan rejected by user",
      planSummary: { objective: "Objective", approvalStatus: "rejected", tasks: [], risks: [] },
      executionSummary: { completed: 0, total: 0, tasks: [] },
      validationSummary: { status: "pending", steps: [] },
      reviewSummary: { status: "pending", findingCount: null, ruleViolationCount: null },
      repairSummary: { cycles: 0, outcome: null, durationMs: null, tokens: null },
      occurredStages: ["planning", "approval"],
    });
    expect(legacy?.status).toBe("rejected");
    expect(legacy?.executionSummary).toBeUndefined();
    expect(legacy?.validationSummary).toBeUndefined();
    expect(legacy?.reviewSummary).toBeUndefined();
    expect(legacy?.repairSummary).toBeUndefined();
  });

  it("keeps a genuine failure classified as failed", () => {
    const failed = sanitizeTaskSession({
      ...base,
      status: "failed",
      planSummary: { objective: "Objective", approvalStatus: "approved", tasks: [], risks: [] },
      executionSummary: { completed: 0, total: 1, tasks: [] },
      failureSummary: { stage: "Validating", message: "Validation failed" },
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.failureSummary).toEqual({ stage: "Validating", message: "Validation failed" });
  });

  it("maps a rejected completion status to the rejected history outcome", () => {
    expect(taskSessionStatus("failed", "rejected")).toBe("rejected");
    expect(taskSessionStatus("failed", "failed")).toBe("failed");
  });

  it("sanitizes provider/model HTML and rejects invalid task records", () => {
    const sanitized = sanitizeTaskSession({ ...base, providerSummary: { provider: "<provider>", model: "<model>" } });
    expect(sanitized?.providerSummary).toEqual({ provider: "<provider>", model: "<model>" });
    expect(sanitizeTaskSession({ ...base, id: "" })).toBeUndefined();
    expect(sanitizeTaskSession({ ...base, schemaVersion: 2 })).toBeUndefined();
  });

  it("redacts credentials even when they appear inside otherwise allowed persisted text", () => {
    const secret = "sk-fake-secret-123456789";
    const sanitized = sanitizeTaskSession({
      ...base,
      title: `Fix api_key=${secret}`,
      requirement: `Use Authorization: Bearer ${secret} without exposing it`,
      providerSummary: { provider: `Gateway access_token=${secret}`, model: "route/model" },
      planSummary: { objective: `Never print ${secret}`, approvalStatus: "draft", tasks: [], risks: [] },
    });
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(JSON.stringify(sanitized)).toContain("[redacted]");
  });

  it("allowlists detailed performance and drops raw provider, tool, source, diff, output, and reasoning fields", () => {
    const dirty: any = structuredClone(performance);
    dirty.apiKey = "sk-private-value"; dirty.headers = { Authorization: "Bearer private" }; dirty.source = "RAW_SOURCE"; dirty.diff = "RAW_DIFF";
    dirty.tools.arguments = "RAW_ARGS"; dirty.tools.results = "RAW_RESULTS"; dirty.validation.stdout = "RAW_STDOUT"; dirty.validation.stderr = "RAW_STDERR";
    dirty.review.providerResponse = "RAW_RESPONSE"; dirty.review.hiddenReasoning = "RAW_REASONING"; dirty.review.thinkingSignature = "RAW_SIGNATURE";
    const sanitized = sanitizeTaskSession({ ...base, performanceSummary: dirty });
    const text = JSON.stringify(sanitized);
    expect(sanitized?.performanceSummary?.overview.totalTokens).toBe(10);
    for (const forbidden of ["sk-private-value", "Bearer private", "RAW_SOURCE", "RAW_DIFF", "RAW_ARGS", "RAW_RESULTS", "RAW_STDOUT", "RAW_STDERR", "RAW_RESPONSE", "RAW_REASONING", "RAW_SIGNATURE"]) expect(text).not.toContain(forbidden);
  });

  it("bounds nested plan, dependency, risk, execution, and validation arrays", () => {
    const repeated = Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, acceptanceCriteria: Array(100).fill("Pass"), dependencies: Array(100).fill("task-0") }));
    const sanitized = sanitizeTaskSession({
      ...base,
      planSummary: { objective: "Bounded", approvalStatus: "draft", tasks: repeated, risks: Array.from({ length: 100 }, () => ({ description: "Risk", severity: "low" })) },
      executionSummary: { completed: 0, total: 100, tasks: repeated.map((task) => ({ title: task.title, status: "pending" })) },
      validationSummary: { status: "pending", steps: Array.from({ length: 100 }, (_, index) => ({ name: `step-${index}`, status: "pending", durationMs: null })) },
    });
    expect(sanitized?.planSummary?.tasks).toHaveLength(MAX_HISTORY_TASKS);
    expect(sanitized?.planSummary?.tasks[0]?.acceptanceCriteria).toHaveLength(MAX_HISTORY_CRITERIA);
    expect(sanitized?.planSummary?.tasks[0]?.dependencies).toHaveLength(MAX_HISTORY_DEPENDENCIES);
    expect(sanitized?.planSummary?.risks).toHaveLength(MAX_HISTORY_RISKS);
    expect(sanitized?.executionSummary?.tasks).toHaveLength(MAX_HISTORY_TASKS);
    expect(sanitized?.validationSummary?.steps).toHaveLength(MAX_HISTORY_VALIDATION_STEPS);
  });
});
