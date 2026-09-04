import type { ExecutionProfileSummary } from "@nyxara/provider-sdk";
import type { WorkflowUsage } from "@nyxara/core";

export const MAX_PERFORMANCE_EXECUTOR_TASKS = 32;
export const MAX_PERFORMANCE_TOOL_NAMES = 32;
export const MAX_PERFORMANCE_VALIDATION_STEPS = 32;

export type PerformanceRole = "planner" | "executor" | "reviewer" | "repair";
export type PerformanceTerminalStatus = "completed" | "failed" | "aborted" | "interrupted";

export interface PerformanceRoleProjection {
  readonly role: PerformanceRole;
  readonly providerConfigId: string | null;
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly requestedModelId: string | null;
  readonly resolvedModelId: string | null;
  readonly executionProfileSummary: ExecutionProfileSummary | null;
  readonly executionProfileLabel: string | null;
  readonly calls: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly providerDurationMs: number | null;
  readonly usageSource: string | null;
}

export interface TaskPerformanceProjection {
  /** Legacy projections contain only the old bounded task-summary totals. */
  readonly detailLevel: "detailed" | "legacy";
  readonly overview: {
    readonly terminalStatus: PerformanceTerminalStatus | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
    readonly workflowDurationMs: number | null;
    readonly providerCalls: number | null;
    readonly toolCalls: number | null;
    readonly repairCycles: number | null;
    readonly usageSource: string | null;
    readonly validationStatus: string | null;
    readonly reviewStatus: string | null;
    readonly cost: number | null;
    readonly currency: string | null;
    readonly costSource: string | null;
  };
  readonly roles: readonly PerformanceRoleProjection[];
  readonly executorTasks: readonly {
    readonly taskId: string;
    readonly title: string | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
    readonly providerDurationMs: number | null;
    readonly providerCalls: number | null;
    readonly toolCalls: number | null;
    readonly toolDurationMs: number | null;
  }[];
  readonly latency: {
    readonly workflowDurationMs: number | null;
    readonly totalProviderDurationMs: number | null;
    readonly providerByRole: Readonly<Record<PerformanceRole, number | null>>;
    readonly toolDurationMs: number | null;
    readonly validationDurationMs: number | null;
    readonly reviewDurationMs: number | null;
    readonly repairDurationMs: number | null;
    readonly localOrchestrationDurationMs: number | null;
  };
  readonly context: {
    readonly files: number | null;
    readonly bytes: number | null;
    readonly truncated: boolean | null;
    readonly targetedExpansions: number | null;
  };
  readonly tools: {
    readonly requestedByModel: number | null;
    readonly executed: number | null;
    readonly successful: number | null;
    readonly failed: number | null;
    readonly invalid: number | null;
    readonly durationMs: number | null;
    readonly byName: readonly { readonly name: string; readonly count: number }[];
  };
  readonly validation: {
    readonly status: string | null;
    readonly durationMs: number | null;
    readonly steps: readonly { readonly name: string; readonly status: string; readonly durationMs: number | null }[];
  };
  readonly review: {
    readonly status: string | null;
    readonly durationMs: number | null;
    readonly contextExpansions: number | null;
    readonly role: PerformanceRoleProjection;
  };
  readonly repair: {
    readonly cycles: number | null;
    readonly durationMs: number | null;
    readonly providerCalls: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
    readonly providerDurationMs: number | null;
    readonly usesExecutorProfile: true;
    readonly executionProfileSummary: ExecutionProfileSummary | null;
    readonly executionProfileLabel: string | null;
  };
  readonly cost: {
    readonly amount: number | null;
    readonly currency: string | null;
    readonly source: string | null;
  };
}

export interface BuildPerformanceProjectionInput {
  readonly usage: WorkflowUsage;
  readonly terminalStatus?: PerformanceTerminalStatus;
  readonly providers?: readonly { readonly id: string; readonly displayName: string }[];
  readonly executorTaskTitles?: Readonly<Record<string, string>>;
}

export interface LegacyPerformanceSummary {
  readonly totalTokens: number | null;
  readonly providerCalls: number | null;
  readonly toolCalls: number | null;
  readonly workflowDurationMs: number | null;
  readonly repairCycles: number | null;
}

