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

export interface NyxaraEventMap {
  readonly "workflow.started": WorkflowStartedEvent;
  readonly "workflow.completed": WorkflowCompletedEvent;
  readonly "workflow.failed": WorkflowFailedEvent;
  readonly "provider.registered": ProviderRegisteredEvent;
  readonly "provider.models.completed": ProviderModelsCompletedEvent;
  readonly "provider.generation.completed": ProviderGenerationCompletedEvent;
  readonly "provider.operation.failed": ProviderOperationFailedEvent;
}
