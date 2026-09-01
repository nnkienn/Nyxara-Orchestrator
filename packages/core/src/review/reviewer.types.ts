import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ContextBundle } from "../context/context.types.js";
import type { ExecutionResult } from "../executor/executor.types.js";
import type { PlannedTask } from "../planner/planner.types.js";
import type { ResolvedRuleSet } from "../rules/engineering-rule.js";
import type {
  ValidationKind,
  ValidationResult,
  ValidationStepStatus,
} from "../validation/validation.types.js";

export type ReviewStatus = "passed" | "failed" | "needs_more_context";
export type ReviewFindingSeverity = "info" | "warning" | "error" | "critical";
export type ReviewFindingCategory =
  | "correctness"
  | "requirement"
  | "architecture"
  | "security"
  | "maintainability"
  | "performance"
  | "testing";
export type ReviewCriterionStatus = "satisfied" | "unsatisfied" | "uncertain";

export interface ReviewEvidenceBudget {
  readonly maxDiffBytes: number;
  readonly maxContextFiles: number;
  readonly maxContextBytes: number;
  readonly maxBytesPerContextFile: number;
  readonly maxValidationBytes: number;
  readonly maxContextExpansions: number;
}

export interface ReviewDiffEvidence {
  readonly files: readonly string[];
  readonly content: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

export interface ReviewValidationStepEvidence {
  readonly kind: ValidationKind;
  readonly status: ValidationStepStatus;
  readonly required: boolean;
  readonly exitCode?: number;
  readonly summary: string;
  readonly errorExcerpt?: string;
  readonly truncated?: boolean;
}

export interface ReviewValidationEvidence {
  readonly status: "passed" | "failed";
  readonly steps: readonly ReviewValidationStepEvidence[];
  readonly truncated: boolean;
}

export interface ReviewContextEvidence {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly reason?: string;
  readonly truncated: boolean;
}

export interface ReviewEvidenceBundle {
  readonly requirement: string;
  readonly objective: string;
  readonly task: PlannedTask;
  readonly acceptanceCriteria: readonly string[];
  readonly changedFiles: readonly string[];
  readonly diff: ReviewDiffEvidence;
  readonly validation: ReviewValidationEvidence;
  readonly context: readonly ReviewContextEvidence[];
  readonly executorSummary?: string;
  readonly truncated: boolean;
}

export interface ReviewContextRequest {
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly reasons: readonly string[];
}

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewFindingSeverity;
  readonly category: ReviewFindingCategory;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly taskId?: string;
  readonly ruleId?: string;
}

export type RuleEvaluationStatus = "satisfied" | "violated" | "not_applicable" | "uncertain";
export interface RuleEvaluation { readonly ruleId: string; readonly status: RuleEvaluationStatus; readonly evidence?: string | undefined; }

export interface ReviewCriterionResult {
  readonly criterion: string;
  readonly status: ReviewCriterionStatus;
  readonly reason: string;
}

export interface ReviewResult {
  readonly status: ReviewStatus;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly criteria: readonly ReviewCriterionResult[];
  readonly ruleEvaluations?: readonly RuleEvaluation[];
  readonly risks?: readonly string[];
  readonly contextRequest?: ReviewContextRequest;
  readonly reviewedAt: string;
}

export interface ReviewerInput {
  readonly requirement: string;
  readonly objective: string;
  readonly task: PlannedTask;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly evidence: ReviewEvidenceBundle;
  readonly engineeringRules?: ResolvedRuleSet;
}

export interface ReviewEvidenceInput {
  readonly requirement: string;
  readonly objective: string;
  readonly task: PlannedTask;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly contexts: readonly ContextBundle[];
  readonly budget?: Partial<ReviewEvidenceBudget>;
}

export interface ReviewerLimits {
  readonly maxReviewerTurns: number;
  readonly maxContextExpansions: number;
}

export interface ReviewContextExpansion {
  readonly evidence: ReviewEvidenceBundle;
  readonly fileCount: number;
  readonly contextBytes: number;
}

export interface ReviewerRunInput {
  readonly input: ReviewerInput;
  readonly model: AgentModelConfig;
  readonly limits?: Partial<ReviewerLimits>;
  readonly signal?: AbortSignal;
  readonly expandContext?: (
    request: ReviewContextRequest,
    evidence: ReviewEvidenceBundle,
  ) => Promise<ReviewContextExpansion>;
}

export interface ReviewerRunResult {
  readonly result: ReviewResult;
  readonly evidence: ReviewEvidenceBundle;
  readonly turns: number;
  readonly contextExpansions: number;
}

export interface ReviewTaskInput {
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

export interface ReviewTaskResult extends ReviewerRunResult {
  readonly model: AgentModelConfig;
}
