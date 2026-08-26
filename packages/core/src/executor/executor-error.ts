export type ExecutorErrorCode =
  | "executor_error"
  | "executor_not_configured"
  | "task_not_found"
  | "task_blocked"
  | "tool_call_limit_exceeded"
  | "model_turn_limit_exceeded"
  | "write_permission_denied"
  | "patch_failed"
  | "workspace_modified_unexpectedly"
  | "unsupported_tool_calling"
  | "invalid_model"
  | "invalid_execution_result";

export class ExecutorError extends Error {
  constructor(
    readonly code: ExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutorError";
  }
}
