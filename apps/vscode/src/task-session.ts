import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceViewState } from "./workspace-state.js";

export const TASK_SESSION_SCHEMA_VERSION = 1;
export const MAX_HISTORY_SESSIONS = 50;
export const MAX_HISTORY_TITLE = 100;
export const MAX_HISTORY_REQUIREMENT = 20_000;
export const MAX_HISTORY_TASKS = 32;
export const MAX_HISTORY_CRITERIA = 8;
export const MAX_HISTORY_DEPENDENCIES = 16;
export const MAX_HISTORY_RISKS = 16;
export const MAX_HISTORY_VALIDATION_STEPS = 32;

export type TaskSessionStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "validating"
  | "reviewing"
  | "repairing"
  | "waiting_for_permission"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export interface TaskWorkspaceIdentity { readonly id: string; readonly label: string }
export interface TaskPlanSummary {
  readonly objective: string;
  readonly approvalStatus: "draft" | "approved" | "rejected";
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly acceptanceCriteria: readonly string[]; readonly dependencies: readonly string[]; readonly risk?: string }[];
  readonly risks: readonly { readonly description: string; readonly severity: string; readonly mitigation?: string }[];
}
export interface TaskExecutionSummary { readonly completed: number; readonly total: number; readonly currentTaskTitle?: string; readonly tasks: readonly { readonly title: string; readonly status: string }[] }
export interface TaskValidationSummary { readonly status: "passed" | "failed" | "pending" | "unavailable"; readonly steps: readonly { readonly name: string; readonly status: string; readonly durationMs: number | null }[] }
export interface TaskReviewSummary { readonly status: string; readonly findingCount: number | null; readonly ruleViolationCount: number | null }
export interface TaskRepairSummary { readonly cycles: number | null; readonly outcome: string | null; readonly durationMs: number | null; readonly tokens: number | null }
export interface TaskUsageSummary { readonly totalTokens: number | null; readonly providerCalls: number | null; readonly toolCalls: number | null; readonly workflowDurationMs: number | null; readonly repairCycles: number | null }

export interface TaskSession {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspaceIdentity: TaskWorkspaceIdentity;
  readonly title: string;
  readonly requirement: string;
  readonly workflowId?: string;
  readonly status: TaskSessionStatus;
  readonly providerSummary?: { readonly provider: string; readonly model?: string };
  readonly planSummary?: TaskPlanSummary;
  readonly executionSummary?: TaskExecutionSummary;
  readonly validationSummary?: TaskValidationSummary;
  readonly reviewSummary?: TaskReviewSummary;
  readonly repairSummary?: TaskRepairSummary;
  readonly usageSummary?: TaskUsageSummary;
  readonly failureSummary?: { readonly stage: string; readonly message: string };
  readonly interrupted?: true;
}

export interface CreateTaskSessionInput {
  readonly requirement: string;
  readonly workspaceIdentity: TaskWorkspaceIdentity;
  readonly providerSummary?: TaskSession["providerSummary"];
  readonly id?: string;
  readonly now?: string;
}

const bounded = (value: unknown, max: number): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const privacySafe = (value: unknown, max: number): string => typeof value === "string" ? bounded(redactSensitiveText(value), max) : "";
// Preserve authoritative Core totals verbatim. The history projection validates
// numbers but never derives, rounds, or otherwise recalculates usage.
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const statusSet = new Set<TaskSessionStatus>(["draft", "planning", "awaiting_approval", "executing", "validating", "reviewing", "repairing", "waiting_for_permission", "paused", "completed", "failed", "aborted", "interrupted"]);
export const TERMINAL_TASK_SESSION_STATUSES = new Set<TaskSessionStatus>(["completed", "failed", "aborted", "interrupted"]);