type ExtendedTaskUsage = WorkflowUsage["tasks"][number] & { readonly modelRequestedToolCalls?: number };

/**
 * Builds the bounded UI/history view of Core-owned usage. This function only
 * validates, labels and bounds authoritative fields; it never totals metrics.
 */
export function buildPerformanceProjection(input: BuildPerformanceProjectionInput): TaskPerformanceProjection {
  const usage = input.usage as WorkflowUsage & Record<string, any>;
  const providerNames = new Map((input.providers ?? []).map((provider) => [bounded(provider.id, 200), bounded(provider.displayName, 100)]));
  const roles = (["planner", "executor", "reviewer", "repair"] as const).map((name) => roleProjection(name, usage[name], providerNames));
  const byRole = Object.fromEntries(roles.map((role) => [role.role, role.providerDurationMs])) as Record<PerformanceRole, number | null>;
  const validationStatus = text(usage.validation?.status, 80);
  const reviewStatus = text(usage.review?.status, 80);
  const cost = projectedCost(usage);
  const tasks = (usage.tasks ?? []).slice(0, MAX_PERFORMANCE_EXECUTOR_TASKS).map((taskValue: WorkflowUsage["tasks"][number]) => {
    const task = taskValue as ExtendedTaskUsage;
    const taskId = bounded(task.taskId, 200);
    const title = input.executorTaskTitles ? text(input.executorTaskTitles[task.taskId], 300) : null;
    return {
      taskId,
      title,
      inputTokens: metric(task.inputTokens), outputTokens: metric(task.outputTokens), totalTokens: metric(task.totalTokens),
      providerDurationMs: metric(task.providerDurationMs), providerCalls: metric(task.executorCalls), toolCalls: metric(task.toolCalls),
      toolDurationMs: metric(task.toolDurationMs),
    };
  }).filter((task) => task.taskId);
  const validationSteps = (usage.validation?.steps ?? []).slice(0, MAX_PERFORMANCE_VALIDATION_STEPS).flatMap((step) => {
    const name = text(step.name, 120); const status = text(step.status, 40);
    return name && status ? [{ name, status, durationMs: metric(step.durationMs) }] : [];
  });
  const byName = Object.entries(usage.toolCallsByName ?? {})
    .flatMap(([name, value]) => text(name, 120) && metric(value) !== null ? [{ name: text(name, 120)!, count: metric(value)! }] : [])
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, MAX_PERFORMANCE_TOOL_NAMES);
  const repair = roles[3]!;
  const reviewer = roles[2]!;
  return {
    detailLevel: "detailed",
    overview: {
      terminalStatus: input.terminalStatus ?? null,
      inputTokens: metric(usage.totalInputTokens), outputTokens: metric(usage.totalOutputTokens), totalTokens: metric(usage.totalTokens),
      workflowDurationMs: metric(usage.totalDurationMs), providerCalls: metric(usage.totalProviderCalls), toolCalls: metric(usage.totalToolCalls),
      repairCycles: metric(usage.repairCycles), usageSource: text(usage.usageSource, 40), validationStatus, reviewStatus,
      cost: cost.amount, currency: cost.currency, costSource: cost.source,
    },
    roles,
    executorTasks: tasks,
    latency: {
      workflowDurationMs: metric(usage.totalDurationMs), totalProviderDurationMs: metric(usage.totalProviderDurationMs), providerByRole: byRole,
      toolDurationMs: metric(usage.toolDurationMs), validationDurationMs: metric(usage.validation?.durationMs), reviewDurationMs: metric(usage.review?.totalDurationMs),
      repairDurationMs: metric(usage.repairSummary?.totalDurationMs), localOrchestrationDurationMs: metric(usage.localOrchestrationDurationMs),
    },
    context: {
      files: metric(usage.contextFiles), bytes: metric(usage.contextBytes),
      truncated: typeof usage.contextTruncated === "boolean" ? usage.contextTruncated : null,
      targetedExpansions: metric(usage.targetedExpansions),
    },
    tools: {
      requestedByModel: metric(usage.modelRequestedToolCalls), executed: metric(usage.executedToolCalls),
      successful: metric(usage.successfulToolCalls), failed: metric(usage.failedToolCalls), invalid: metric(usage.invalidToolCalls),
      durationMs: metric(usage.toolDurationMs), byName,
    },
    validation: { status: validationStatus, durationMs: metric(usage.validation?.durationMs), steps: validationSteps },
    // Core exposes total targeted expansions, but does not currently publish a
    // separate reviewer-only aggregate. Keep that narrower metric unavailable.
    review: { status: reviewStatus, durationMs: metric(usage.review?.totalDurationMs), contextExpansions: null, role: reviewer },
    repair: {
      cycles: metric(usage.repairSummary?.cycles ?? usage.repairCycles), durationMs: metric(usage.repairSummary?.totalDurationMs),
      providerCalls: repair.calls, inputTokens: repair.inputTokens, outputTokens: repair.outputTokens, totalTokens: repair.totalTokens,
      providerDurationMs: repair.providerDurationMs, usesExecutorProfile: true,
      executionProfileSummary: repair.executionProfileSummary, executionProfileLabel: repair.executionProfileLabel,
    },
    cost,
  };
}

