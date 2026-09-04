import type { ExecutionPlan, WorkflowSnapshot } from "@nyxara/core";
type WorkflowUsage = NonNullable<WorkflowSnapshot["usage"]>;
import type { ProviderConfig } from "./provider-config.js";
import type { TaskSession } from "./task-session.js";
import { buildLegacyPerformanceProjection, buildPerformanceProjection, type TaskPerformanceProjection } from "./performance-projection.js";
import { friendlyErrorMessage, workflowStage } from "./projection.js";
import type { SettingsProjection, SettingsSection } from "./settings-projection.js";

const MAX_TEXT = 2_000;
const MAX_ITEMS = 64;
const bounded = (value: unknown, max = MAX_TEXT): string => typeof value === "string" ? value.slice(0, max) : "";

export interface WorkspaceRoleState { readonly role: string; readonly providerId?: string; readonly providerName?: string; readonly modelId?: string }
export interface WorkspacePlanState {
  readonly id: string;
  readonly objective: string;
  readonly summary?: string;
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly description: string; readonly acceptanceCriteria: readonly string[]; readonly dependencies: readonly string[]; readonly risk?: string }[];
  readonly risks: readonly { readonly description: string; readonly severity: string; readonly mitigation?: string }[];
}
export interface TaskHistoryViewState {
  readonly screen: "workspace" | "history" | "historical";
  readonly recentTasks: readonly TaskSession[];
  readonly tasks: readonly TaskSession[];
  readonly query: string;
  readonly filter: "all" | "active" | "completed" | "failed" | "interrupted";
  readonly scope: "current" | "all";
  readonly currentWorkspaceId?: string;
  readonly activeTaskId?: string;
  readonly selectedTask?: TaskSession;
}
export interface WorkspaceViewState {
  readonly version: string;
  readonly configured: boolean;
  readonly workspace: { readonly available: boolean; readonly multiple: boolean };
  readonly providerLabel: string;
  readonly advancedRouting: boolean;
  readonly providers: readonly { readonly id: string; readonly displayName: string; readonly modelId?: string; readonly isDefault: boolean }[];
  readonly history: TaskHistoryViewState;
  readonly prompt?: string;
  readonly plan?: WorkspacePlanState;
  readonly workflow?: {
    readonly id: string;
    readonly status: string;
    readonly stage: string;
    readonly active: boolean;
    readonly approvalStatus?: "draft" | "approved" | "rejected";
    readonly progress?: { readonly completed: number; readonly total: number };
    readonly currentTaskId?: string;
    readonly tasks: readonly { readonly id: string; readonly title: string; readonly status: string }[];
    readonly permission?: { readonly id: string; readonly action: string; readonly reason: string };
    readonly error?: { readonly stage: string; readonly message: string };
  };
  readonly validation: readonly { readonly kind: string; readonly status: string; readonly durationMs?: number | null }[];
  readonly reviewStatus?: string;
  readonly reviewFindingCount?: number;
  readonly repairCycles: number | null;
  readonly repairUsage?: { readonly durationMs: number | null; readonly tokens: number | null };
  readonly usage?: { readonly tokens: number | null; readonly modelCalls: number | null; readonly toolCalls: number | null; readonly durationMs: number | null; readonly repairCycles: number | null };
  readonly completion?: { readonly status: "completed" | "failed" | "aborted"; readonly changedFiles: number | null; readonly tokens: number | null; readonly modelCalls: number | null; readonly durationMs: number | null; readonly repairCycles: number | null };
  readonly performance?: TaskPerformanceProjection;
  readonly performanceView?: {
    readonly source: "live" | "history";
    readonly taskId?: string;
    readonly taskStatus: string;
    readonly projection?: TaskPerformanceProjection;
  };
  readonly settings?: { readonly section: SettingsSection; readonly providerConfigId?: string; readonly projection: SettingsProjection; readonly diagnostics?: Readonly<Record<string, unknown>> };
}

