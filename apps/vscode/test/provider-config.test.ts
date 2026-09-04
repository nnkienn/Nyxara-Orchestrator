import { describe, expect, it, vi } from "vitest";
import { createProvider, defaultProviderId, providerSecretKey, readProviderConfigs } from "../src/provider-config.js";

describe("local provider configuration", () => {
  it("reads multiple non-secret configs and keeps stable identities", () => {
    const configs = [{ id: "work", type: "openai-compatible", displayName: "Work", baseUrl: "https://work.invalid/v1", authStrategy: "api_key" }, { id: "local", type: "ollama", displayName: "Ollama", baseUrl: "http://localhost:11434/v1", authStrategy: "local" }];
    const result = readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? configs as any : fallback);
    expect(result).toEqual(configs); expect(defaultProviderId(result, "local")).toBe("local"); expect(defaultProviderId(result, "missing")).toBe("work");
  });

  it("ignores duplicate stored identities deterministically", () => {
    const first = { id: "work", type: "openai-compatible", displayName: "Work", baseUrl: "https://work.invalid/v1", authStrategy: "api_key" };
    const duplicate = { ...first, displayName: "Duplicate" };
    expect(readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? [first, duplicate] as any : fallback)).toEqual([first]);
  });

  it("reads alpha.1 settings without migrating or deleting its legacy secret", async () => {
    const values: Record<string, unknown> = { "nyxara.planner.model": "route/model", "nyxara.executor.model": "route/model", "nyxara.reviewer.model": "route/model", "nyxara.openaiCompatible.baseUrl": "https://legacy.invalid/v1" };
    const configs = readProviderConfigs((key, fallback) => (values[key] ?? fallback) as any);
    expect(configs).toEqual([{ id: "openai-compatible", type: "openai-compatible", displayName: "OpenAI-compatible", baseUrl: "https://legacy.invalid/v1", authStrategy: "api_key" }]);
    const secrets = { get: vi.fn(async (key: string) => key === "openai-compatible.apiKey" ? "legacy-secret" : undefined), store: vi.fn(), delete: vi.fn() };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = createProvider(configs[0]!, secrets);
    await provider.listModels();
    expect(secrets.get.mock.calls.map(([key]) => key)).toEqual([providerSecretKey("openai-compatible"), "openai-compatible.apiKey"]);
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer legacy-secret");
    fetch.mockRestore();
  });

  it("does not infer a provider from defaults when role models are incomplete", () => {
    expect(readProviderConfigs((_key, fallback) => fallback)).toEqual([]);
  });

  it("retains a compatible preset catalog ID while constructing its shared adapter", () => {
    const configs = readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? [{ id: "kimi", catalogId: "kimi", type: "openai-compatible", displayName: "Kimi", baseUrl: "https://api.moonshot.ai/v1", authStrategy: "api_key" }] as any : fallback);
    expect(configs).toEqual([expect.objectContaining({ id: "kimi", catalogId: "kimi", type: "openai-compatible" })]);
  });

  it("reads a subscription CLI config without an endpoint or secret", async () => {
    const configs = readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? [{ id: "codex-cli", type: "codex-cli", displayName: "OpenAI Codex (ChatGPT)", authStrategy: "subscription" }] as any : fallback);
    expect(configs).toEqual([{ id: "codex-cli", type: "codex-cli", displayName: "OpenAI Codex (ChatGPT)", authStrategy: "subscription" }]);
    const provider = createProvider(configs[0]!, { get: vi.fn(), store: vi.fn(), delete: vi.fn() });
    expect(provider).toMatchObject({ id: "codex-cli", displayName: "OpenAI Codex (ChatGPT)" });
    expect(provider.capabilities()).toMatchObject({ toolCalling: true, structuredOutput: true });
  });
});