/** Maps the alpha.7-alpha.9 bounded summary without inventing missing detail. */
export function buildLegacyPerformanceProjection(summary: LegacyPerformanceSummary, terminalStatus?: PerformanceTerminalStatus): TaskPerformanceProjection {
  const roles = (["planner", "executor", "reviewer", "repair"] as const).map(emptyRoleProjection);
  const overview = {
    terminalStatus: terminalStatus ?? null,
    inputTokens: null, outputTokens: null, totalTokens: metric(summary.totalTokens), workflowDurationMs: metric(summary.workflowDurationMs),
    providerCalls: metric(summary.providerCalls), toolCalls: metric(summary.toolCalls), repairCycles: metric(summary.repairCycles),
    usageSource: null, validationStatus: null, reviewStatus: null, cost: null, currency: null, costSource: null,
  };
  return {
    detailLevel: "legacy", overview, roles, executorTasks: [],
    latency: { workflowDurationMs: overview.workflowDurationMs, totalProviderDurationMs: null, providerByRole: { planner: null, executor: null, reviewer: null, repair: null }, toolDurationMs: null, validationDurationMs: null, reviewDurationMs: null, repairDurationMs: null, localOrchestrationDurationMs: null },
    context: { files: null, bytes: null, truncated: null, targetedExpansions: null },
    tools: { requestedByModel: null, executed: null, successful: null, failed: null, invalid: null, durationMs: null, byName: [] },
    validation: { status: null, durationMs: null, steps: [] },
    review: { status: null, durationMs: null, contextExpansions: null, role: roles[2]! },
    repair: { cycles: overview.repairCycles, durationMs: null, providerCalls: null, inputTokens: null, outputTokens: null, totalTokens: null, providerDurationMs: null, usesExecutorProfile: true, executionProfileSummary: null, executionProfileLabel: null },
    cost: { amount: null, currency: null, source: null },
  };
}

function roleProjection(role: PerformanceRole, source: WorkflowUsage[PerformanceRole] | undefined, providerNames: ReadonlyMap<string, string>): PerformanceRoleProjection {
  const value = (source ?? {}) as WorkflowUsage[PerformanceRole];
  const providerConfigId = text(value.providerConfigId, 200);
  const summary = sanitizeExecutionProfileSummary(value.executionProfileSummary);
  return {
    role, providerConfigId, providerId: text(value.providerId, 120), providerName: providerConfigId ? providerNames.get(providerConfigId) ?? null : null,
    requestedModelId: text(value.requestedModelId, 300), resolvedModelId: text(value.resolvedModelId, 300),
    executionProfileSummary: summary, executionProfileLabel: summary ? executionProfileLabel(summary) : null,
    calls: metric(value.calls), inputTokens: metric(value.inputTokens), outputTokens: metric(value.outputTokens), totalTokens: metric(value.totalTokens),
    providerDurationMs: metric(value.providerDurationMs), usageSource: text(value.usageSource, 40),
  };
}

function emptyRoleProjection(role: PerformanceRole): PerformanceRoleProjection {
  return { role, providerConfigId: null, providerId: null, providerName: null, requestedModelId: null, resolvedModelId: null, executionProfileSummary: null, executionProfileLabel: null, calls: null, inputTokens: null, outputTokens: null, totalTokens: null, providerDurationMs: null, usageSource: null };
}

