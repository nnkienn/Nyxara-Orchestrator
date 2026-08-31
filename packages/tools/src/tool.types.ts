import type { PermissionDecision, PermissionRequest } from "./permissions/permission.types.js";

export interface ToolContext {
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  /** Core-only cooperative continuation hook for a policy `ask` decision. */
  readonly resolvePermission?: (request: PermissionRequest) => Promise<Exclude<PermissionDecision, "ask">>;
}

export interface Tool<TInput, TOutput> {
  readonly name: string;

  permission(
    input: TInput,
    context: ToolContext,
  ):
    | PermissionRequest
    | readonly PermissionRequest[]
    | Promise<PermissionRequest | readonly PermissionRequest[]>;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export type ToolRegistryEvent =
  | {
      readonly type: "permission.requested";
      readonly tool: string;
      readonly capability: string;
      readonly resource?: string;
      readonly command?: string;
    }
  | {
      readonly type: "permission.allowed" | "permission.denied";
      readonly tool: string;
      readonly capability: string;
    }
  | {
      readonly type: "tool.started";
      readonly tool: string;
      readonly resources?: readonly string[];
    }
  | {
      readonly type: "tool.completed";
      readonly tool: string;
      readonly durationMs: number;
      readonly resources?: readonly string[];
    }
  | {
      readonly type: "tool.failed";
      readonly tool: string;
      readonly code: string;
      readonly resources?: readonly string[];
    };

export type ToolEventObserver = (event: ToolRegistryEvent) => void;
