import type {
  TaskRuntimeStatus,
  WorkflowStatus,
} from "@nyxara/shared";

export interface StartWorkflowInput {
  readonly workspace: string;
  readonly prompt: string;
}

/**
 * Retention bounds for Core-owned workflow state. Workflow state is a summary
 * projection, so the bounds exist to stop unbounded growth over a long session
 * rather than to cap evidence size.
 */
export interface WorkflowLimits {
  readonly maxWorkflows: number;
  readonly maxTasksPerWorkflow: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxWorkflows: 20,
  maxTasksPerWorkflow: 200,
};

export type WorkflowTaskRepairStatus =
  | "passed"
  | "failed"
  | "stalled"
  | "limit_reached"
  | "aborted";

export interface WorkflowTaskRecord {
  readonly taskId: string;
  readonly executionStatus?: TaskRuntimeStatus;
  readonly validationStatus?: "passed" | "failed";
  readonly reviewStatus?: "passed" | "failed" | "needs_more_context";
  readonly repairStatus?: WorkflowTaskRepairStatus;
  readonly attempts?: number;
}

export interface WorkflowTransitionInput {
  readonly planId?: string;
  readonly currentTaskId?: string | null;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly progress?: { readonly completed: number; readonly total: number };
  readonly failedTaskId?: string | null;
  readonly blockedTaskIds?: readonly string[];
  readonly pauseRequested?: boolean;
  readonly pendingPermission?: import("@nyxara/shared").PendingWorkflowPermission | null;
}

/**
 * The only legal workflow transitions. `executing -> running` supports a
 * completed read-only task that correctly skips Validation and Review.
 * `validating -> executing` and `reviewing -> executing` let Core move to the next task;
 * `repairing` is reachable from validation or review failure and returns to
 * validation, which keeps validation-first authority explicit.
 */
export const WORKFLOW_TRANSITIONS: Readonly<
  Record<WorkflowStatus, readonly WorkflowStatus[]>
> = {
  created: ["planning", "failed", "aborted"],
  planning: ["awaiting_plan_approval", "planned", "failed", "aborted"],
  awaiting_plan_approval: ["approved", "failed", "aborted"],
  approved: ["running", "executing", "completed", "failed", "aborted"],
  running: ["executing", "validating", "reviewing", "repairing", "running", "paused", "waiting_for_permission", "completed", "failed", "aborted"],
  planned: ["executing", "completed", "failed", "aborted"],
  executing: ["running", "validating", "paused", "waiting_for_permission", "failed", "aborted"],
  validating: ["reviewing", "repairing", "executing", "running", "paused", "waiting_for_permission", "completed", "failed", "aborted"],
  reviewing: ["repairing", "executing", "running", "paused", "waiting_for_permission", "completed", "failed", "aborted"],
  repairing: ["validating", "executing", "running", "paused", "waiting_for_permission", "completed", "failed", "aborted"],
  paused: ["running", "aborted"],
  waiting_for_permission: ["running", "failed", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
};
