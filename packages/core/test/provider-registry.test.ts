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
