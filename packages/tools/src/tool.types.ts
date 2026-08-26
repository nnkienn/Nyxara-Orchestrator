import type { PermissionRequest } from "./permissions/permission.types.js";

export interface ToolContext {
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
}

export interface Tool<TInput, TOutput> {
  readonly name: string;

  permission(input: TInput, context: ToolContext): PermissionRequest;
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
  | { readonly type: "tool.started"; readonly tool: string }
  | {
      readonly type: "tool.completed";
      readonly tool: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "tool.failed";
      readonly tool: string;
      readonly code: string;
    };

export type ToolEventObserver = (event: ToolRegistryEvent) => void;

