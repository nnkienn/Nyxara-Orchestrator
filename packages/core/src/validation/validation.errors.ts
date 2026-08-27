export type ValidationErrorCode =
  | "validation_error"
  | "validation_command_not_found"
  | "validation_command_blocked"
  | "validation_timeout"
  | "validation_process_error"
  | "validation_workspace_changed"
  | "package_manager_not_found"
  | "invalid_validation_config"
  | "no_validation_commands";

export class ValidationError extends Error {
  constructor(
    readonly code: ValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
