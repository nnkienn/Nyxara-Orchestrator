import type {
  ExecutionOptions,
  ExecutionProfileStatus,
  ExecutionProfileSummary,
  ModelExecutionCapability,
  ModelExecutionCapabilityRule,
  RoleExecutionProfile,
} from "./provider.types.js";

export const PROVIDER_DEFAULT_EXECUTION: ExecutionOptions = Object.freeze({ kind: "provider_default" });

export class ExecutionProfileError extends Error {
  constructor(
    readonly code: "invalid_execution_profile" | "unsupported_execution_profile",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionProfileError";
  }
}

export function parseExecutionOptions(value: unknown): ExecutionOptions | undefined {
  if (!record(value) || typeof value.kind !== "string") return undefined;
  switch (value.kind) {
    case "provider_default":
      return Object.keys(value).every((key) => key === "kind") ? PROVIDER_DEFAULT_EXECUTION : undefined;
    case "openai_reasoning":
      return typeof value.effort === "string" && value.effort.trim() && Object.keys(value).every((key) => key === "kind" || key === "effort")
        ? { kind: value.kind, effort: value.effort.trim() }
        : undefined;
    case "anthropic_thinking":
      return value.enabled === true && finite(value.budgetTokens) && Object.keys(value).every((key) => ["kind", "enabled", "budgetTokens"].includes(key))
        ? { kind: value.kind, enabled: true, budgetTokens: value.budgetTokens }
        : undefined;
    case "gemini_thinking_budget":
      return finite(value.budgetTokens) && Object.keys(value).every((key) => key === "kind" || key === "budgetTokens")
        ? { kind: value.kind, budgetTokens: value.budgetTokens }
        : undefined;
    case "gemini_thinking_level":
      return typeof value.level === "string" && value.level.trim() && Object.keys(value).every((key) => key === "kind" || key === "level")
        ? { kind: value.kind, level: value.level.trim() }
        : undefined;
    default:
      return undefined;
  }
}

export function parseRoleExecutionProfile(value: unknown): RoleExecutionProfile | undefined {
  if (!record(value)) return undefined;
  if (!Object.keys(value).every((key) => ["providerConfigId", "requestedModelId", "executionOptions"].includes(key))) return undefined;
  const providerConfigId = text(value.providerConfigId);
  const requestedModelId = text(value.requestedModelId);
  const executionOptions = parseExecutionOptions(value.executionOptions);
  return providerConfigId && requestedModelId && executionOptions
    ? { providerConfigId, requestedModelId, executionOptions }
    : undefined;
}

export function validateExecutionOptions(
  options: ExecutionOptions,
  capability: ModelExecutionCapability | undefined,
): ExecutionProfileStatus {
  if (options.kind === "provider_default") return capability ? "valid" : "unknown";
  if (!capability || capability.kind !== options.kind) return "stale";
  if (capability.control === "select") {
    const value = options.kind === "openai_reasoning" ? options.effort : options.kind === "gemini_thinking_level" ? options.level : undefined;
    return value !== undefined && capability.values.some((choice) => choice.value === value) ? "valid" : "stale";
  }
  const budget = options.kind === "anthropic_thinking" || options.kind === "gemini_thinking_budget" ? options.budgetTokens : Number.NaN;
  if (!Number.isFinite(budget) || (capability.integerBudget && !Number.isInteger(budget))) return "stale";
  if (capability.kind === "gemini_thinking_budget" && capability.allowZero && budget === 0) return "valid";
  return budget >= capability.minimumBudgetTokens && budget <= capability.maximumBudgetTokens ? "valid" : "stale";
}

export function assertExecutionOptionsSupported(
  options: ExecutionOptions | undefined,
  capability: ModelExecutionCapability | undefined,
): ExecutionOptions {
  const normalized = options ?? PROVIDER_DEFAULT_EXECUTION;
  if (normalized.kind === "provider_default") return normalized;
  if (validateExecutionOptions(normalized, capability) !== "valid") {
    throw new ExecutionProfileError("unsupported_execution_profile", "The execution setting is not supported by the selected provider and model.");
  }
  return normalized;
}

export function executionProfileSummary(options: ExecutionOptions | undefined): ExecutionProfileSummary {
  const normalized = options ?? PROVIDER_DEFAULT_EXECUTION;
  switch (normalized.kind) {
    case "provider_default": return { kind: normalized.kind };
    case "openai_reasoning": return { kind: normalized.kind, value: normalized.effort };
    case "anthropic_thinking": return { kind: normalized.kind, enabled: true, budgetTokens: normalized.budgetTokens };
    case "gemini_thinking_budget": return { kind: normalized.kind, budgetTokens: normalized.budgetTokens };
    case "gemini_thinking_level": return { kind: normalized.kind, value: normalized.level };
  }
}

export function capabilityForModel(
  rules: readonly ModelExecutionCapabilityRule[],
  modelId: string,
): ModelExecutionCapability | undefined {
  const normalized = modelId.trim().toLocaleLowerCase();
  return rules.find((rule) => rule.match === "exact"
    ? normalized === rule.modelId.toLocaleLowerCase()
    : normalized.startsWith(rule.modelId.toLocaleLowerCase()))?.capability;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