function projectedCost(usage: WorkflowUsage): TaskPerformanceProjection["cost"] {
  const source = text(usage.costSource, 40);
  const amount = source === "provider_reported" ? metric(usage.providerReportedCost) : source === "configured_price" ? metric(usage.estimatedCost) : null;
  return { amount, currency: amount === null ? null : text(usage.currency, 12), source: amount === null ? (source ?? "unavailable") : source };
}

export function executionProfileLabel(summary: ExecutionProfileSummary): string {
  switch (summary.kind) {
    case "provider_default": return "Provider Default";
    case "openai_reasoning": return `Reasoning · ${friendly(summary.value)}`;
    case "anthropic_thinking": return `Thinking · Enabled · Budget ${summary.budgetTokens.toLocaleString("en-US")}`;
    case "gemini_thinking_budget": return `Thinking Budget · ${summary.budgetTokens.toLocaleString("en-US")}`;
    case "gemini_thinking_level": return `Thinking Level · ${friendly(summary.value)}`;
  }
}

export function formatPerformanceBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Revalidates a projection loaded from local history and drops unknown fields. */
export function sanitizePerformanceProjection(value: unknown): TaskPerformanceProjection | undefined {
  if (!record(value) || !record(value.overview) || !Array.isArray(value.roles) || !record(value.latency) || !record(value.context) || !record(value.tools) || !record(value.validation) || !record(value.review) || !record(value.repair) || !record(value.cost)) return undefined;
  const roles = value.roles.slice(0, 4).flatMap((item) => sanitizeRole(item));
  if (roles.length !== 4 || roles.some((role, index) => role.role !== (["planner", "executor", "reviewer", "repair"] as const)[index])) return undefined;
  const terminalStatus = ["completed", "failed", "aborted", "interrupted"].includes(String(value.overview.terminalStatus)) ? value.overview.terminalStatus as PerformanceTerminalStatus : null;
  const overview = {
    terminalStatus, inputTokens: metric(value.overview.inputTokens), outputTokens: metric(value.overview.outputTokens), totalTokens: metric(value.overview.totalTokens),
    workflowDurationMs: metric(value.overview.workflowDurationMs), providerCalls: metric(value.overview.providerCalls), toolCalls: metric(value.overview.toolCalls), repairCycles: metric(value.overview.repairCycles),
    usageSource: text(value.overview.usageSource, 40), validationStatus: text(value.overview.validationStatus, 80), reviewStatus: text(value.overview.reviewStatus, 80),
    cost: metric(value.overview.cost), currency: text(value.overview.currency, 12), costSource: text(value.overview.costSource, 40),
  };
  const executorTasks = Array.isArray(value.executorTasks) ? value.executorTasks.slice(0, MAX_PERFORMANCE_EXECUTOR_TASKS).flatMap((item) => {
    if (!record(item) || !text(item.taskId, 200)) return [];
    return [{ taskId: text(item.taskId, 200)!, title: text(item.title, 300), inputTokens: metric(item.inputTokens), outputTokens: metric(item.outputTokens), totalTokens: metric(item.totalTokens), providerDurationMs: metric(item.providerDurationMs), providerCalls: metric(item.providerCalls), toolCalls: metric(item.toolCalls), toolDurationMs: metric(item.toolDurationMs) }];
  }) : [];
  const providerByRoleValue = record(value.latency.providerByRole) ? value.latency.providerByRole : {};
  const providerByRole = Object.fromEntries((["planner", "executor", "reviewer", "repair"] as const).map((role) => [role, metric(providerByRoleValue[role])])) as Record<PerformanceRole, number | null>;
  const steps = Array.isArray(value.validation.steps) ? value.validation.steps.slice(0, MAX_PERFORMANCE_VALIDATION_STEPS).flatMap((item) => record(item) && text(item.name, 120) && text(item.status, 40) ? [{ name: text(item.name, 120)!, status: text(item.status, 40)!, durationMs: metric(item.durationMs) }] : []) : [];
  const byName = Array.isArray(value.tools.byName) ? value.tools.byName.slice(0, MAX_PERFORMANCE_TOOL_NAMES).flatMap((item) => record(item) && text(item.name, 120) && metric(item.count) !== null ? [{ name: text(item.name, 120)!, count: metric(item.count)! }] : []) : [];
  const reviewer = roles[2]!; const repairRole = roles[3]!;
  return {
    detailLevel: value.detailLevel === "legacy" ? "legacy" : "detailed", overview, roles, executorTasks,
    latency: { workflowDurationMs: metric(value.latency.workflowDurationMs), totalProviderDurationMs: metric(value.latency.totalProviderDurationMs), providerByRole, toolDurationMs: metric(value.latency.toolDurationMs), validationDurationMs: metric(value.latency.validationDurationMs), reviewDurationMs: metric(value.latency.reviewDurationMs), repairDurationMs: metric(value.latency.repairDurationMs), localOrchestrationDurationMs: metric(value.latency.localOrchestrationDurationMs) },
    context: { files: metric(value.context.files), bytes: metric(value.context.bytes), truncated: typeof value.context.truncated === "boolean" ? value.context.truncated : null, targetedExpansions: metric(value.context.targetedExpansions) },
    tools: { requestedByModel: metric(value.tools.requestedByModel), executed: metric(value.tools.executed), successful: metric(value.tools.successful), failed: metric(value.tools.failed), invalid: metric(value.tools.invalid), durationMs: metric(value.tools.durationMs), byName },
    validation: { status: text(value.validation.status, 80), durationMs: metric(value.validation.durationMs), steps },
    review: { status: text(value.review.status, 80), durationMs: metric(value.review.durationMs), contextExpansions: metric(value.review.contextExpansions), role: reviewer },
    repair: { cycles: metric(value.repair.cycles), durationMs: metric(value.repair.durationMs), providerCalls: metric(value.repair.providerCalls), inputTokens: metric(value.repair.inputTokens), outputTokens: metric(value.repair.outputTokens), totalTokens: metric(value.repair.totalTokens), providerDurationMs: metric(value.repair.providerDurationMs), usesExecutorProfile: true, executionProfileSummary: repairRole.executionProfileSummary, executionProfileLabel: repairRole.executionProfileLabel },
    cost: { amount: metric(value.cost.amount), currency: text(value.cost.currency, 12), source: text(value.cost.source, 40) },
  };
}

