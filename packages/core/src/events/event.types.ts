import type {
  GenerateResponse,
  ModelInfo,
  ProviderInfo,
} from "@nyxara/provider-sdk";
import type { WorkflowState } from "@nyxara/shared";

export interface WorkflowStartedEvent {
  readonly workflow: WorkflowState;
}

export interface WorkflowCompletedEvent {
  readonly workflow: WorkflowState;
}

export interface WorkflowFailedEvent {
  readonly workflow: WorkflowState | null;
  readonly error: {
    readonly message: string;
  };
}

export interface ProviderRegisteredEvent {
  readonly provider: ProviderInfo;
}

export interface ProviderModelsCompletedEvent {
  readonly providerId: string;
  readonly models: readonly ModelInfo[];
}

export interface ProviderGenerationCompletedEvent {
  readonly providerId: string;
  readonly response: GenerateResponse;
}

export interface ProviderOperationFailedEvent {
  readonly providerId: string;
  readonly operation: "list_models" | "generate";
  readonly error: {
    readonly message: string;
  };
}

export interface ToolStartedEvent {
  readonly tool: string;
}

export interface ToolCompletedEvent {
  readonly tool: string;
  readonly durationMs: number;
}

export interface ToolFailedEvent {
  readonly tool: string;
  readonly code: string;
}

export interface PermissionRequestedEvent {
  readonly tool: string;
  readonly capability: string;
  readonly resource?: string;
  readonly command?: string;
}

export interface PermissionDecisionEvent {
  readonly tool: string;
  readonly capability: string;
}

export interface ContextStartedEvent {
  readonly workspaceRoot: string;
  readonly promptLength: number;
}

export interface ContextCompletedEvent {
  readonly workspaceRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

export interface ContextTruncatedEvent {
  readonly workspaceRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ContextFailedEvent {
  readonly workspaceRoot: string;
  readonly code: string;
}

export interface NyxaraEventMap {
  readonly "workflow.started": WorkflowStartedEvent;
  readonly "workflow.completed": WorkflowCompletedEvent;
  readonly "workflow.failed": WorkflowFailedEvent;
  readonly "provider.registered": ProviderRegisteredEvent;
  readonly "provider.models.completed": ProviderModelsCompletedEvent;
  readonly "provider.generation.completed": ProviderGenerationCompletedEvent;
  readonly "provider.operation.failed": ProviderOperationFailedEvent;
  readonly "permission.requested": PermissionRequestedEvent;
  readonly "permission.allowed": PermissionDecisionEvent;
  readonly "permission.denied": PermissionDecisionEvent;
  readonly "tool.started": ToolStartedEvent;
  readonly "tool.completed": ToolCompletedEvent;
  readonly "tool.failed": ToolFailedEvent;
  readonly "context.started": ContextStartedEvent;
  readonly "context.completed": ContextCompletedEvent;
  readonly "context.truncated": ContextTruncatedEvent;
  readonly "context.failed": ContextFailedEvent;
}
