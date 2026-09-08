import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "@nyxara/core";
import { OpenAICompatibleProvider } from "../src/index.js";

describe("compatible gateway explicit model resolution", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("keeps the exact routed model without discovery, generation, credentials, or timers", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    const credentialStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const provider = new OpenAICompatibleProvider({ id: "gateway", baseUrl: "https://gateway.invalid/v1", fetch, credentialStore });
    const registry = new ProviderRegistry(); registry.register(provider);
    expect(await registry.resolveModel("gateway", "ntha/gpt-6-astra")).toEqual({ id: "ntha/gpt-6-astra", name: "ntha/gpt-6-astra", provider: "gateway" });
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialStore.get).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still discovers models explicitly and keeps known execution capabilities", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "route/model", capabilities: { tools: true, execution: { kind: "openai_reasoning", values: ["low", "high"] } } }] })));
    const provider = new OpenAICompatibleProvider({ fetch });
    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(["route/model"]);
    expect(models[0]!.capabilities?.execution).toMatchObject({ kind: "openai_reasoning", control: "select" });
    expect(await provider.resolveModel("route/model")).toMatchObject({ id: "route/model", capabilities: models[0]!.capabilities });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await provider.resolveModel("another-route/model")).toMatchObject({ id: "another-route/model" });
  });

  it("reloads capability metadata for a saved non-default profile without rewriting it", async () => {
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "route/model", capabilities: { execution: { kind: "openai_reasoning", values: ["low", "high"] } } }] }))
      : new Response(JSON.stringify({ model: "resolved", choices: [{ message: { content: "ok" } }] })));
    const executionOptions = { kind: "openai_reasoning", effort: "high" } as const;
    const provider = new OpenAICompatibleProvider({ fetch });
    const registry = new ProviderRegistry(); registry.register(provider);
    const model = await registry.resolveModel(provider.id, "route/model", executionOptions);
    expect(model?.capabilities?.execution).toMatchObject({ kind: "openai_reasoning" });
    await provider.generate({ model: model!.id, prompt: "Check the task", executionOptions });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ model: "route/model", reasoning_effort: "high" });
    expect(executionOptions).toEqual({ kind: "openai_reasoning", effort: "high" });
  });

  it.each([401, 404, 502])("lets generation report HTTP %s without substitution or automatic retry", async (statusCode) => {
    const fetch = vi.fn(async () => new Response("", { status: statusCode }));
    const provider = new OpenAICompatibleProvider({ fetch });
    const model = await provider.resolveModel("route/not-in-catalog");
    expect(model?.id).toBe("route/not-in-catalog");
    await expect(provider.generate({ model: model!.id, prompt: "Run assigned task" })).rejects.toMatchObject({ statusCode, code: statusCode === 404 ? "invalid_model" : statusCode === 401 ? "authentication_error" : "provider_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain("/chat/completions");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).model).toBe("route/not-in-catalog");
  });

  it("keeps official OpenAI discovery checks and rejects empty or malformed IDs", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "listed" }] })));
    const provider = new OpenAICompatibleProvider({ providerId: "openai", fetch });
    expect(await provider.resolveModel("absent")).toBeUndefined();
    expect(await provider.resolveModel("listed")).toMatchObject({ id: "listed" });
    expect(await provider.resolveModel(" ")).toBeUndefined();
    expect(await provider.resolveModel("bad\0id")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps discovery strict for providers without an explicit resolver", async () => {
    const listModels = vi.fn(async () => [{ id: "listed", name: "Listed", provider: "strict" }]);
    const registry = new ProviderRegistry();
    registry.register({ id: "strict", displayName: "Strict", listModels, generate: vi.fn(), capabilities: () => ({ modelDiscovery: true, textGeneration: true }) });
    expect(await registry.resolveModel("strict", "absent")).toBeUndefined();
    expect(await registry.resolveModel("strict", "listed")).toMatchObject({ id: "listed" });
    expect(listModels).toHaveBeenCalledTimes(2);
  });
});