function sanitizeRole(value: unknown): PerformanceRoleProjection[] {
  if (!record(value) || !["planner", "executor", "reviewer", "repair"].includes(String(value.role))) return [];
  const summary = sanitizeExecutionProfileSummary(value.executionProfileSummary);
  return [{ role: value.role as PerformanceRole, providerConfigId: text(value.providerConfigId, 200), providerId: text(value.providerId, 120), providerName: text(value.providerName, 100), requestedModelId: text(value.requestedModelId, 300), resolvedModelId: text(value.resolvedModelId, 300), executionProfileSummary: summary, executionProfileLabel: summary ? executionProfileLabel(summary) : null, calls: metric(value.calls), inputTokens: metric(value.inputTokens), outputTokens: metric(value.outputTokens), totalTokens: metric(value.totalTokens), providerDurationMs: metric(value.providerDurationMs), usageSource: text(value.usageSource, 40) }];
}

function sanitizeExecutionProfileSummary(value: unknown): ExecutionProfileSummary | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case "provider_default": return { kind: value.kind };
    case "openai_reasoning": return text(value.value, 80) ? { kind: value.kind, value: text(value.value, 80)! } : null;
    case "anthropic_thinking": return value.enabled === true && metric(value.budgetTokens) !== null ? { kind: value.kind, enabled: true, budgetTokens: metric(value.budgetTokens)! } : null;
    case "gemini_thinking_budget": return metric(value.budgetTokens) !== null ? { kind: value.kind, budgetTokens: metric(value.budgetTokens)! } : null;
    case "gemini_thinking_level": return text(value.value, 80) ? { kind: value.kind, value: text(value.value, 80)! } : null;
    default: return null;
  }
}

const metric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bounded = (value: unknown, max: number): string => typeof value === "string" ? redactCredentialShapes(value.trim().slice(0, max)) : "";
const text = (value: unknown, max: number): string | null => bounded(value, max) || null;
const friendly = (value: string): string => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
function redactCredentialShapes(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:access|refresh|device|bearer)[-_ ]?token\s*[:=]\s*)[^\s,;&]+/gi, "$1[redacted]")
    .replace(/(cookie\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted]");
}