/** Redacts common credential shapes before any user/provider-controlled text is persisted. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:access|refresh|device|bearer)[-_ ]?token\s*[:=]\s*)[^\s,;&]+/gi, "$1[redacted]")
    .replace(/(cookie\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted]");
}

export function deterministicTaskTitle(requirement: string): string {
  const firstMeaningful = requirement.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).find(Boolean) ?? "Untitled task";
  if (firstMeaningful.length <= MAX_HISTORY_TITLE) return firstMeaningful;
  const shortened = firstMeaningful.slice(0, MAX_HISTORY_TITLE - 1).trimEnd();
  return `${shortened}…`;
}

export function safeWorkspaceIdentity(folderName: string, workspaceRoot: string): TaskWorkspaceIdentity {
  const slashNormalized = workspaceRoot.replaceAll("\\", "/");
  const withoutTrailingSlash = slashNormalized.length > 1 ? slashNormalized.replace(/\/+$/, "") : slashNormalized;
  const normalized = process.platform === "win32" ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
  return { id: createHash("sha256").update(normalized).digest("hex").slice(0, 24), label: privacySafe(folderName, 100) || "Workspace" };
}

export function createTaskSession(input: CreateTaskSessionInput): TaskSession {
  const now = input.now ?? new Date().toISOString();
  const session = sanitizeTaskSession({
    id: input.id ?? randomUUID(), schemaVersion: TASK_SESSION_SCHEMA_VERSION, createdAt: now, updatedAt: now,
    workspaceIdentity: input.workspaceIdentity, title: deterministicTaskTitle(input.requirement), requirement: input.requirement,
    status: "draft", ...(input.providerSummary ? { providerSummary: input.providerSummary } : {}),
  });
  if (!session) throw new Error("Task requirement and workspace identity are required.");
  return session;
}

export function projectTaskSession(existing: TaskSession, state: WorkspaceViewState, now = new Date().toISOString()): TaskSession {
  const workflow = state.workflow;
  const usage = state.usage ?? state.completion;
  const status = taskSessionStatus(workflow?.status, state.completion?.status, existing.status);
  const currentTask = workflow?.tasks.find((task) => task.id === workflow.currentTaskId);
  const planApproval = workflow?.approvalStatus === "approved" || (workflow && !["created", "planning", "awaiting_plan_approval"].includes(workflow.status)) ? "approved" : workflow?.approvalStatus === "rejected" ? "rejected" : "draft";
  const validationStatus = state.validation.some((step) => ["failed", "timed_out", "errored"].includes(step.status)) ? "failed" : state.validation.length ? "passed" : ["validating", "reviewing", "repairing", "completed"].includes(workflow?.status ?? "") ? "unavailable" : "pending";
  const projected = {
    ...existing,
    updatedAt: now,
    ...(workflow?.id ? { workflowId: workflow.id } : {}),
    status,
    ...(state.plan ? { planSummary: {
      objective: state.plan.objective,
      approvalStatus: planApproval,
      tasks: state.plan.tasks.map((task) => ({ id: task.id, title: task.title, acceptanceCriteria: task.acceptanceCriteria, dependencies: task.dependencies, ...(task.risk ? { risk: task.risk } : {}) })),
      risks: state.plan.risks,
    } } : {}),
    ...(workflow ? { executionSummary: { completed: workflow.progress?.completed ?? 0, total: workflow.progress?.total ?? workflow.tasks.length, ...(currentTask ? { currentTaskTitle: currentTask.title } : {}), tasks: workflow.tasks.map((task) => ({ title: task.title, status: task.status })) } } : {}),
    ...(state.validation.length || workflow ? { validationSummary: { status: validationStatus, steps: state.validation.map((step) => ({ name: step.kind, status: step.status, durationMs: step.durationMs ?? null })) } } : {}),
    ...(state.reviewStatus ? { reviewSummary: { status: state.reviewStatus, findingCount: state.reviewFindingCount ?? null, ruleViolationCount: null } } : {}),
    ...(state.repairCycles !== null || state.repairUsage ? { repairSummary: { cycles: state.repairCycles, outcome: status === "completed" ? "completed" : status === "failed" ? "failed" : status === "aborted" ? "aborted" : status === "repairing" ? "repairing" : null, durationMs: state.repairUsage?.durationMs ?? null, tokens: state.repairUsage?.tokens ?? null } } : {}),
    ...(usage ? { usageSummary: { totalTokens: usage.tokens, providerCalls: usage.modelCalls, toolCalls: state.usage?.toolCalls ?? null, workflowDurationMs: usage.durationMs, repairCycles: usage.repairCycles } } : {}),
    ...(workflow?.error ? { failureSummary: { stage: workflow.error.stage, message: workflow.error.message } } : {}),
  };
  return sanitizeTaskSession(projected)!;
}

export function taskSessionStatus(coreStatus: string | undefined, completionStatus: string | undefined, fallback: TaskSessionStatus = "draft"): TaskSessionStatus {
  if (completionStatus === "completed" || completionStatus === "failed" || completionStatus === "aborted") return completionStatus;
  switch (coreStatus) {
    case "created": case "planning": case "planned": return "planning";
    case "awaiting_plan_approval": return "awaiting_approval";
    case "approved": case "running": case "executing": return "executing";
    case "validating": return "validating";
    case "reviewing": return "reviewing";
    case "repairing": return "repairing";
    case "waiting_for_permission": return "waiting_for_permission";
    case "paused": return "paused";
    case "completed": case "failed": case "aborted": return coreStatus;
    default: return fallback;
  }
}

export function sanitizeTaskSession(value: unknown): TaskSession | undefined {
  if (!record(value) || value.schemaVersion !== TASK_SESSION_SCHEMA_VERSION) return undefined;
  const id = bounded(value.id, 200); const createdAt = date(value.createdAt); const updatedAt = date(value.updatedAt);
  const workspace = record(value.workspaceIdentity) ? { id: bounded(value.workspaceIdentity.id, 64), label: privacySafe(value.workspaceIdentity.label, 100) } : undefined;
  const title = privacySafe(value.title, MAX_HISTORY_TITLE); const requirement = privacySafe(value.requirement, MAX_HISTORY_REQUIREMENT);
  const status = typeof value.status === "string" && statusSet.has(value.status as TaskSessionStatus) ? value.status as TaskSessionStatus : undefined;
  if (!id || !createdAt || !updatedAt || !workspace?.id || !workspace.label || !title || !requirement || !status) return undefined;
  const session: TaskSession = { id, schemaVersion: TASK_SESSION_SCHEMA_VERSION, createdAt, updatedAt, workspaceIdentity: workspace, title, requirement, status };
  const workflowId = bounded(value.workflowId, 200); if (workflowId) Object.assign(session, { workflowId });
  if (record(value.providerSummary)) { const provider = privacySafe(value.providerSummary.provider, 100); const model = privacySafe(value.providerSummary.model, 200); if (provider) Object.assign(session, { providerSummary: { provider, ...(model ? { model } : {}) } }); }
  const planSummary = sanitizePlan(value.planSummary); if (planSummary) Object.assign(session, { planSummary });
  const executionSummary = sanitizeExecution(value.executionSummary); if (executionSummary) Object.assign(session, { executionSummary });
  const validationSummary = sanitizeValidation(value.validationSummary); if (validationSummary) Object.assign(session, { validationSummary });
  if (record(value.reviewSummary)) { const reviewStatus = privacySafe(value.reviewSummary.status, 80); if (reviewStatus) Object.assign(session, { reviewSummary: { status: reviewStatus, findingCount: count(value.reviewSummary.findingCount), ruleViolationCount: count(value.reviewSummary.ruleViolationCount) } }); }
  if (record(value.repairSummary)) Object.assign(session, { repairSummary: { cycles: count(value.repairSummary.cycles), outcome: privacySafe(value.repairSummary.outcome, 80) || null, durationMs: count(value.repairSummary.durationMs), tokens: count(value.repairSummary.tokens) } });
  if (record(value.usageSummary)) Object.assign(session, { usageSummary: { totalTokens: count(value.usageSummary.totalTokens), providerCalls: count(value.usageSummary.providerCalls), toolCalls: count(value.usageSummary.toolCalls), workflowDurationMs: count(value.usageSummary.workflowDurationMs), repairCycles: count(value.usageSummary.repairCycles) } });
  if (record(value.failureSummary)) { const stage = privacySafe(value.failureSummary.stage, 80); const message = privacySafe(value.failureSummary.message, 240); if (stage && message) Object.assign(session, { failureSummary: { stage, message } }); }
  if (status === "interrupted" || value.interrupted === true) Object.assign(session, { interrupted: true });
  return session;
}

function sanitizePlan(value: unknown): TaskPlanSummary | undefined {
  if (!record(value)) return undefined;
  const objective = privacySafe(value.objective, 2_000); if (!objective) return undefined;
  const approvalStatus = value.approvalStatus === "approved" || value.approvalStatus === "rejected" ? value.approvalStatus : "draft";
  const tasks = Array.isArray(value.tasks) ? value.tasks.slice(0, MAX_HISTORY_TASKS).flatMap((item) => {
    if (!record(item)) return [];
    const id = bounded(item.id, 200); const title = privacySafe(item.title, 300); if (!id || !title) return [];
    const acceptanceCriteria = Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.slice(0, MAX_HISTORY_CRITERIA).map((entry) => privacySafe(entry, 500)).filter(Boolean) : [];
    const dependencies = Array.isArray(item.dependencies) ? item.dependencies.slice(0, MAX_HISTORY_DEPENDENCIES).map((entry) => bounded(entry, 200)).filter(Boolean) : [];
    const risk = privacySafe(item.risk, 20); return [{ id, title, acceptanceCriteria, dependencies, ...(risk ? { risk } : {}) }];
  }) : [];
  const risks = Array.isArray(value.risks) ? value.risks.slice(0, MAX_HISTORY_RISKS).flatMap((item) => { if (!record(item)) return []; const description = privacySafe(item.description, 500); const severity = privacySafe(item.severity, 20); const mitigation = privacySafe(item.mitigation, 500); return description && severity ? [{ description, severity, ...(mitigation ? { mitigation } : {}) }] : []; }) : [];
  return { objective, approvalStatus, tasks, risks };
}

function sanitizeExecution(value: unknown): TaskExecutionSummary | undefined {
  if (!record(value)) return undefined;
  const completed = count(value.completed); const total = count(value.total); if (completed === null || total === null) return undefined;
  const currentTaskTitle = privacySafe(value.currentTaskTitle, 300);
  const tasks = Array.isArray(value.tasks) ? value.tasks.slice(0, MAX_HISTORY_TASKS).flatMap((item) => record(item) && privacySafe(item.title, 300) ? [{ title: privacySafe(item.title, 300), status: privacySafe(item.status, 40) || "pending" }] : []) : [];
  return { completed, total, ...(currentTaskTitle ? { currentTaskTitle } : {}), tasks };
}

function sanitizeValidation(value: unknown): TaskValidationSummary | undefined {
  if (!record(value)) return undefined;
  const validationStatuses = new Set(["passed", "failed", "pending", "unavailable"]); const validationStatus = typeof value.status === "string" && validationStatuses.has(value.status) ? value.status as TaskValidationSummary["status"] : "unavailable";
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, MAX_HISTORY_VALIDATION_STEPS).flatMap((item) => record(item) && privacySafe(item.name, 120) ? [{ name: privacySafe(item.name, 120), status: privacySafe(item.status, 40) || "unknown", durationMs: count(item.durationMs) }] : []) : [];
  return { status: validationStatus, steps };
}

function date(value: unknown): string | undefined { if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return undefined; return value; }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
