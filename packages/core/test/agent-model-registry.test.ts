import { describe, expect, it } from "vitest";
import { AgentModelRegistry } from "../src/index.js";

describe("AgentModelRegistry", () => {
  it("maps the planner role independently to provider and model IDs", () => {
    const registry = new AgentModelRegistry();
    registry.set({ role: "planner", providerId: "provider-a", modelId: "model-a" });

    expect(registry.get("planner")).toEqual({
      role: "planner",
      providerId: "provider-a",
      modelId: "model-a",
      executionOptions: { kind: "provider_default" },
    });
  });

  it("preserves independent typed execution profiles and rejects malformed values", () => {
    const registry = new AgentModelRegistry();
    registry.set({ role: "executor", providerId: "openai-work", modelId: "gpt-5.1", executionOptions: { kind: "openai_reasoning", effort: "medium" } });
    expect(registry.get("executor").executionOptions).toEqual({ kind: "openai_reasoning", effort: "medium" });
    expect(() => registry.set({ role: "reviewer", providerId: "p", modelId: "m", executionOptions: { kind: "provider_default", apiKey: "secret" } as any })).toThrowError(expect.objectContaining({ code: "invalid_agent_config" }));
  });

  it("returns controlled errors for unconfigured roles and duplicate initial roles", () => {
    expect(() => new AgentModelRegistry().get("planner")).toThrowError(
      expect.objectContaining({ code: "unconfigured_agent_role" }),
    );
    expect(
      () =>
        new AgentModelRegistry([
          { role: "planner", providerId: "one", modelId: "one" },
          { role: "planner", providerId: "two", modelId: "two" },
        ]),
    ).toThrowError(expect.objectContaining({ code: "duplicate_agent_role" }));
  });
});
