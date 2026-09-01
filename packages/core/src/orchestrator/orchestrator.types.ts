import type { ModelProvider } from "@nyxara/provider-sdk";
import type { PermissionRequest, ToolRegistry } from "@nyxara/tools";
import type { PendingWorkflowPermission, WorkflowSnapshot } from "@nyxara/shared";
import type { AgentModelConfig } from "../agents/agent.types.js";
import type {
  ContextBudget,
  ContextBundle,
} from "../context/context.types.js";
import type {
  ExecutionResult,
  ExecutorLimits,
} from "../executor/executor.types.js";
import type { ExecutionPlan } from "../planner/planner.types.js";
import type { PlanningProfile } from "../planner/planning-profile.js";
import type { EngineeringRule } from "../rules/engineering-rule.js";
import type { RepairLimits, RepairResult } from "../repair/repair.types.js";
import type {
  ReviewerLimits,
  ReviewEvidenceBudget,
  ReviewEvidenceBundle,
  ReviewResult,
} from "../review/reviewer.types.js";
import type {
  ValidationConfig,
  ValidationResult,
} from "../validation/validation.types.js";
import type { WorkflowLimits } from "../workflow/workflow.types.js";

export interface StartWorkflowInput {
  readonly workspace: string;
  readonly prompt: string;
}

/** @deprecated Use StartWorkflowInput; retained for source compatibility. */
export type RunInput = StartWorkflowInput;

export interface RunTaskPipelineInput {
  readonly workflowId?: string;
  readonly requirement: string;
  readonly plan: ExecutionPlan;
  readonly taskId: string;
  readonly workspaceRoot: string;
  readonly plannerContext?: ContextBundle;
  readonly contextBudget?: Partial<ContextBudget>;
  readonly executorLimits?: Partial<ExecutorLimits>;
  readonly validation?: ValidationConfig;
  readonly reviewEvidenceBudget?: Partial<ReviewEvidenceBudget>;
  readonly reviewerLimits?: Partial<ReviewerLimits>;
  readonly repairLimits?: Partial<RepairLimits>;
  /** Enables the bounded repair loop when validation or review fails. */
  readonly allowRepair?: boolean;
  readonly signal?: AbortSignal;
  readonly resolvePermission?: (request: PermissionRequest) => Promise<"allow" | "deny">;
  readonly engineeringRules?: import("../rules/engineering-rule.js").ResolvedRuleSet;
}

export type TaskPipelineStatus = "passed" | "failed";

export interface AutonomousWorkflowResult {
  readonly workflowId: string;
  readonly planId: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly completedTaskIds: readonly string[];
  readonly failedTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly changedFiles: readonly string[];
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly repairCycles: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly failure?: { readonly taskId?: string; readonly code: string; readonly message: string };
}

export type WorkflowRunOutcome =
  | AutonomousWorkflowResult
  | { readonly status: "paused"; readonly snapshot: WorkflowSnapshot }
  | { readonly status: "waiting_for_permission"; readonly snapshot: WorkflowSnapshot; readonly permission: PendingWorkflowPermission };

export interface ResolveWorkflowPermissionInput {
  readonly workflowId: string;
  readonly permissionRequestId: string;
  readonly decision: "allow" | "deny";
}

export interface TaskPipelineResult {
  readonly status: TaskPipelineStatus;
  readonly taskId: string;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly review?: ReviewResult;
  readonly repair?: RepairResult;
  readonly executorContext: ContextBundle;
  /** Bounded evidence the Reviewer actually saw; absent when review was skipped. */
  readonly reviewEvidence?: ReviewEvidenceBundle;
  /** True when validation failed, which forbids calling the Reviewer. */
  readonly reviewSkipped: boolean;
}

export interface NyxaraOrchestratorConfig {
  readonly providers?: readonly ModelProvider[];
  readonly toolRegistry?: ToolRegistry;
  readonly agents?: readonly AgentModelConfig[];
  readonly executorLimits?: Partial<ExecutorLimits>;
  readonly validation?: ValidationConfig;
  readonly reviewEvidenceBudget?: Partial<ReviewEvidenceBudget>;
  readonly reviewerLimits?: Partial<ReviewerLimits>;
  readonly repairLimits?: Partial<RepairLimits>;
  readonly workflowLimits?: Partial<WorkflowLimits>;
  /** Validated process-local custom profiles, in addition to built-in presets. */
  readonly planningProfiles?: readonly PlanningProfile[];
  /** Additional process-local global engineering rules. */
  readonly engineeringRules?: readonly EngineeringRule[];
}

export interface ModelGenerateInput {
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
}

export interface RepairTaskInput {
  readonly requirement: string;
  readonly objective: string;
  readonly plan: ExecutionPlan;
  readonly taskId: string;
  readonly workspaceRoot: string;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly review?: ReviewResult;
  readonly executorContext: ContextBundle;
  readonly plannerContext?: ContextBundle;
  readonly validationConfig?: ValidationConfig;
  readonly executorLimits?: Partial<ExecutorLimits>;
  readonly reviewerLimits?: Partial<ReviewerLimits>;
  readonly reviewEvidenceBudget?: Partial<ReviewEvidenceBudget>;
  readonly limits?: Partial<RepairLimits>;
  readonly signal?: AbortSignal;
  readonly resolvePermission?: (request: PermissionRequest) => Promise<"allow" | "deny">;
  readonly checkpoint?: () => Promise<void>;
  readonly engineeringRules?: import("../rules/engineering-rule.js").ResolvedRuleSet;
}

export type RepairTaskResult = RepairResult;
