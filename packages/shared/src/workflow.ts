export type WorkflowStatus =
  | "created"
  | "planning"
  | "awaiting_plan_approval"
  | "approved"
  | "running"
  | "planned"
  | "executing"
  | "validating"
  | "reviewing"
  | "repairing"
  | "paused"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "aborted";

export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "created",
  "planning",
  "awaiting_plan_approval",
  "approved",
  "running",
  "planned",
  "executing",
  "validating",
  "reviewing",
  "repairing",
  "paused",
  "waiting_for_permission",
  "completed",
  "failed",
  "aborted",
];

export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "completed",
  "failed",
  "aborted",
];

export type TaskRuntimeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface WorkflowError {
  readonly code: string;
  readonly message: string;
}

/**
 * Public terminal outcome. It exists because a user rejecting a plan is an
 * intentional product action, not a system failure, even though Core records
 * rejection with a terminal failed-like workflow status. Presentation layers
 * render this projection instead of inferring an outcome from `status`.
 */
export type WorkflowOutcome =
  | "completed"
  | "failed"
  | "aborted"
  | "rejected"
  | "interrupted";

/** Terminal reason code Core records when the user rejects a plan. */
export const PLAN_REJECTED_ERROR_CODE = "plan_rejected";

/**
 * Derives the public outcome from the authoritative terminal status and reason.
 * Non-terminal workflows have no outcome.
 */
export function workflowOutcome(input: {
  readonly status: WorkflowStatus;
  readonly error?: WorkflowError;
  readonly interrupted?: boolean;
}): WorkflowOutcome | undefined {
  if (input.interrupted) return "interrupted";
  switch (input.status) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "failed":
      return input.error?.code === PLAN_REJECTED_ERROR_CODE ? "rejected" : "failed";
    default:
      return undefined;
  }
}

/** Retained for existing consumers; new code should use WorkflowError. */
export interface WorkflowFailure {
  readonly message: string;
}

/**
 * Per-task rollup used by WorkflowSnapshot. Summary only: diffs, source
 * contents, validation logs, and provider payloads never belong here.
 */
export interface WorkflowTaskSnapshot {
  readonly taskId: string;
  readonly executionStatus?: TaskRuntimeStatus;
  readonly validationStatus?: "passed" | "failed";
  readonly reviewStatus?: "passed" | "failed" | "needs_more_context";
  readonly repairStatus?: string;
  readonly attempts?: number;
}

/**
 * Aggregate, bounded view of one workflow. Clients render this instead of
 * reassembling workflow state from individual events.
 */
export interface WorkflowSnapshot {
  readonly workflowId: string;
  readonly planId?: string;
  readonly status: WorkflowStatus;
  readonly currentTaskId?: string;
  readonly tasks: readonly WorkflowTaskSnapshot[];
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly error?: WorkflowError;
  readonly progress?: { readonly completed: number; readonly total: number };
  readonly failedTaskId?: string;
  readonly blockedTaskIds?: readonly string[];
  readonly plan?: {
    readonly planId: string;
    readonly status: "draft" | "approved" | "rejected";
    readonly taskCount: number;
    readonly approvedAt?: string;
  };
  readonly pauseRequested?: boolean;
  readonly pendingPermission?: PendingWorkflowPermission;
  readonly executionRetry?: { readonly planId: string; readonly taskId: string; readonly attempt: number };
  readonly usage?: import("./usage.js").WorkflowUsage;
  /** Authoritative time the current stage was entered; clients format elapsed locally. */
  readonly stageStartedAt?: string;
  /** Public terminal outcome; absent while the workflow is still active. */
  readonly outcome?: WorkflowOutcome;
  /** Stages with recorded evidence, so clients never render a stage that never ran. */
  readonly occurredStages?: readonly WorkflowStage[];
}

/** Workflow stages a client may render, gated on actual occurrence. */
export type WorkflowStage =
  | "planning"
  | "approval"
  | "execution"
  | "validation"
  | "review"
  | "repair";

export interface PendingWorkflowPermission {
  readonly id: string;
  readonly workflowId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly capability: string;
  readonly resource?: string;
  readonly command?: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
  readonly reason?: string;
  readonly requestedAt: string;
}

export interface WorkflowState {
  readonly id: string;
  readonly workspace: string;
  readonly prompt: string;
  readonly status: WorkflowStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly planId?: string;
  readonly currentTaskId?: string;
  readonly error?: WorkflowError;
  readonly progress?: { readonly completed: number; readonly total: number };
  readonly failedTaskId?: string;
  readonly blockedTaskIds?: readonly string[];
  readonly pauseRequested?: boolean;
  readonly pendingPermission?: PendingWorkflowPermission;
  /** Authoritative timestamp of the most recent status change. */
  readonly stageStartedAt?: string;
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.includes(status);
}
