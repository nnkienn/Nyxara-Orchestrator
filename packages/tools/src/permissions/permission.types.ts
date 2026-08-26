import type { CommandRequest } from "../execution/execution.types.js";

export type PermissionDecision = "allow" | "ask" | "deny";

export type ToolCapability =
  | "read_workspace_file"
  | "list_workspace_directory"
  | "search_workspace"
  | "git_status"
  | "git_diff"
  | "run_command"
  | "write_workspace_file"
  | "delete_workspace_file"
  | "outside_workspace"
  | "sudo"
  | "git_push"
  | "production_deploy";

export interface PermissionRequest {
  readonly capability: ToolCapability;
  readonly workspaceRoot: string;
  readonly resource?: string;
  readonly command?: CommandRequest;
}

export interface PermissionEngine {
  evaluate(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface DefaultPermissionPolicy {
  readonly safeCommand?: PermissionDecision;
  readonly unknownCommand?: PermissionDecision;
  readonly writeWorkspaceFile?: PermissionDecision;
}

