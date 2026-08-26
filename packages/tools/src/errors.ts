export type ToolErrorCode =
  | "tool_error"
  | "permission_error"
  | "permission_required"
  | "write_permission_denied"
  | "workspace_error"
  | "path_outside_workspace"
  | "file_not_found"
  | "command_timeout"
  | "command_blocked"
  | "context_error"
  | "git_error"
  | "patch_failed"
  | "file_too_large";

export class NyxaraToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly tool?: string,
  ) {
    super(message);
    this.name = "NyxaraToolError";
  }
}

export type ToolRegistryErrorCode = "duplicate_tool" | "unknown_tool";

export class ToolRegistryError extends Error {
  constructor(
    readonly code: ToolRegistryErrorCode,
    readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRegistryError";
  }
}
