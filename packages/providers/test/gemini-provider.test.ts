import { describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../src/gemini/gemini-provider.js";

const credentials = (value: string | undefined = "fake-gemini-key") => ({
  get: vi.fn(async () => value),
  set: vi.fn(async () => {}),
  delete: vi.fn(async () => {}),
});

describe("GeminiProvider", () => {
  it("discovers generative models with scoped API-key auth", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Headers).get("x-goog-api-key")).toBe("fake-gemini-key");
      return new Response(JSON.stringify({ models: [
        { name: "models/gemini-test", displayName: "Gemini Test", inputTokenLimit: 32_768, supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-test", supportedGenerationMethods: ["embedContent"] },
      ] }), { status: 200 });
    });
    const provider = new GeminiProvider({ id: "gemini-work", credentialStore: credentials(), credentialKey: "provider/gemini-work/api-key", fetch: fetch as any });

    await expect(provider.listModels()).resolves.toEqual([{
      id: "gemini-test",
      name: "Gemini Test",
      provider: "gemini-work",
      contextWindow: 32_768,
      capabilities: { text: true, tools: true, structuredOutput: true },
    }]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("normalizes text, function calls, usage, and exact model routing", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "work" }] });
      expect(body.tools[0].functionDeclarations[0].name).toBe("read_file");
      expect(body.generationConfig).toEqual({ responseMimeType: "application/json" });
      return new Response(JSON.stringify({
        candidates: [{ modelVersion: "gemini-resolved", finishReason: "STOP", content: { parts: [
          { text: "done" },
          { functionCall: { name: "read_file", args: { path: "src/index.ts" } } },
        ] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      }), { status: 200 });
    });
    const provider = new GeminiProvider({ credentialStore: credentials(), fetch: fetch as any });

    await expect(provider.generate({
      model: "models/gemini-requested",
      prompt: "work",
      responseFormat: "json",
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
    })).resolves.toMatchObject({
      provider: "gemini",
      model: "gemini-resolved",
      text: "done",
      finishReason: "STOP",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      toolCalls: [{ id: "gemini-call-1", name: "read_file", arguments: { path: "src/index.ts" } }],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-requested:generateContent");
  });

  it.each([[401, "authentication_error"], [429, "rate_limit_error"], [404, "invalid_model"]] as const)("maps generation HTTP %s safely", async (status, code) => {
    const provider = new GeminiProvider({ credentialStore: credentials(), fetch: vi.fn(async () => new Response("secret payload", { status })) as any });
    await expect(provider.generate({ model: "exact/model", prompt: "work" })).rejects.toMatchObject({ code, statusCode: status });
  });

  it("requires credentials without making a network call", async () => {
    const fetch = vi.fn();
    const provider = new GeminiProvider({ credentialStore: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) }, fetch: fetch as any });
    await expect(provider.listModels()).rejects.toMatchObject({ code: "authentication_error" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps Gemini 2.5 budgets and Gemini 3 levels only for known models", async () => {
    const bodies: any[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 }); });
    const provider = new GeminiProvider({ credentialStore: credentials(), fetch: fetch as any });
    expect(provider.modelCapabilities("gemini-2.5-pro")?.execution).toMatchObject({ kind: "gemini_thinking_budget", minimumBudgetTokens: 128 });
    expect(provider.modelCapabilities("gemini-3-flash")?.execution).toMatchObject({ kind: "gemini_thinking_level", provenance: "adapter_known" });
    await provider.generate({ model: "gemini-2.5-pro", prompt: "x", executionOptions: { kind: "provider_default" } });
    await provider.generate({ model: "gemini-2.5-pro", prompt: "x", executionOptions: { kind: "gemini_thinking_budget", budgetTokens: 1024 } });
    await provider.generate({ model: "gemini-3-flash", prompt: "x", executionOptions: { kind: "gemini_thinking_level", level: "high" } });
    expect(bodies[0]).not.toHaveProperty("generationConfig");
    expect(bodies[1]).toMatchObject({ generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } });
    expect(bodies[2]).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } });
    expect(JSON.stringify(bodies)).not.toMatch(/reasoning_effort|budget_tokens/);
  });

  it("rejects invalid and foreign execution options before Gemini fetch", async () => {
    const fetch = vi.fn(); const provider = new GeminiProvider({ credentialStore: credentials(), fetch: fetch as any });
    await expect(provider.generate({ model: "gemini-2.5-pro", prompt: "x", executionOptions: { kind: "gemini_thinking_budget", budgetTokens: 0 } })).rejects.toMatchObject({ code: "unsupported_execution_profile" });
    await expect(provider.generate({ model: "gemini-3-flash", prompt: "x", executionOptions: { kind: "gemini_thinking_level", level: "xhigh" } })).rejects.toMatchObject({ code: "unsupported_execution_profile" });
    await expect(provider.generate({ model: "gemini-3-flash", prompt: "x", executionOptions: { kind: "anthropic_thinking", enabled: true, budgetTokens: 2048 } })).rejects.toMatchObject({ code: "unsupported_execution_profile" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps Gemini thought signatures adapter-local across a function-call continuation", async () => {
    const bodies: any[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "x" } }, thoughtSignature: "opaque-sig" }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "done" }] } }] }), { status: 200 });
    });
    const provider = new GeminiProvider({ credentialStore: credentials(), fetch: fetch as any });
    const first = await provider.generate({ model: "gemini-3-flash-preview", prompt: "x", executionOptions: { kind: "gemini_thinking_level", level: "low" } });
    expect(first).not.toHaveProperty("thoughtSignature");
    await provider.generate({ model: "gemini-3-flash-preview", prompt: "x", executionOptions: { kind: "gemini_thinking_level", level: "low" }, conversation: [
      { role: "assistant", toolCalls: first.toolCalls },
      { role: "tool", toolResult: { callId: first.toolCalls![0]!.id, name: "read_file", result: "ok" } },
    ] });
    expect(bodies[1].contents[1].parts[0]).toEqual({ functionCall: { name: "read_file", args: { path: "x" } }, thoughtSignature: "opaque-sig" });
    expect(JSON.stringify(first)).not.toContain("opaque-sig");
  });
});
