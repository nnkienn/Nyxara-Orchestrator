import { describe, expect, it } from "vitest";
import { knownModelExecutionCapability, modelExecutionCapabilityRules } from "../src/index.js";

describe("model execution capability catalog", () => {
  it("is model-specific and preserves provenance", () => {
    expect(knownModelExecutionCapability("openai", "gpt-5.1-2026-01-01")).toMatchObject({ kind: "openai_reasoning", provenance: "adapter_known" });
    expect(knownModelExecutionCapability("openai", "gpt-4.1")).toBeUndefined();
    expect(knownModelExecutionCapability("anthropic", "claude-sonnet-4-5-20250929")).toMatchObject({ kind: "anthropic_thinking", minimumBudgetTokens: 1024 });
    expect(knownModelExecutionCapability("gemini", "gemini-2.5-pro")).toMatchObject({ kind: "gemini_thinking_budget", minimumBudgetTokens: 128 });
    expect(knownModelExecutionCapability("gemini", "gemini-3-flash")).toMatchObject({ kind: "gemini_thinking_level" });
    expect(knownModelExecutionCapability("gemini", "gemini-3-pro-preview")).toMatchObject({
      values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
    });
    expect(knownModelExecutionCapability("gemini", "gemini-3-unknown")).toBeUndefined();
  });

  it("does not inherit provider capability across models or compatible transports", () => {
    expect(modelExecutionCapabilityRules("openai").length).toBeGreaterThan(0);
    for (const provider of ["openai-compatible", "openrouter", "deepseek", "ollama", "unknown"]) {
      expect(modelExecutionCapabilityRules(provider)).toEqual([]);
      expect(knownModelExecutionCapability(provider, "gpt-5.1")).toBeUndefined();
    }
  });
});
