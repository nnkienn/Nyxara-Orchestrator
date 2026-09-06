import { describe, expect, it, vi } from "vitest";
import { MODEL_CACHE_KEY, ProviderModelDiscovery, sanitizeModels } from "../src/model-discovery.js";

function storage(initial: unknown[] = []) {
  let value: unknown = initial; return { get: vi.fn((_key: string, fallback: unknown) => value ?? fallback), update: vi.fn(async (_key: string, next: unknown) => { value = next; }), read: () => value };
}

describe("account-scoped authoritative model discovery", () => {
  it("preserves exact provider IDs and unknown new models", async () => {
    const store = storage(); const discovery = new ProviderModelDiscovery(store);
    const models = await discovery.refresh("openai-work", async () => [
      { id: "router/GPT-New-2026-09-05", name: "New", provider: "openai-work" },
      { id: "gpt-5.1-2025-11-13", name: "Snapshot", provider: "openai-work", capabilities: { execution: { kind: "openai_reasoning", label: "Reasoning", control: "select", values: [{ value: "low", label: "Low" }], provenance: "adapter_known" } } },
    ]);
    expect(models.map((model) => model.id)).toEqual(["router/GPT-New-2026-09-05", "gpt-5.1-2025-11-13"]);
    expect(models[0]).not.toHaveProperty("capabilities.execution");
    expect(discovery.state("openai-work")).toMatchObject({ status: "loaded", models });
    expect(store.update).toHaveBeenCalledWith(MODEL_CACHE_KEY, expect.any(Array));
  });

  it("keeps account caches separate and reloads them as cached without polling", async () => {
    const store = storage(); const discovery = new ProviderModelDiscovery(store);
    await discovery.refresh("personal", async () => [{ id: "personal/model", name: "Personal", provider: "personal" }]);
    await discovery.refresh("work", async () => [{ id: "work/model", name: "Work", provider: "work" }]);
    const reloaded = new ProviderModelDiscovery(store);
    expect(reloaded.state("personal")).toMatchObject({ status: "cached", models: [{ id: "personal/model" }] });
    expect(reloaded.state("work")).toMatchObject({ status: "cached", models: [{ id: "work/model" }] });
  });

  it("preserves the last safe cache after temporary and authentication failures", async () => {
    const discovery = new ProviderModelDiscovery(storage()); await discovery.refresh("work", async () => [{ id: "exact", name: "Exact", provider: "work" }]);
    await expect(discovery.refresh("work", async () => { throw Object.assign(new Error("network raw body"), { code: "network_error" }); })).rejects.toThrow();
    expect(discovery.state("work")).toMatchObject({ status: "failed", models: [{ id: "exact" }], message: "Models could not be loaded." });
    await expect(discovery.refresh("work", async () => { throw Object.assign(new Error("denied"), { statusCode: 401 }); })).rejects.toThrow();
    expect(discovery.state("work")).toMatchObject({ status: "failed", message: "Authentication failed while loading models.", models: [{ id: "exact" }] });
  });

  it("marks unsupported discovery honestly and clears only one account", async () => {
    const discovery = new ProviderModelDiscovery(storage()); await discovery.refresh("one", async () => [{ id: "one", name: "One", provider: "one" }]); await discovery.refresh("two", async () => [{ id: "two", name: "Two", provider: "two" }]);
    expect(discovery.state("one", false).status).toBe("unsupported"); await discovery.clear("one");
    expect(discovery.state("one").models).toEqual([]); expect(discovery.state("two").models.map((model) => model.id)).toEqual(["two"]);
  });

  it("stores only bounded safe metadata and capability provenance", () => {
    const models = sanitizeModels([{ id: "exact", name: "Exact", provider: "p", capabilities: { text: true, execution: { kind: "openai_reasoning", label: "Reasoning", control: "select", values: [{ value: "eco", label: "Eco" }], provenance: "provider_discovery" }, authorization: "secret" } as any, rawResponse: "secret" } as any]);
    expect(models).toEqual([{ id: "exact", name: "Exact", capabilities: { text: true, execution: { kind: "openai_reasoning", label: "Reasoning", control: "select", values: [{ value: "eco", label: "Eco" }], provenance: "provider_discovery" } } }]);
    expect(JSON.stringify(models)).not.toMatch(/secret|authorization|rawResponse/);
  });

  it("retains provider-discovered Claude effort while dropping undeclared fields", () => {
    const models = sanitizeModels([{ id: "opus", name: "Opus", provider: "claude", capabilities: { reasoning: true, execution: { kind: "anthropic_effort", label: "Effort", control: "select", values: [{ value: "xhigh", label: "Xhigh" }], provenance: "provider_discovery", privateMetadata: "secret" } as any } }]);
    expect(models).toEqual([{ id: "opus", name: "Opus", capabilities: { reasoning: true, execution: { kind: "anthropic_effort", label: "Effort", control: "select", values: [{ value: "xhigh", label: "Xhigh" }], provenance: "provider_discovery" } } }]);
    expect(JSON.stringify(models)).not.toContain("privateMetadata");
  });
});
