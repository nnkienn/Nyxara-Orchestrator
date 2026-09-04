import {
  capabilityForModel,
  type ModelExecutionCapability,
  type ModelExecutionCapabilityRule,
} from "@nyxara/provider-sdk";

const values = (...items: readonly string[]) => items.map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}));

const openai = (supported: readonly string[]): ModelExecutionCapability => ({
  kind: "openai_reasoning",
  label: "Reasoning",
  control: "select",
  values: values(...supported),
  provenance: "adapter_known",
});

const anthropic: ModelExecutionCapability = {
  kind: "anthropic_thinking",
  label: "Thinking",
  control: "toggle_number",
  enabledLabel: "Enabled",
  budgetLabel: "Thinking Budget",
  minimumBudgetTokens: 1_024,
  maximumBudgetTokens: 32_768,
  integerBudget: true,
  provenance: "adapter_known",
};

const geminiBudget = (minimumBudgetTokens: number, maximumBudgetTokens: number, allowZero = false): ModelExecutionCapability => ({
  kind: "gemini_thinking_budget",
  label: "Thinking",
  control: "toggle_number",
  enabledLabel: "Custom Budget",
  budgetLabel: "Thinking Budget",
  minimumBudgetTokens,
  maximumBudgetTokens,
  integerBudget: true,
  ...(allowZero ? { allowZero: true } : {}),
  provenance: "adapter_known",
});

const geminiLevel = (...supported: readonly string[]): ModelExecutionCapability => ({
  kind: "gemini_thinking_level",
  label: "Thinking",
  control: "select",
  values: values(...supported),
  provenance: "adapter_known",
});

const rules = (...items: readonly ModelExecutionCapabilityRule[]): readonly ModelExecutionCapabilityRule[] => Object.freeze(items);

const RULES: Readonly<Record<string, readonly ModelExecutionCapabilityRule[]>> = Object.freeze({
  openai: rules(
    { match: "prefix", modelId: "gpt-5-pro", capability: openai(["high"]) },
    { match: "prefix", modelId: "gpt-5.1", capability: openai(["none", "low", "medium", "high"]) },
    { match: "prefix", modelId: "o3-mini", capability: openai(["low", "medium", "high"]) },
    { match: "prefix", modelId: "o4-mini", capability: openai(["low", "medium", "high"]) },
  ),
  anthropic: rules(
    { match: "prefix", modelId: "claude-opus-4-5", capability: anthropic },
    { match: "prefix", modelId: "claude-sonnet-4-5", capability: anthropic },
    { match: "prefix", modelId: "claude-haiku-4-5", capability: anthropic },
    { match: "prefix", modelId: "claude-3-7-sonnet", capability: anthropic },
  ),
  gemini: rules(
    { match: "prefix", modelId: "gemini-2.5-flash-lite", capability: geminiBudget(512, 24_576, true) },
    { match: "prefix", modelId: "gemini-2.5-flash", capability: geminiBudget(0, 24_576, true) },
    { match: "prefix", modelId: "gemini-2.5-pro", capability: geminiBudget(128, 32_768) },
    { match: "prefix", modelId: "gemini-3.7-flash", capability: geminiLevel("low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3.6-flash", capability: geminiLevel("minimal", "low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3.5-flash-lite", capability: geminiLevel("minimal", "low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3.5-flash", capability: geminiLevel("minimal", "low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3.1-flash-lite-image", capability: geminiLevel("minimal", "high") },
    { match: "prefix", modelId: "gemini-3.1-flash-lite", capability: geminiLevel("minimal", "low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3.1-pro", capability: geminiLevel("low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3-flash", capability: geminiLevel("minimal", "low", "medium", "high") },
    { match: "prefix", modelId: "gemini-3-pro", capability: geminiLevel("low", "high") },
  ),
});

/** Locally maintained, model-specific execution metadata. Unknown providers/models return no capability. */
export function modelExecutionCapabilityRules(providerId: string): readonly ModelExecutionCapabilityRule[] {
  return RULES[providerId] ?? [];
}

export function knownModelExecutionCapability(providerId: string, modelId: string): ModelExecutionCapability | undefined {
  return capabilityForModel(modelExecutionCapabilityRules(providerId), modelId);
}
