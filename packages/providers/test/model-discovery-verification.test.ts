import { describe, it, expect, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/openai-compatible/openai-compatible-provider.js";
import { AnthropicProvider } from "../src/anthropic/anthropic-provider.js";
import { sanitizeModels } from "../../../apps/vscode/src/model-discovery.js";
import type { CredentialStore } from "@nyxara/provider-sdk";

describe("Model Discovery - Complete Pipeline Verification", () => {
  it("OpenAI: preserves all discovered models including Terra/Luna/Sol variants", async () => {
    const mockFetch = vi.fn(async () => 
      new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "gpt-5.6-sol-20260901", name: "GPT-5.6 Sol" },
          { id: "gpt-5.6-terra-20260901", name: "GPT-5.6 Terra" },
          { id: "gpt-5.6-luna-20260901", name: "GPT-5.6 Luna" },
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "o1", name: "o1" },
        ]
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      id: "openai-test",
      providerId: "openai",
      apiKey: "test-key",
      fetch: mockFetch
    });

    const rawModels = await provider.listModels();
    expect(rawModels).toHaveLength(5);
    expect(rawModels.map(m => m.id)).toEqual([
      "gpt-5.6-sol-20260901",
      "gpt-5.6-terra-20260901", 
      "gpt-5.6-luna-20260901",
      "gpt-4o",
      "o1"
    ]);

    const sanitized = sanitizeModels(rawModels);
    expect(sanitized).toHaveLength(5);
    expect(sanitized.map(m => m.id)).toEqual(rawModels.map(m => m.id));
  });

  it("Anthropic: preserves all Claude variants including Opus/Sonnet/Haiku", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "claude-opus-4-20260901", display_name: "Claude Opus 4", type: "model" },
          { id: "claude-sonnet-4-20260901", display_name: "Claude Sonnet 4", type: "model" },
          { id: "claude-haiku-4-20260901", display_name: "Claude Haiku 4", type: "model" },
          { id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet", type: "model" },
        ],
        has_more: false
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;

    const mockCredentialStore: CredentialStore = {
      get: vi.fn(async () => "test-api-key"),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {})
    };

    const provider = new AnthropicProvider({
      id: "anthropic-test",
      providerId: "anthropic",
      credentialStore: mockCredentialStore,
      fetch: mockFetch
    });

    const rawModels = await provider.listModels();
    expect(rawModels).toHaveLength(4);
    expect(rawModels.map(m => m.id)).toEqual([
      "claude-opus-4-20260901",
      "claude-sonnet-4-20260901",
      "claude-haiku-4-20260901",
      "claude-3-7-sonnet-20250219"
    ]);

    const sanitized = sanitizeModels(rawModels);
    expect(sanitized).toHaveLength(4);
    expect(sanitized.map(m => m.id)).toEqual(rawModels.map(m => m.id));
  });

  it("sanitizeModels: filters only invalid models, preserves all valid ones", () => {
    const models = [
      { id: "valid-1", name: "Valid 1", provider: "test" },
      { id: "", name: "Invalid - empty ID", provider: "test" },
      { id: "valid-2", name: "Valid 2", provider: "test" },
      { id: "valid-1", name: "Duplicate", provider: "test" },
      { id: "valid-3", name: "Valid 3", provider: "test" },
    ];

    const result = sanitizeModels(models as any);
    expect(result).toHaveLength(3);
    expect(result.map(m => m.id)).toEqual(["valid-1", "valid-2", "valid-3"]);
  });
});