export interface BuildWorkspaceStateInput {
  readonly version: string;
  readonly configured: boolean;
  readonly folders: number;
  readonly providers: readonly ProviderConfig[];
  readonly defaultProviderId?: string;
  readonly roles: readonly WorkspaceRoleState[];
  readonly prompt?: string;
  readonly plan?: ExecutionPlan;
  readonly snapshot?: WorkflowSnapshot;
  readonly validation: ReadonlyMap<string, string>;
  readonly reviewStatus?: string;
  readonly reviewFindingCount?: number;
  readonly repairCycle?: number;
  readonly validationDurations?: ReadonlyMap<string, number>;
  readonly result?: { readonly status: "completed" | "failed" | "aborted"; readonly changedFiles: readonly string[]; readonly durationMs: number; readonly repairCycles: number; readonly usage?: WorkflowUsage };
  readonly history?: TaskHistoryViewState;
  readonly settings?: WorkspaceViewState["settings"];
  readonly performanceTarget?: { readonly source: "live" } | { readonly source: "history"; readonly task: TaskSession };
}

const terminal = new Set(["completed", "failed", "aborted"]);

export function buildWorkspaceState(input: BuildWorkspaceStateInput): WorkspaceViewState {
  const selected = input.providers.find((provider) => provider.id === input.defaultProviderId);
  const pairs = input.roles.filter((role) => role.providerId && role.modelId).map((role) => `${role.providerId}\0${role.modelId}`);
  const advancedRouting = new Set(pairs).size > 1;
  const defaultModel = selected?.modelId ?? input.roles.find((role) => role.role === "planner" && role.providerId === selected?.id)?.modelId;
  const snapshot = input.snapshot;
  const usage = input.result?.usage ?? snapshot?.usage;
  const plan = projectPlan(input.plan);
  const completionStatus = input.result?.status ?? (snapshot && terminal.has(snapshot.status) ? snapshot.status as "completed" | "failed" | "aborted" : undefined);
  const taskTitles = Object.fromEntries((plan?.tasks ?? []).map((task) => [task.id, task.title]));
  const performance = usage ? buildPerformanceProjection({ usage, providers: input.providers, executorTaskTitles: taskTitles, ...(completionStatus ? { terminalStatus: completionStatus } : {}) }) : undefined;
  const validation = usage?.validation?.steps?.slice(0, MAX_ITEMS).map((step) => ({ kind: bounded(step.name, 120), status: bounded(step.status, 40), durationMs: step.durationMs }))
    ?? [...input.validation.entries()].slice(0, MAX_ITEMS).map(([kind, status]) => ({ kind: bounded(kind, 120), status: bounded(status, 40), ...(input.validationDurations?.has(kind) ? { durationMs: input.validationDurations.get(kind)! } : {}) }));
  const reviewStatus = bounded(usage?.review?.status ?? input.reviewStatus, 80) || undefined;
  const workflow = snapshot ? {
    id: bounded(snapshot.workflowId, 200),
    status: snapshot.status,
    stage: workflowStage(snapshot),
    active: !terminal.has(snapshot.status),
    ...(snapshot.plan?.status ? { approvalStatus: snapshot.plan.status } : {}),
    ...(snapshot.progress ? { progress: { completed: snapshot.progress.completed, total: snapshot.progress.total } } : {}),
    ...(snapshot.currentTaskId ? { currentTaskId: bounded(snapshot.currentTaskId, 200) } : {}),
    tasks: snapshot.tasks.slice(0, MAX_ITEMS).map((task) => ({ id: bounded(task.taskId, 200), title: plan?.tasks.find((item) => item.id === task.taskId)?.title ?? bounded(task.taskId, 200), status: task.executionStatus ?? "pending" })),
    ...(snapshot.pendingPermission ? { permission: { id: bounded(snapshot.pendingPermission.id, 300), action: bounded([snapshot.pendingPermission.capability, snapshot.pendingPermission.resource].filter(Boolean).join(" · "), 300), reason: bounded(snapshot.pendingPermission.reason || "Nyxara needs permission to continue.", 500) } } : {}),
    ...(snapshot.error ? { error: { stage: workflowStage(snapshot), message: friendlyErrorMessage(snapshot.error) } } : {}),
  } : undefined;
  const completion = completionStatus ? {
    status: completionStatus,
    changedFiles: input.result?.changedFiles.length ?? null,
    tokens: performance?.overview.totalTokens ?? null,
    modelCalls: performance?.overview.providerCalls ?? null,
    durationMs: input.result?.durationMs ?? performance?.overview.workflowDurationMs ?? null,
    repairCycles: input.result?.repairCycles ?? performance?.overview.repairCycles ?? null,
  } : undefined;
  const projectedUsage = performance ? { tokens: performance.overview.totalTokens, modelCalls: performance.overview.providerCalls, toolCalls: performance.overview.toolCalls, durationMs: performance.overview.workflowDurationMs, repairCycles: performance.overview.repairCycles } : undefined;
  const performanceView = input.performanceTarget?.source === "live"
    ? { source: "live" as const, taskStatus: completionStatus ?? snapshot?.status ?? "active", ...(performance ? { projection: performance } : {}) }
    : input.performanceTarget?.source === "history"
      ? { source: "history" as const, taskId: input.performanceTarget.task.id, taskStatus: input.performanceTarget.task.status, ...(input.performanceTarget.task.performanceSummary ? { projection: input.performanceTarget.task.performanceSummary } : input.performanceTarget.task.usageSummary ? { projection: buildLegacyPerformanceProjection(input.performanceTarget.task.usageSummary, terminalPerformanceStatus(input.performanceTarget.task.status)) } : {}) }
      : undefined;
  return {
    version: bounded(input.version, 40), configured: input.configured,
    workspace: { available: input.folders > 0, multiple: input.folders > 1 },
    providerLabel: advancedRouting ? "Advanced routing" : selected ? `${bounded(selected.displayName, 100)}${defaultModel ? ` · ${bounded(defaultModel, 200)}` : ""}` : "No provider",
    advancedRouting,
    providers: input.providers.slice(0, MAX_ITEMS).map((provider) => {
      const modelId = provider.modelId ?? input.roles.find((role) => role.role === "planner" && role.providerId === provider.id)?.modelId;
      return { id: bounded(provider.id, 200), displayName: bounded(provider.displayName, 100), ...(modelId ? { modelId: bounded(modelId, 200) } : {}), isDefault: provider.id === input.defaultProviderId };
    }),
    history: input.history ?? { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "current" },
    ...(input.prompt ? { prompt: bounded(input.prompt, 20_000) } : {}), ...(plan ? { plan } : {}), ...(workflow ? { workflow } : {}), validation,
    ...(reviewStatus ? { reviewStatus } : {}), ...(input.reviewFindingCount !== undefined ? { reviewFindingCount: input.reviewFindingCount } : {}), repairCycles: input.result?.repairCycles ?? usage?.repairCycles ?? input.repairCycle ?? null,
    ...(usage?.repairSummary ? { repairUsage: { durationMs: usage.repairSummary.totalDurationMs, tokens: usage.repairSummary.tokens } } : {}),
    ...(projectedUsage ? { usage: projectedUsage } : {}),
    ...(completion ? { completion } : {}), ...(performance ? { performance } : {}), ...(performanceView ? { performanceView } : {}), ...(input.settings ? { settings: input.settings } : {}),
  };
}

function terminalPerformanceStatus(status: string): "completed" | "failed" | "aborted" | "interrupted" | undefined {
  return status === "completed" || status === "failed" || status === "aborted" || status === "interrupted" ? status : undefined;
}

function projectPlan(plan: ExecutionPlan | undefined): WorkspacePlanState | undefined {
  if (!plan) return undefined;
  return {
    id: bounded(plan.id, 200), objective: bounded(plan.objective), ...(plan.summary ? { summary: bounded(plan.summary) } : {}),
    tasks: plan.tasks.slice(0, MAX_ITEMS).map((task) => ({ id: bounded(task.id, 200), title: bounded(task.title, 300), description: bounded(task.description), acceptanceCriteria: task.acceptanceCriteria.slice(0, MAX_ITEMS).map((item) => bounded(item, 500)), dependencies: task.dependencies.slice(0, MAX_ITEMS).map((item) => bounded(item, 200)), ...(task.risk ? { risk: task.risk } : {}) })),
    risks: (plan.risks ?? []).slice(0, MAX_ITEMS).map((risk) => ({ description: bounded(risk.description, 500), severity: risk.severity, ...(risk.mitigation ? { mitigation: bounded(risk.mitigation, 500) } : {}) })),
  };
}
