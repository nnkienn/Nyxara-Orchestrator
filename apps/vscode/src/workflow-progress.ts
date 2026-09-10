import type { WorkflowSnapshot } from "@nyxara/core";
import type { TaskSession } from "./task-session.js";

export const WORKFLOW_STEPS = ["Plan", "Execute", "Validate", "Review", "Repair"] as const;
export type WorkflowStep = typeof WORKFLOW_STEPS[number];
export type StepStatus = "completed" | "active" | "pending" | "failed" | "aborted" | "waiting";
export interface WorkflowProgressStep { readonly label: WorkflowStep; readonly status: StepStatus }
export type WorkflowProgress = readonly WorkflowProgressStep[];

export function workflowStep(status: string): WorkflowStep | undefined {
  switch (status) {
    case "created": case "planning": return "Plan";
    case "executing": case "running": return "Execute";
    case "validating": return "Validate";
    case "reviewing": return "Review";
    case "repairing": return "Repair";
    default: return undefined;
  }
}

export function projectWorkflowProgress(snapshot: WorkflowSnapshot, owningStage?: WorkflowStep): WorkflowProgress {
  const statuses: Record<WorkflowStep, StepStatus> = { Plan: "pending", Execute: "pending", Validate: "pending", Review: "pending", Repair: "pending" };
  const current = snapshot.status === "completed" ? undefined : snapshot.tasks.find((task) => task.taskId === (snapshot.failedTaskId ?? snapshot.currentTaskId));
  const tasks = current ? [current] : snapshot.tasks;
  if (!["created", "planning"].includes(snapshot.status) && (snapshot.planId || snapshot.plan || ["planned", "awaiting_plan_approval", "approved"].includes(snapshot.status))) statuses.Plan = "completed";
  const evidence = (values: readonly (string | undefined)[]): StepStatus => values.some((value) => ["failed", "stalled", "limit_reached", "needs_more_context"].includes(value ?? "")) ? "failed"
    : values.some((value) => value === "aborted") ? "aborted"
      : values.length > 0 && values.every((value) => value === "passed" || value === "completed") ? "completed" : "pending";
  statuses.Execute = evidence(tasks.map((task) => task.executionStatus));
  statuses.Validate = evidence(tasks.filter((task) => task.validationStatus !== undefined).map((task) => task.validationStatus));
  statuses.Review = evidence(tasks.filter((task) => task.reviewStatus !== undefined).map((task) => task.reviewStatus));
  statuses.Repair = evidence(tasks.filter((task) => task.repairStatus !== undefined).map((task) => task.repairStatus));
  if (tasks.some((task) => task.validationStatus !== undefined || task.reviewStatus !== undefined || task.repairStatus !== undefined) || ["validating", "reviewing", "repairing"].includes(snapshot.status)) statuses.Execute = "completed";
  const rejected = snapshot.outcome === "rejected" || snapshot.error?.code === "plan_rejected";
  const owner = workflowStep(snapshot.status) ?? owningStage;
  if (rejected) {
    for (const step of WORKFLOW_STEPS) statuses[step] = step === "Plan" ? "completed" : "pending";
  } else if (snapshot.status === "waiting_for_permission" || snapshot.status === "paused") {
    if (owner) statuses[owner] = snapshot.status === "waiting_for_permission" ? "active" : "waiting";
  } else if (snapshot.status === "failed" || snapshot.status === "aborted") {
    const failed = [...WORKFLOW_STEPS].reverse().find((step) => statuses[step] === "failed" || statuses[step] === "aborted");
    const inferred = failed ?? (tasks.some((task) => task.executionStatus === "running") ? "Execute" : !snapshot.planId ? "Plan" : undefined);
    const terminalOwner = snapshot.status === "failed" ? inferred ?? owner : owner ?? inferred;
    if (terminalOwner) statuses[terminalOwner] = snapshot.status;
  } else {
    const active = workflowStep(snapshot.status);
    if (active) statuses[active] = "active";
  }
  return WORKFLOW_STEPS.map((label) => ({ label, status: statuses[label] }));
}

export function historicalWorkflowProgress(task: TaskSession): WorkflowProgress {
  if (task.workflowProgress) return task.workflowProgress.map((step) => ({ ...step, status: ["interrupted", "aborted"].includes(task.status) && ["active", "waiting"].includes(step.status) ? "aborted" : step.status }));
  const execution = task.executionSummary;
  const statuses: Record<WorkflowStep, StepStatus> = {
    Plan: task.planSummary ? "completed" : "pending",
    Execute: execution?.tasks.some((entry) => entry.status === "failed") ? "failed" : execution && execution.total > 0 && execution.completed === execution.total ? "completed" : "pending",
    Validate: task.validationSummary?.status === "passed" ? "completed" : task.validationSummary?.status === "failed" ? "failed" : "pending",
    Review: task.reviewSummary?.status === "passed" ? "completed" : ["failed", "needs_more_context"].includes(task.reviewSummary?.status ?? "") ? "failed" : "pending",
    Repair: task.repairSummary?.outcome === "completed" ? "completed" : task.repairSummary?.outcome === "failed" ? "failed" : task.repairSummary?.outcome === "aborted" ? "aborted" : "pending",
  };
  if (["aborted", "interrupted"].includes(task.status) && execution?.tasks.some((entry) => entry.status === "running")) statuses.Execute = "aborted";
  return WORKFLOW_STEPS.map((label) => ({ label, status: task.status === "rejected" && label !== "Plan" ? "pending" : statuses[label] }));
}

export function sanitizeWorkflowProgress(value: unknown): WorkflowProgress | undefined {
  if (!Array.isArray(value) || value.length !== WORKFLOW_STEPS.length) return undefined;
  const valid = value.every((step, index) => step && step.label === WORKFLOW_STEPS[index] && ["completed", "active", "pending", "failed", "aborted", "waiting"].includes(step.status));
  return valid ? value.map((step) => ({ label: step.label, status: step.status })) : undefined;
}
