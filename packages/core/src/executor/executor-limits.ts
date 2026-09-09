import { ExecutorError } from "./executor-error.js";
import type { ExecutorLimits } from "./executor.types.js";

/** Fully resolved, provider-neutral limits for one Executor attempt. */
export interface ResolvedExecutorLimits {
  readonly maxToolCallsPerTask: number;
  readonly maxReadToolCallsPerTask: number;
  readonly maxMutatingToolCallsPerTask: number;
  readonly maxValidationToolCallsPerTask: number;
  readonly maxProviderCallsPerTask: number;
  readonly maxToolResultBytes: number;
  readonly maxToolArgumentBytes: number;
  readonly maxRetainedEvidenceBytes: number;
  readonly maxExecutorContextBytes: number;
  readonly maxCarryoverContextBytes: number;
  readonly maxEstimatedInputTokens: number;
  readonly maxTotalEstimatedInputTokens: number;
  readonly maxSearchResults: number;
  readonly maxSearchFileBytes: number;
  readonly maxDirectoryDepth: number;
  readonly maxAssistantMessageBytes: number;
  readonly maxConsecutiveNoProgressToolCalls: number;
  readonly maxNoProgressModelTurns: number;
}

/**
 * Normal tuning defaults. They are configurable through Core's ExecutorLimits
 * domain, not provider/model or Workflow UI settings.
 */
export const DEFAULT_EXECUTOR_LIMITS: ResolvedExecutorLimits = Object.freeze({
  maxToolCallsPerTask: 96,
  maxReadToolCallsPerTask: 72,
  maxMutatingToolCallsPerTask: 16,
  maxValidationToolCallsPerTask: 12,
  maxProviderCallsPerTask: 16,
  maxToolResultBytes: 24 * 1024,
  maxToolArgumentBytes: 256 * 1024,
  maxRetainedEvidenceBytes: 64 * 1024,
  maxExecutorContextBytes: 192 * 1024,
  maxCarryoverContextBytes: 32 * 1024,
  maxEstimatedInputTokens: 48 * 1024,
  maxTotalEstimatedInputTokens: 256 * 1024,
  maxSearchResults: 20,
  maxSearchFileBytes: 256 * 1024,
  maxDirectoryDepth: 4,
  maxAssistantMessageBytes: 2 * 1024,
  maxConsecutiveNoProgressToolCalls: 6,
  maxNoProgressModelTurns: 3,
});

/**
 * Non-configurable hard ceilings. These protect the host even when an embedding
 * client supplies unsafe ExecutorLimits.
 */
export const EXECUTOR_SAFETY_CEILINGS: ResolvedExecutorLimits = Object.freeze({
  maxToolCallsPerTask: 512,
  maxReadToolCallsPerTask: 512,
  maxMutatingToolCallsPerTask: 512,
  maxValidationToolCallsPerTask: 512,
  maxProviderCallsPerTask: 64,
  maxToolResultBytes: 64 * 1024,
  maxToolArgumentBytes: 1024 * 1024,
  maxRetainedEvidenceBytes: 256 * 1024,
  maxExecutorContextBytes: 512 * 1024,
  maxCarryoverContextBytes: 128 * 1024,
  maxEstimatedInputTokens: 128 * 1024,
  maxTotalEstimatedInputTokens: 512 * 1024,
  maxSearchResults: 100,
  maxSearchFileBytes: 1024 * 1024,
  maxDirectoryDepth: 10,
  maxAssistantMessageBytes: 8 * 1024,
  maxConsecutiveNoProgressToolCalls: 64,
  maxNoProgressModelTurns: 64,
});

export const EXECUTOR_LIMIT_MINIMA = Object.freeze({
  maxToolResultBytes: 1024,
  maxToolArgumentBytes: 1024,
  maxRetainedEvidenceBytes: 1024,
  maxExecutorContextBytes: 16 * 1024,
  maxCarryoverContextBytes: 4 * 1024,
  maxEstimatedInputTokens: 4 * 1024,
  maxTotalEstimatedInputTokens: 4 * 1024,
  maxAssistantMessageBytes: 256,
});

/** Internal mechanics rather than user-tunable policy. */
export const EXECUTOR_COMPACTION_POLICY = Object.freeze({
  minimumContextBytes: 4 * 1024,
  minimumCompactionStepBytes: 8 * 1024,
  diffBudgetDivisor: 5,
  toolResultEnvelopeReserveBytes: 512,
  stringShrinkRatio: 0.7,
  evidenceReferenceCharacters: 12,
  searchLabelCharacters: 256,
  evidenceLabelCharacters: 512,
});

