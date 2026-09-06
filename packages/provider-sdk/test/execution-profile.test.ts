import { describe, expect, it } from "vitest";
import {
  PROVIDER_DEFAULT_EXECUTION,
  ExecutionProfileError,
  assertExecutionOptionsSupported,
  executionProfileSummary,
  parseExecutionOptions,
  parseRoleExecutionProfile,
  validateExecutionOptions,
  type ModelExecutionCapability,
} from "../src/index.js";

const reasoning: ModelExecutionCapability = {
  kind: "openai_reasoning", label: "Reasoning", control: "select",
  values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], provenance: "adapter_known",
};

describe("execution profile domain", () => {
  it("validates provider-discovered Claude CLI effort without treating it as OpenAI reasoning", () => {
    const effort: ModelExecutionCapability = { kind: "anthropic_effort", label: "Effort", control: "select", values: [{ value: "high", label: "High" }, { value: "max", label: "Max" }], provenance: "provider_discovery" };
    expect(parseExecutionOptions({ kind: "anthropic_effort", effort: "max" })).toEqual({ kind: "anthropic_effort", effort: "max" });
    expect(validateExecutionOptions({ kind: "anthropic_effort", effort: "max" }, effort)).toBe("valid");
    expect(validateExecutionOptions({ kind: "openai_reasoning", effort: "max" }, effort)).toBe("stale");
    expect(executionProfileSummary({ kind: "anthropic_effort", effort: "high" })).toEqual({ kind: "anthropic_effort", value: "high" });
  });

  it("makes Provider Default first-class and serializable", () => {
    expect(parseExecutionOptions(JSON.parse(JSON.stringify(PROVIDER_DEFAULT_EXECUTION)))).toEqual({ kind: "provider_default" });
    expect(executionProfileSummary(undefined)).toEqual({ kind: "provider_default" });
  });

  it("serializes and parses a typed role execution profile", () => {
    const value = { providerConfigId: "openai-work", requestedModelId: "gpt-5.1", executionOptions: { kind: "openai_reasoning", effort: "high" } };
    expect(parseRoleExecutionProfile(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("validates supported values and marks changed/unknown capability safely", () => {
    expect(validateExecutionOptions({ kind: "openai_reasoning", effort: "low" }, reasoning)).toBe("valid");
    expect(validateExecutionOptions({ kind: "openai_reasoning", effort: "medium" }, reasoning)).toBe("stale");
    expect(validateExecutionOptions({ kind: "openai_reasoning", effort: "low" }, undefined)).toBe("stale");
    expect(validateExecutionOptions(PROVIDER_DEFAULT_EXECUTION, undefined)).toBe("unknown");
    expect(() => assertExecutionOptionsSupported({ kind: "openai_reasoning", effort: "bad" }, reasoning)).toThrow(ExecutionProfileError);
  });

  it("rejects malformed, non-finite, and secret-bearing profiles", () => {
    expect(parseExecutionOptions({ kind: "anthropic_thinking", enabled: true, budgetTokens: Number.NaN })).toBeUndefined();
    expect(parseExecutionOptions({ kind: "provider_default", apiKey: "sk-secret" })).toBeUndefined();
    expect(parseRoleExecutionProfile({ providerConfigId: "p", requestedModelId: "m", executionOptions: { kind: "provider_default" }, apiKey: "sk-secret" })).toBeUndefined();
    expect(JSON.stringify(executionProfileSummary({ kind: "anthropic_thinking", enabled: true, budgetTokens: 2048 }))).not.toMatch(/secret|api.?key|authorization/i);
  });
});
