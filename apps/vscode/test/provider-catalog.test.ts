import { describe, expect, it } from "vitest";
import { projectProviderCatalog, searchProviderCatalog } from "../src/provider-catalog.js";

describe("provider catalog projection", () => {
  it("keeps compatible presets distinct even when they share an adapter", () => {
    const entries = projectProviderCatalog([
      { id: "kimi", catalogId: "kimi", type: "openai-compatible", displayName: "Kimi Work", baseUrl: "https://api.moonshot.ai/v1", authStrategy: "api_key" },
      { id: "openai-compatible", type: "openai-compatible", displayName: "Gateway", baseUrl: "https://gateway.example/v1", authStrategy: "none" },
    ], "kimi");
    expect(entries.find((entry) => entry.id === "kimi")).toMatchObject({ configured: true, connected: true, configurations: [{ id: "kimi", isDefault: true }] });
    expect(entries.find((entry) => entry.id === "openai-compatible")).toMatchObject({ configured: true, configurations: [{ id: "openai-compatible", isDefault: false }] });
  });

  it("searches display and category labels without changing the source", () => {
    const entries = projectProviderCatalog([]);
    expect(searchProviderCatalog(entries, "local").map((entry) => entry.id)).toEqual(expect.arrayContaining(["ollama", "lm-studio", "local-openai-compatible"]));
    expect(searchProviderCatalog(entries, "claude").map((entry) => entry.id)).toEqual(expect.arrayContaining(["anthropic", "claude-code-cli"]));
    expect(entries).toHaveLength(14);
  });
});
