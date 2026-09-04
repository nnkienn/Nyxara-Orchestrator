import type {
  GenerateRequest,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  NyxaraOrchestrator,
  ProviderRegistry,
  ProviderRegistryError,
} from "../src/index.js";

function createProvider(id = "fake"): ModelProvider {
  return {
    id,
    displayName: "Fake Provider",
    capabilities() {
      return { modelDiscovery: true, textGeneration: true };
    },
    async listModels() {
      return [{ id: "model-1", name: "Model 1", provider: id }];
    },
    async generate(request: GenerateRequest) {
      return {
        provider: id,
        model: request.model,
        text: `Generated: ${request.prompt}`,
      };
    },
  };
}

describe("ProviderRegistry", () => {
  it("registers and retrieves a provider", () => {
    const registry = new ProviderRegistry();
    const provider = createProvider();

    registry.register(provider);

    expect(registry.get("fake")).toBe(provider);
    expect(registry.list()).toEqual([
      {
        id: "fake",
        displayName: "Fake Provider",
        capabilities: { modelDiscovery: true, textGeneration: true },
      },
    ]);
  });

  it("rejects duplicate provider IDs", () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider());

    expect(() => registry.register(createProvider())).toThrowError(
      expect.objectContaining({ code: "duplicate_provider" }),
    );
  });

  it("replaces one registered adapter without changing its stable provider identity", () => {
    const registry = new ProviderRegistry();
    const original = createProvider("work-gateway");
    const replacement = { ...createProvider("work-gateway"), displayName: "Renamed Work Gateway" };
    registry.register(original);
    registry.replace(replacement);
    expect(registry.get("work-gateway")).toBe(replacement);
    expect(registry.list()[0]).toMatchObject({ id: "work-gateway", displayName: "Renamed Work Gateway" });
  });

  it("unregisters only the selected provider adapter", () => {
    const registry = new ProviderRegistry(); registry.register(createProvider("one")); registry.register(createProvider("two")); expect(registry.unregister("one")).toBe(true); expect(registry.unregister("missing")).toBe(false); expect(registry.list().map((provider) => provider.id)).toEqual(["two"]);
  });

  it("returns a controlled error for an unknown provider", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.get("missing")).toThrowError(
      expect.objectContaining({
        name: "ProviderRegistryError",
        code: "unknown_provider",
        providerId: "missing",
      }),
    );
  });

  it("exposes a typed registry error", () => {
    const error = new ProviderRegistryError(
      "unknown_provider",
      "missing",
      "Provider is not registered: missing",
    );

    expect(error).toBeInstanceOf(Error);
  });
});

describe("NyxaraOrchestrator provider delegation", () => {
  it("exposes provider-neutral adapter removal without rewriting role assignments", () => {
    const nyxara = new NyxaraOrchestrator({ providers: [createProvider("stable"), createProvider("other")] }); nyxara.configureAgent({ role: "planner", providerId: "stable", modelId: "model" }); expect(nyxara.unregisterProvider("stable")).toBe(true); expect(nyxara.listProviders().map((provider) => provider.id)).toEqual(["other"]); expect(nyxara.getAgentModel("planner")).toEqual({ role: "planner", providerId: "stable", modelId: "model" });
  });
  it("replaces provider transport without changing configured role semantics", () => {
    const nyxara = new NyxaraOrchestrator({ providers: [createProvider("stable")] });
    nyxara.configureAgent({ role: "planner", providerId: "stable", modelId: "requested/model" });
    nyxara.replaceProvider({ ...createProvider("stable"), displayName: "Updated transport" });
    expect(nyxara.getAgentModel("planner")).toEqual({ role: "planner", providerId: "stable", modelId: "requested/model" });
    expect(nyxara.listProviders()[0]).toMatchObject({ id: "stable", displayName: "Updated transport" });
  });

  it("lists models and generates through a registered provider", async () => {
    const provider = createProvider();
    const generateSpy = vi.spyOn(provider, "generate");
    const nyxara = new NyxaraOrchestrator({ providers: [provider] });
    const generationEvents: unknown[] = [];
    nyxara.events.on("provider.generation.completed", (payload) => {
      generationEvents.push(payload);
    });

    await expect(nyxara.listModels("fake")).resolves.toEqual([
      { id: "model-1", name: "Model 1", provider: "fake" },
    ]);
    await expect(
      nyxara.generate({
        providerId: "fake",
        model: "model-1",
        prompt: "hello",
      }),
    ).resolves.toMatchObject({ text: "Generated: hello" });
    expect(generateSpy).toHaveBeenCalledWith({
      model: "model-1",
      prompt: "hello",
    });
    expect(generationEvents).toEqual([
      {
        providerId: "fake",
        modelId: "model-1",
        textLength: "Generated: hello".length,
        toolCallCount: 0,
      },
    ]);
  });
});
