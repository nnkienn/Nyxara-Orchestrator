import type { ModelProvider } from "@nyxara/provider-sdk";
import type { ToolRegistry } from "@nyxara/tools";
import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ContextBundle } from "../context/context.types.js";
import type {
  ExecutionResult,
  ExecutorLimits,
} from "../executor/executor.types.js";
import type { ExecutionPlan } from "../planner/planner.types.js";
import type { RepairLimits, RepairResult } from "../repair/repair.types.js";
import type {
  ReviewerLimits,
  ReviewEvidenceBudget,
  ReviewResult,
} from "../review/reviewer.types.js";
import type {
  ValidationConfig,
  ValidationResult,
} from "../validation/validation.types.js";

export interface RunInput {
  readonly workspace: string;
  readonly prompt: string;
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
}

export type RepairTaskResult = RepairResult;
