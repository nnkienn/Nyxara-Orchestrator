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
  readonly usage?: import("./usage.js").WorkflowUsage;
}

export interface PendingWorkflowPermission {
  readonly id: string;
  readonly workflowId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly capability: string;
  readonly resource?: string;
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
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.includes(status);
}
