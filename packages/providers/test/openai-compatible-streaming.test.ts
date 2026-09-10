import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/index.js";

function streamResponse(events: readonly object[], done = true): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "Content-Type": "text/event-stream" } });
}

const events = [
  { model: "resolved-model", choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4608, completion_tokens: 5, total_tokens: 4613 } },
];

function pendingStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  return {
    fetch, signal: () => signal,
    send: (event: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    finish: () => { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); },
  };
}

describe("explicit compatible gateway streaming", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("does not infer streaming from a gateway name, model, or endpoint", () => {
    const fetch = vi.fn();
    const generic = new OpenAICompatibleProvider({ id: "9router", providerId: "openai-compatible", baseUrl: "https://router.invalid/v1", fetch });
    expect(generic.capabilities().progressStreaming).toBe(false);
    expect(new OpenAICompatibleProvider({ providerId: "openai" }).capabilities().progressStreaming).toBe(true);
    expect(new OpenAICompatibleProvider({ providerId: "openai", streaming: false }).capabilities().progressStreaming).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("uses explicit SSE with progress callback=%s and preserves model, budget, usage, and credentials", async (withProgress) => {
    const fetch = vi.fn(async () => streamResponse(events));
    const progress = vi.fn();
    const credentials = { get: vi.fn(async () => "test-only-key"), set: vi.fn(), delete: vi.fn() };
    const provider = new OpenAICompatibleProvider({ providerId: "openai-compatible", streaming: true, fetch, credentialStore: credentials });
    const response = await provider.generate({ model: "route/model", prompt: "private-prompt", maxOutputTokens: 1024, ...(withProgress ? { onProgress: progress } : {}) });
    expect(response).toMatchObject({ model: "resolved-model", text: '{"ok":true}', finishReason: "stop", usage: { inputTokens: 4608, outputTokens: 5, totalTokens: 4613 } });
    expect(fetch).toHaveBeenCalledOnce();
    const init = (fetch.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]![1];
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "route/model", max_tokens: 1024, stream: true, stream_options: { include_usage: true } });
    expect(new Headers(init.headers).get("Accept")).toBe("text/event-stream");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-only-key");
    if (withProgress) expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(["request_started", "response_started", "output_receiving", "request_completed"]);
    else expect(progress).not.toHaveBeenCalled();
    expect(JSON.stringify(progress.mock.calls)).not.toMatch(/private-prompt|test-only-key|"ok"/);
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("assembles streamed executor tool calls without executing them", async () => {
    const fetch = vi.fn(async () => streamResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/app.ts"}' } }] }, finish_reason: "tool_calls" }] },
    ]));
    const provider = new OpenAICompatibleProvider({ streaming: true, fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task" })).resolves.toMatchObject({ text: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/app.ts" } }], finishReason: "tool_calls" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects premature EOF even when accumulated text is valid JSON", async () => {
    const fetch = vi.fn(async () => streamResponse(events.slice(0, 2), false));
    const progress = vi.fn();
    const provider = new OpenAICompatibleProvider({ streaming: true, fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task", onProgress: progress })).rejects.toMatchObject({ code: "invalid_response", message: "Provider stream ended before completion" });
    expect(progress.mock.calls.map(([event]) => event.phase)).not.toContain("request_completed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not treat reasoning-only or empty deltas as answer text or receiving progress", async () => {
    const fetch = vi.fn(async () => streamResponse([{ choices: [{ delta: { content: "", reasoning_content: '{"ok":true}' }, finish_reason: "stop" }] }]));
    const progress = vi.fn();
    const provider = new OpenAICompatibleProvider({ streaming: true, fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task", onProgress: progress })).rejects.toMatchObject({ code: "invalid_response" });
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(["request_started", "response_started"]);
  });

  it("surfaces the provider stream error code and message without leaking unrelated body data", async () => {
    const fetch = vi.fn(async () => streamResponse([{ error: { message: "model overloaded", type: "server_error", code: "overloaded", private: "secret" } }]));
    await expect(new OpenAICompatibleProvider({ streaming: true, fetch }).generate({ model: "route/model", prompt: "task" })).rejects.toMatchObject({ code: "provider_error", message: "model overloaded (server_error / overloaded)" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports real progress during a slow body, keeping the five-minute budget", async () => {
    const transport = pendingStream();
    const progress = vi.fn();
    const provider = new OpenAICompatibleProvider({ streaming: true, fetch: transport.fetch });
    const pending = provider.generate({ model: "route/model", prompt: "task", onProgress: progress });
    await vi.advanceTimersByTimeAsync(60_000);
    transport.send(events[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(["request_started", "response_started"]);
    transport.send(events[1]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.mock.calls.map(([event]) => event.phase)).toContain("output_receiving");
    expect(transport.signal()?.aborted).toBe(false);
    transport.finish();
    await expect(pending).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still times out a stalled opted-in stream and cleans its timer", async () => {
    const transport = pendingStream();
    const assertion = expect(new OpenAICompatibleProvider({ streaming: true, fetch: transport.fetch }).generate({ model: "route/model", prompt: "task" })).rejects.toMatchObject({ code: "timeout_error" });
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation during a stream without retrying", async () => {
    const transport = pendingStream();
    const caller = new AbortController();
    const reason = new Error("cancelled-by-test");
    const assertion = expect(new OpenAICompatibleProvider({ streaming: true, fetch: transport.fetch }).generate({ model: "route/model", prompt: "task", signal: caller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(reason);
    await assertion;
    expect(transport.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