export function resolveExecutorLimits(
  input: Partial<ExecutorLimits> | undefined,
): ResolvedExecutorLimits {
  const maxProviderCallsPerTask = input?.maxProviderCallsPerTask
    ?? input?.maxModelTurnsPerTask
    ?? DEFAULT_EXECUTOR_LIMITS.maxProviderCallsPerTask;
  const maxExecutorContextBytes = input?.maxExecutorContextBytes ?? DEFAULT_EXECUTOR_LIMITS.maxExecutorContextBytes;
  const maxEstimatedInputTokens = input?.maxEstimatedInputTokens ?? DEFAULT_EXECUTOR_LIMITS.maxEstimatedInputTokens;
  const limits: ResolvedExecutorLimits = {
    maxToolCallsPerTask: input?.maxToolCallsPerTask ?? DEFAULT_EXECUTOR_LIMITS.maxToolCallsPerTask,
    maxReadToolCallsPerTask: input?.maxReadToolCallsPerTask ?? DEFAULT_EXECUTOR_LIMITS.maxReadToolCallsPerTask,
    maxMutatingToolCallsPerTask: input?.maxMutatingToolCallsPerTask ?? DEFAULT_EXECUTOR_LIMITS.maxMutatingToolCallsPerTask,
    maxValidationToolCallsPerTask: input?.maxValidationToolCallsPerTask ?? DEFAULT_EXECUTOR_LIMITS.maxValidationToolCallsPerTask,
    maxProviderCallsPerTask,
    maxToolResultBytes: input?.maxToolResultBytes ?? DEFAULT_EXECUTOR_LIMITS.maxToolResultBytes,
    maxToolArgumentBytes: input?.maxToolArgumentBytes ?? DEFAULT_EXECUTOR_LIMITS.maxToolArgumentBytes,
    maxRetainedEvidenceBytes: input?.maxRetainedEvidenceBytes ?? DEFAULT_EXECUTOR_LIMITS.maxRetainedEvidenceBytes,
    maxExecutorContextBytes,
    maxCarryoverContextBytes: input?.maxCarryoverContextBytes ?? Math.min(DEFAULT_EXECUTOR_LIMITS.maxCarryoverContextBytes, maxExecutorContextBytes),
    maxEstimatedInputTokens,
    maxTotalEstimatedInputTokens: input?.maxTotalEstimatedInputTokens ?? Math.max(DEFAULT_EXECUTOR_LIMITS.maxTotalEstimatedInputTokens, maxEstimatedInputTokens),
    maxSearchResults: input?.maxSearchResults ?? DEFAULT_EXECUTOR_LIMITS.maxSearchResults,
    maxSearchFileBytes: input?.maxSearchFileBytes ?? DEFAULT_EXECUTOR_LIMITS.maxSearchFileBytes,
    maxDirectoryDepth: input?.maxDirectoryDepth ?? DEFAULT_EXECUTOR_LIMITS.maxDirectoryDepth,
    maxAssistantMessageBytes: input?.maxAssistantMessageBytes ?? DEFAULT_EXECUTOR_LIMITS.maxAssistantMessageBytes,
    maxConsecutiveNoProgressToolCalls: input?.maxConsecutiveNoProgressToolCalls ?? DEFAULT_EXECUTOR_LIMITS.maxConsecutiveNoProgressToolCalls,
    maxNoProgressModelTurns: input?.maxNoProgressModelTurns ?? DEFAULT_EXECUTOR_LIMITS.maxNoProgressModelTurns,
  };

  if (Object.values(limits).some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new ExecutorError("executor_error", "Executor limits are invalid");
  }
  for (const [name, minimum] of Object.entries(EXECUTOR_LIMIT_MINIMA)) {
    if (limits[name as keyof ResolvedExecutorLimits] < minimum) {
      throw new ExecutorError("executor_error", `Executor limit ${name} is below its safe minimum`);
    }
  }
  for (const [name, ceiling] of Object.entries(EXECUTOR_SAFETY_CEILINGS)) {
    if (limits[name as keyof ResolvedExecutorLimits] > ceiling) {
      throw new ExecutorError("executor_error", `Executor limit ${name} exceeds its hard safety ceiling`);
    }
  }
  if (limits.maxCarryoverContextBytes > limits.maxExecutorContextBytes) {
    throw new ExecutorError("executor_error", "Executor carry-over context cannot exceed the per-request context bound");
  }
  if (limits.maxTotalEstimatedInputTokens < limits.maxEstimatedInputTokens) {
    throw new ExecutorError("executor_error", "Executor total input budget cannot be smaller than its per-request input bound");
  }
  return limits;
}
