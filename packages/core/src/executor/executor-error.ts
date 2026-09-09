export type ExecutorErrorCode =
  | "executor_error"
  | "executor_aborted"
  | "executor_not_configured"
  | "task_not_found"
  | "task_blocked"
  | "invalid_task_transition"
  | "task_limit_reached"
  | "tool_call_limit_exceeded"
  | "read_tool_limit_exceeded"
  | "mutating_tool_limit_exceeded"
  | "validation_tool_limit_exceeded"
  | "model_turn_limit_exceeded"
  | "provider_call_limit_exceeded"
  | "executor_context_limit_exceeded"
  | "executor_total_input_limit_exceeded"
  | "executor_stalled"
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
