import { describe, expect, it, vi } from "vitest";
import { createProvider, defaultProviderId, providerSecretKey, readPersistedExecution, readProviderConfigs, roleExecutionSetting } from "../src/provider-config.js";

describe("local provider configuration", () => {
  it("persists explicit gateway streaming and reconstructs it without provider calls or credential writes", () => {
    const config = { id: "gateway", type: "openai-compatible", displayName: "Gateway", baseUrl: "https://router.invalid/v1", authStrategy: "api_key", streaming: true };
    const configs = [config, { ...config, id: "other", streaming: false }];
    const before = JSON.stringify(configs);
    const read = (stored: unknown) => readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? stored as any : fallback);
    const loaded = read(configs);
    const reloaded = read(JSON.parse(JSON.stringify(loaded)));
    const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(reloaded).toEqual(configs);
      expect(createProvider(reloaded[0]!, secrets).capabilities().progressStreaming).toBe(true);
      expect(createProvider(reloaded[1]!, secrets).capabilities().progressStreaming).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(secrets.get).not.toHaveBeenCalled();
      expect(secrets.store).not.toHaveBeenCalled();
      expect(secrets.delete).not.toHaveBeenCalled();
      expect(JSON.stringify(configs)).toBe(before);
    } finally { fetch.mockRestore(); }
  });

  it.each([undefined, "true", 1, {}, null])("does not enable gateway streaming for malformed or missing value %s", (streaming) => {
    const configs = readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? [{ id: "9router", type: "openai-compatible", baseUrl: "https://router.invalid/v1", streaming }] as any : fallback);
    expect(configs[0]?.streaming).toBeUndefined();
    expect(createProvider(configs[0]!, { get: vi.fn(), store: vi.fn(), delete: vi.fn() }).capabilities().progressStreaming).toBe(false);
  });

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

  it("sends a newly added gateway key from SecretStorage as Bearer auth and never embeds it in config", async () => {
    const config = { id: "gateway", type: "openai-compatible" as const, displayName: "9Router", baseUrl: "https://gateway.invalid/v1", authStrategy: "none" as const };
    const stored = new Map<string, string>();
    const secrets = { get: vi.fn(async (key: string) => stored.get(key)), store: vi.fn(async (key: string, value: string) => { stored.set(key, value); }), delete: vi.fn(async (key: string) => { stored.delete(key); }) };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      return (init?.headers as Headers).get("Authorization") === "Bearer gateway-key-test-only"
        ? new Response(JSON.stringify({ data: [{ id: "route/model" }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "authentication required" } }), { status: 401 });
    });
    try {
      await expect(createProvider(config, secrets).listModels()).rejects.toMatchObject({ code: "authentication_error" });
      await secrets.store(providerSecretKey(config.id), "gateway-key-test-only");
      const authenticated = { ...config, authStrategy: "api_key" as const };
      expect((await createProvider(authenticated, secrets).listModels()).map((model) => model.id)).toEqual(["route/model"]);
      expect((fetch.mock.calls[1]?.[1]?.headers as Headers).get("Authorization")).toBe("Bearer gateway-key-test-only");
      expect(JSON.stringify(authenticated)).not.toContain("gateway-key-test-only");
      await secrets.delete(providerSecretKey(config.id));
      await expect(createProvider(authenticated, secrets).listModels()).rejects.toMatchObject({ code: "authentication_error" });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fetch.mockRestore(); }
  });

  it("retains a compatible preset catalog ID while constructing its shared adapter", () => {
    const configs = readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? [{ id: "kimi", catalogId: "kimi", type: "openai-compatible", displayName: "Kimi", baseUrl: "https://api.moonshot.ai/v1", authStrategy: "api_key" }] as any : fallback);
    expect(configs).toEqual([expect.objectContaining({ id: "kimi", catalogId: "kimi", type: "openai-compatible" })]);
  });

  it("reads a subscription CLI config without an endpoint or secret", async () => {
    const configs = readProviderConfigs((key, fallback) => key === "nyxara.providerConfigs" ? [{ id: "codex-cli", type: "codex-cli", displayName: "OpenAI Codex (ChatGPT)", authStrategy: "subscription" }] as any : fallback);
    expect(configs).toEqual([{ id: "codex-cli", type: "codex-cli", displayName: "OpenAI Codex (ChatGPT)", authStrategy: "subscription_cli" }]);
    const provider = createProvider(configs[0]!, { get: vi.fn(), store: vi.fn(), delete: vi.fn() });
    expect(provider).toMatchObject({ id: "codex-cli", displayName: "OpenAI Codex (ChatGPT)" });
    expect(provider.capabilities()).toMatchObject({ toolCalling: true, structuredOutput: true });
  });

  it("migrates missing alpha.8 execution settings to Provider Default without accepting malformed data", () => {
    expect(roleExecutionSetting("planner")).toBe("nyxara.planner.execution");
    expect(readPersistedExecution(undefined)).toEqual({ executionOptions: { kind: "provider_default" }, malformed: false, migrated: true });
    expect(readPersistedExecution({ kind: "openai_reasoning", effort: "medium" })).toEqual({ executionOptions: { kind: "openai_reasoning", effort: "medium" }, malformed: false, migrated: false });
    expect(readPersistedExecution({ kind: "provider_default", token: "secret" })).toMatchObject({ executionOptions: { kind: "provider_default" }, malformed: true, migrated: false });
  });
});
