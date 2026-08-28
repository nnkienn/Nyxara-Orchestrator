import type { ModelProvider } from "@nyxara/provider-sdk";
import type { ToolRegistry } from "@nyxara/tools";
import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ExecutorLimits } from "../executor/executor.types.js";
import type { ValidationConfig } from "../validation/validation.types.js";
import type {
  ReviewerLimits,
  ReviewEvidenceBudget,
} from "../review/reviewer.types.js";

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
}

export interface ModelGenerateInput {
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
}
