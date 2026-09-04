import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@nyxara/provider-sdk";
import { AnthropicProvider } from "../src/anthropic/anthropic-provider.js";

describe("AnthropicProvider", () => {
  it("discovers official models with SecretStorage-backed x-api-key auth", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Headers).get("x-api-key")).toBe("fake-key");
      expect((init.headers as Headers).get("anthropic-version")).toBe("2023-06-01");
      return new Response(JSON.stringify({ data: [{ id: "claude-test", display_name: "Claude Test" }] }), { status: 200 });
    });
    const provider = new AnthropicProvider({ id: "anthropic-work", credentialStore: { get: async () => "fake-key", set: vi.fn(), delete: vi.fn() }, credentialKey: "provider/anthropic-work/api-key", fetch: fetch as any });
    await expect(provider.listModels()).resolves.toEqual([{ id: "claude-test", name: "Claude Test", provider: "anthropic-work" }]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models");
  });

  it("normalizes text, tool calls, usage, and preserves requested vs resolved model identity", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("requested/model-exact"); expect(body.messages[1].content[0].type).toBe("tool_use"); expect(body.messages[2].content[0].type).toBe("tool_result");
      return new Response(JSON.stringify({ id: "msg-1", model: "resolved-model", content: [{ type: "text", text: "done" }, { type: "tool_use", id: "tool-2", name: "read_file", input: { path: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 12, output_tokens: 3 } }), { status: 200 });
    });
    const provider = new AnthropicProvider({ credentialStore: { get: async () => "fake", set: vi.fn(), delete: vi.fn() }, fetch: fetch as any });
    const response = await provider.generate({ model: "requested/model-exact", prompt: "work", tools: [{ name: "read_file", description: "read", inputSchema: {} }], conversation: [{ role: "assistant", toolCalls: [{ id: "tool-1", name: "read_file", arguments: { path: "a" } }] }, { role: "tool", toolResult: { callId: "tool-1", name: "read_file", result: "ok" } }] });
    expect(response).toMatchObject({ provider: "anthropic", model: "resolved-model", text: "done", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, toolCalls: [{ id: "tool-2", name: "read_file", arguments: { path: "x" } }] });
  });

  it.each([[401, "authentication_error"], [429, "rate_limit_error"]] as const)("maps HTTP %s safely", async (status, code) => {
    const provider = new AnthropicProvider({ credentialStore: { get: async () => "hidden", set: vi.fn(), delete: vi.fn() }, fetch: vi.fn(async () => new Response("secret payload", { status })) as any });
    await expect(provider.listModels()).rejects.toMatchObject<Partial<ProviderError>>({ code, statusCode: status });
  });

  it("requires credentials without making a network call", async () => {
    const fetch = vi.fn(); const provider = new AnthropicProvider({ credentialStore: { get: async () => undefined, set: vi.fn(), delete: vi.fn() }, fetch: fetch as any });
    await expect(provider.listModels()).rejects.toMatchObject({ code: "authentication_error" }); expect(fetch).not.toHaveBeenCalled();
  });
});
