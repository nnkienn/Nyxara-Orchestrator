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
    });
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

