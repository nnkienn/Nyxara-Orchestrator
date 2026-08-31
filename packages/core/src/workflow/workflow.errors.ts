export type WorkflowErrorCode =
  | "workflow_not_found"
  | "invalid_workflow_input"
  | "invalid_workflow_transition"
  | "workflow_task_limit_reached";

export class WorkflowStateError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowStateError";
  }
}
