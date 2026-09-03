import type { ContextBundle, ContextFile } from "../context/context.types.js";
import type {
  ExecutionResult,
  ExecutorLimits,
  RepairExecutorInput,
} from "../executor/executor.types.js";
import type { PlannedTask } from "../planner/planner.types.js";
import type {
  ReviewEvidenceBudget,
  ReviewerLimits,
  ReviewResult,
} from "../review/reviewer.types.js";
import type {
  ValidationConfig,
  ValidationResult,
} from "../validation/validation.types.js";
import type { PermissionRequest } from "@nyxara/tools";
import type { ResolvedRuleSet } from "../rules/engineering-rule.js";

export type RepairReason =
  | "validation_failure"
  | "review_failure"
  | "validation_and_review_failure";

export interface RepairFinding {
  readonly source: "validation" | "review";
  readonly code?: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly severity?: string;
  readonly ruleId?: string;
}

export interface RepairValidationEvidence {
  readonly kind: string;
  readonly status: string;
  readonly code?: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly truncated: boolean;
}

export interface RepairReviewEvidence {
  readonly code?: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly severity?: string;
}

export interface RepairContextEvidence {
  readonly path: string;
  readonly content: string;
  readonly reason: string;
  readonly truncated: boolean;
}

export interface RepairEvidence {
  readonly originalTaskId: string;
  readonly currentChangedFiles: readonly string[];
  readonly validationFailures: readonly RepairValidationEvidence[];
  readonly reviewFindings: readonly RepairReviewEvidence[];
  readonly relevantContext: readonly RepairContextEvidence[];
  readonly diff?: {
    readonly content: string;
    readonly truncated: boolean;
  };
}

export interface RepairTask {
  readonly id: string;
  readonly originalTaskId: string;
  readonly cycle: number;
  readonly reason: RepairReason;
  readonly objective: string;
  readonly findings: readonly RepairFinding[];
  readonly acceptanceCriteria: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly createdAt: string;
}

export type RepairCycleStatus =
  | "pending"
  | "repairing"
  | "validating"
  | "reviewing"
  | "passed"
  | "failed"
  | "limit_reached";

export interface RepairCycleState {
  readonly taskId: string;
  readonly cycle: number;
  readonly status: RepairCycleStatus;
  readonly executorAttempts: number;
  readonly validationAttempts: number;
  readonly reviewAttempts: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface RepairCycleHistory {
  readonly cycle: number;
  readonly outcome:
    | "validation_failed"
    | "review_failed"
    | "passed"
    | "execution_failed"
    | "stalled"
    | "aborted";
  readonly findingKeys: readonly string[];
  readonly changedFiles: readonly string[];
}

export interface RepairLimits {
  readonly maxRepairCycles: number;
  readonly maxExecutorAttemptsPerTask: number;
  readonly maxValidationAttempts: number;
  readonly maxReviewAttempts: number;
  readonly maxContextExpansions: number;
  readonly maxEvidenceBytes: number;
  readonly maxDiffBytes: number;
  readonly maxHistoryEntries: number;
  readonly stuckThreshold: number;
}

export type RepairResultStatus =
  | "passed"
  | "failed"
  | "limit_reached"
  | "stalled"
  | "aborted";

export interface RepairResult {
  readonly taskId: string;
  readonly status: RepairResultStatus;
  readonly cycles: number;
  readonly executorAttempts: number;
  readonly validationAttempts: number;
  readonly reviewAttempts: number;
  readonly finalExecution: ExecutionResult;
  readonly finalValidation?: ValidationResult;
  readonly finalReview?: ReviewResult;
  readonly remainingFindings?: readonly RepairFinding[];
  readonly changedFiles: readonly string[];
  readonly history: readonly RepairCycleHistory[];
  readonly completedAt: string;
}

export interface RepairWorkflowInput {
  readonly workflowId?: string;
  readonly requirement: string;
  readonly objective: string;
  readonly originalTask: PlannedTask;
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
  readonly engineeringRules?: ResolvedRuleSet;
}

export interface RepairValidateRequest {
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly config?: ValidationConfig;
  readonly signal?: AbortSignal;
}

export interface RepairReviewRequest {
  readonly requirement: string;
  readonly objective: string;
  readonly task: PlannedTask;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly executorContext: ContextBundle;
  readonly plannerContext?: ContextBundle;
  readonly evidenceBudget?: Partial<ReviewEvidenceBudget>;
  readonly limits?: Partial<ReviewerLimits>;
  readonly signal?: AbortSignal;
  readonly engineeringRules?: ResolvedRuleSet;
}

export interface RepairContextRequest {
  readonly workspaceRoot: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * Core-owned collaborators the repair loop reuses. Validation and Review are
 * injected so the loop never re-enters Planner or repository discovery.
 */
export interface RepairOperations {
  validate(request: RepairValidateRequest): Promise<ValidationResult>;
  review(request: RepairReviewRequest): Promise<ReviewResult>;
  expandContext?(request: RepairContextRequest): Promise<readonly ContextFile[]>;
}

export type { RepairExecutorInput };
