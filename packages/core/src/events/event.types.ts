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

export interface PlannerStartedEvent {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextFileCount: number;
}

export interface PlannerCompletedEvent {
  readonly planId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly taskCount: number;
}

export interface PlannerFailedEvent {
  readonly providerId: string;
  readonly modelId: string;
  readonly code: string;
}

export interface PlanValidationStartedEvent {
  readonly providerId: string;
  readonly modelId: string;
}

export interface PlanValidationFailedEvent extends PlanValidationStartedEvent {
  readonly code: string;
}

export interface PlanValidationPassedEvent {
  readonly planId: string;
  readonly taskCount: number;
}

export interface ExecutorStartedEvent {
  readonly taskId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly attempt: number;
  readonly contextFileCount: number;
}

export interface ExecutorCompletedEvent {
  readonly taskId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly changedFileCount: number;
  readonly toolCalls: number;
  readonly modelTurns: number;
}

export interface ExecutorFailedEvent {
  readonly taskId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly code: string;
}

export interface TaskExecutionStartedEvent {
  readonly taskId: string;
  readonly attempt: number;
}

export interface TaskExecutionCompletedEvent extends TaskExecutionStartedEvent {
  readonly changedFileCount: number;
}

export interface TaskExecutionFailedEvent extends TaskExecutionStartedEvent {
  readonly code: string;
}

export interface FileWriteEvent {
  readonly path: string;
}

export interface PatchEvent {
  readonly paths: readonly string[];
}

export interface PatchFailedEvent extends PatchEvent {
  readonly code: string;
}

export interface ValidationStartedEvent {
  readonly workspaceRoot: string;
  readonly planId?: string;
  readonly taskId?: string;
}

export interface ValidationStepEvent {
  readonly kind: "typecheck" | "lint" | "test" | "build";
  readonly status: "passed" | "failed" | "skipped" | "timed_out" | "errored";
  readonly durationMs: number;
  readonly command?: readonly string[];
  readonly exitCode?: number;
  readonly errorCode?: string;
}

export interface ValidationStepStartedEvent {
  readonly kind: "typecheck" | "lint" | "test" | "build";
  readonly command: readonly string[];
}

export interface ValidationCompletedEvent {
  readonly durationMs: number;
  readonly stepCount: number;
}

export interface ValidationFailedEvent {
  readonly durationMs: number;
  readonly errorCode: string;
  readonly failedKinds: readonly ("typecheck" | "lint" | "test" | "build")[];
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
  readonly "planner.started": PlannerStartedEvent;
  readonly "planner.completed": PlannerCompletedEvent;
  readonly "planner.failed": PlannerFailedEvent;
  readonly "plan.validation_started": PlanValidationStartedEvent;
  readonly "plan.validation_failed": PlanValidationFailedEvent;
  readonly "plan.validation_passed": PlanValidationPassedEvent;
  readonly "executor.started": ExecutorStartedEvent;
  readonly "executor.completed": ExecutorCompletedEvent;
  readonly "executor.failed": ExecutorFailedEvent;
  readonly "task.execution_started": TaskExecutionStartedEvent;
  readonly "task.execution_completed": TaskExecutionCompletedEvent;
  readonly "task.execution_failed": TaskExecutionFailedEvent;
  readonly "file.write_started": FileWriteEvent;
  readonly "file.write_completed": FileWriteEvent;
  readonly "patch.started": PatchEvent;
  readonly "patch.completed": PatchEvent;
  readonly "patch.failed": PatchFailedEvent;
  readonly "validation.started": ValidationStartedEvent;
  readonly "validation.completed": ValidationCompletedEvent;
  readonly "validation.failed": ValidationFailedEvent;
  readonly "validation.step_started": ValidationStepStartedEvent;
  readonly "validation.step_passed": ValidationStepEvent;
  readonly "validation.step_failed": ValidationStepEvent;
  readonly "validation.step_skipped": ValidationStepEvent;
  readonly "validation.step_timed_out": ValidationStepEvent;
}
