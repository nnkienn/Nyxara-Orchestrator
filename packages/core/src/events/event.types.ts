import type {
  GenerateUsage,
  ModelInfo,
  ProviderInfo,
} from "@nyxara/provider-sdk";
import type { WorkflowStatus } from "@nyxara/shared";

export interface WorkflowStartedEvent {
  readonly workflowId: string;
  readonly startedAt: string;
}

export interface WorkflowStatusChangedEvent {
  readonly workflowId: string;
  readonly from: WorkflowStatus;
  readonly to: WorkflowStatus;
  readonly planId?: string;
  readonly currentTaskId?: string;
}

export interface WorkflowTaskEvent {
  readonly workflowId: string;
  readonly taskId: string;
  readonly attempt: number;
}

export interface WorkflowTaskFailedEvent extends WorkflowTaskEvent {
  readonly code: string;
}

export interface WorkflowTaskSelectedEvent {
  readonly workflowId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly completedCount: number;
  readonly total: number;
}

export interface WorkflowTaskBlockedEvent {
  readonly workflowId: string;
  readonly planId: string;
  readonly taskId: string;
}

export interface WorkflowCompletedEvent {
  readonly workflowId: string;
  readonly taskCount: number;
}

export interface WorkflowFailedEvent {
  readonly workflowId: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkflowAbortedEvent {
  readonly workflowId: string;
}

export interface WorkflowRuntimeEvent { readonly workflowId: string; }
export interface WorkflowPermissionRequestedEvent {
  readonly workflowId: string; readonly taskId: string; readonly permissionRequestId: string;
  readonly capability: string; readonly resource?: string;
}
export interface WorkflowPermissionDecisionEvent extends WorkflowPermissionRequestedEvent { readonly decision: "allow" | "deny"; }

export interface ProviderRegisteredEvent {
  readonly provider: ProviderInfo;
}

export interface ProviderModelsCompletedEvent {
  readonly providerId: string;
  readonly models: readonly ModelInfo[];
}

export interface ProviderGenerationCompletedEvent {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly role?: "planner" | "executor" | "reviewer" | "repair";
  readonly taskId?: string;
  readonly workflowId?: string;
  readonly providerDurationMs?: number;
  readonly providerReportedCost?: number;
  readonly currency?: string;
  readonly responseId?: string;
  readonly finishReason?: string;
  readonly textLength: number;
  readonly toolCallCount: number;
  readonly contextBytes?: number | null;
  readonly contextFiles?: number | null;
  readonly contextTruncated?: boolean | null;
  readonly usage?: GenerateUsage;
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

export interface PlannerProfileResolvedEvent {
  readonly profileId: string;
  readonly locale?: string;
  readonly outputLanguage: string;
  readonly planStyle: "concise" | "balanced" | "detailed";
  readonly riskMode: "fast" | "balanced" | "conservative";
}
export interface RulesResolvedEvent { readonly ruleCount: number; readonly ruleSetFingerprint: string; readonly taskId?: string; readonly violatedCount?: number; readonly errorViolationCount?: number; }

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

export interface PlanApprovalEvent {
  readonly workflowId: string;
  readonly planId: string;
  readonly taskCount: number;
  readonly timestamp: string;
  readonly status: "draft" | "approved" | "rejected";
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
  readonly toolDurationMs?: number;
  readonly modelTurns: number;
  readonly workflowId?: string;
  readonly successfulToolCalls?: number;
  readonly failedToolCalls?: number;
  readonly invalidToolCalls?: number;
  readonly toolCallsByName?: Readonly<Record<string, number>>;
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

export interface ReviewerStartedEvent {
  readonly taskId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly diffBytes: number;
  readonly contextBytes: number;
}

export interface ReviewerCompletedEvent {
  readonly taskId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: "passed" | "failed";
  readonly findingCount: number;
  readonly durationMs: number;
  readonly turns: number;
  readonly contextExpansions: number;
}

export interface ReviewerFailedEvent {
  readonly taskId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly code: string;
  readonly durationMs: number;
}

export interface ReviewValidationStartedEvent {
  readonly taskId: string;
}

export interface ReviewValidationPassedEvent extends ReviewValidationStartedEvent {
  readonly status: "passed" | "failed" | "needs_more_context";
  readonly criterionCount: number;
}

export interface ReviewValidationFailedEvent extends ReviewValidationStartedEvent {
  readonly code: string;
}

export interface ReviewContextRequestedEvent extends ReviewValidationStartedEvent {
  readonly pathCount: number;
  readonly symbolCount: number;
  readonly reasonCount: number;
}

export interface ReviewContextExpandedEvent extends ReviewValidationStartedEvent {
  readonly fileCount: number;
  readonly contextBytes: number;
  readonly expansion: number;
}

export interface RepairEvent {
  readonly taskId: string;
  readonly cycle?: number;
  readonly status?: string;
  readonly repairTaskId?: string;
  readonly attempt?: number;
  readonly changedFileCount?: number;
  readonly findingCount?: number;
  readonly reason?: string;
}
export interface UsageEvent { readonly workflowId: string; }

export interface NyxaraEventMap {
  readonly "workflow.started": WorkflowStartedEvent;
  readonly "workflow.status_changed": WorkflowStatusChangedEvent;
  readonly "workflow.task_started": WorkflowTaskEvent;
  readonly "workflow.task_completed": WorkflowTaskEvent;
  readonly "workflow.task_failed": WorkflowTaskFailedEvent;
  readonly "workflow.task_selected": WorkflowTaskSelectedEvent;
  readonly "workflow.task_blocked": WorkflowTaskBlockedEvent;
  readonly "workflow.completed": WorkflowCompletedEvent;
  readonly "workflow.failed": WorkflowFailedEvent;
  readonly "workflow.aborted": WorkflowAbortedEvent;
  readonly "workflow.pause_requested": WorkflowRuntimeEvent;
  readonly "workflow.paused": WorkflowRuntimeEvent;
  readonly "workflow.resumed": WorkflowRuntimeEvent;
  readonly "workflow.permission_requested": WorkflowPermissionRequestedEvent;
  readonly "workflow.permission_allowed": WorkflowPermissionDecisionEvent;
  readonly "workflow.permission_denied": WorkflowPermissionDecisionEvent;
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
  readonly "planner.profile_resolved": PlannerProfileResolvedEvent;
  readonly "rules.resolved": RulesResolvedEvent;
  readonly "planner.completed": PlannerCompletedEvent;
  readonly "planner.failed": PlannerFailedEvent;
  readonly "plan.validation_started": PlanValidationStartedEvent;
  readonly "plan.validation_failed": PlanValidationFailedEvent;
  readonly "plan.validation_passed": PlanValidationPassedEvent;
  readonly "plan.awaiting_approval": PlanApprovalEvent;
  readonly "plan.approved": PlanApprovalEvent;
  readonly "plan.rejected": PlanApprovalEvent;
  readonly "plan.draft_replaced": PlanApprovalEvent;
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
  readonly "reviewer.started": ReviewerStartedEvent;
  readonly "reviewer.completed": ReviewerCompletedEvent;
  readonly "reviewer.failed": ReviewerFailedEvent;
  readonly "review.validation_started": ReviewValidationStartedEvent;
  readonly "review.validation_passed": ReviewValidationPassedEvent;
  readonly "review.validation_failed": ReviewValidationFailedEvent;
  readonly "review.context_requested": ReviewContextRequestedEvent;
  readonly "review.context_expanded": ReviewContextExpandedEvent;
  readonly "repair.started": RepairEvent;
  readonly "repair.cycle_started": RepairEvent;
  readonly "repair.task_created": RepairEvent;
  readonly "repair.execution_started": RepairEvent;
  readonly "repair.execution_completed": RepairEvent;
  readonly "repair.validation_started": RepairEvent;
  readonly "repair.validation_failed": RepairEvent;
  readonly "repair.validation_passed": RepairEvent;
  readonly "repair.review_started": RepairEvent;
  readonly "repair.review_failed": RepairEvent;
  readonly "repair.review_passed": RepairEvent;
  readonly "repair.stalled": RepairEvent;
  readonly "repair.limit_reached": RepairEvent;
  readonly "repair.completed": RepairEvent;
  readonly "repair.failed": RepairEvent;
  readonly "usage.updated": UsageEvent;
  readonly "usage.finalized": UsageEvent;
}
