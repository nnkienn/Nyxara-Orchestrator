import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/index.js";

function generationResponse(): Response {
  return new Response(JSON.stringify({ model: "route/model", choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
}

function pendingFetch() {
  let requestSignal: AbortSignal | undefined;
  let complete: (response: Response) => void = () => { throw new Error("Request has not started"); };
  const mock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    requestSignal = init?.signal ?? undefined;
    const aborted = () => reject(requestSignal?.reason);
    requestSignal?.addEventListener("abort", aborted, { once: true });
    complete = (response) => {
      requestSignal?.removeEventListener("abort", aborted);
      resolve(response);
    };
  }));
  return { fetch: mock as typeof fetch, mock, signal: () => requestSignal, complete: (response: Response) => complete(response) };
}

function pendingBodyFetch() {
  let complete: (text: string) => void = () => { throw new Error("Request has not started"); };
  const mock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const aborted = () => controller.error(signal?.reason);
        signal?.addEventListener("abort", aborted, { once: true });
        complete = (text) => {
          signal?.removeEventListener("abort", aborted);
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        };
      },
    });
    return new Response(body);
  });
  return { fetch: mock as typeof fetch, mock, complete: (text: string) => complete(text) };
}

describe("OpenAI-compatible request deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows a non-streaming gateway response after the former 30-second limit", async () => {
    const transport = pendingFetch();
    const provider = new OpenAICompatibleProvider({ id: "9router", providerId: "openai-compatible", fetch: transport.fetch });
    const pending = provider.generate({ model: "route/model", prompt: "task", executionOptions: { kind: "provider_default" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.signal()?.aborted).toBe(false);
    expect(JSON.parse(String(transport.mock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "route/model", stream: false });
    transport.complete(generationResponse());
    await expect(pending).resolves.toMatchObject({ text: "done", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
    expect(transport.mock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still bounds model discovery at 30 seconds and identifies the endpoint", async () => {
    const transport = pendingFetch();
    const provider = new OpenAICompatibleProvider({ id: "router", fetch: transport.fetch });
    const assertion = expect(provider.listModels()).rejects.toMatchObject({
      code: "timeout_error", providerId: "router", message: "Provider model discovery request timed out after 30s (/models)",
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(transport.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(transport.mock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds generation at five minutes with caller signal=%s", async (withCallerSignal) => {
    const transport = pendingFetch();
    const caller = new AbortController();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const assertion = expect(provider.generate({ model: "route/model", prompt: "task", ...(withCallerSignal ? { signal: caller.signal } : {}) })).rejects.toMatchObject({
      code: "timeout_error", message: "Provider generation request timed out after 300s (/chat/completions)",
    });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(transport.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(caller.signal.aborted).toBe(false);
    expect(transport.mock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation before headers without waiting for the deadline", async () => {
    const transport = pendingFetch();
    const caller = new AbortController();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const reason = new DOMException("Task cancelled", "AbortError");
    const assertion = expect(provider.generate({ model: "route/model", prompt: "task", signal: caller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(reason);
    await assertion;
    expect(transport.signal()?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send an already-cancelled request", async () => {
    const transport = pendingFetch();
    const caller = new AbortController();
    caller.abort();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task", signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(transport.mock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a response racing with caller cancellation", async () => {
    const caller = new AbortController();
    const fetchMock = vi.fn(async () => { caller.abort(); return generationResponse(); });
    const provider = new OpenAICompatibleProvider({ fetch: fetchMock as typeof fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task", signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks cancellation again after resolving the stored credential", async () => {
    const transport = pendingFetch();
    const caller = new AbortController();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch, credentialStore: {
      get: async () => { caller.abort(); return "test-only-key"; },
      set: vi.fn(), delete: vi.fn(),
    } });
    await expect(provider.generate({ model: "route/model", prompt: "task", signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(transport.mock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while reading the JSON body and reports timeout rather than invalid JSON", async () => {
    const transport = pendingBodyFetch();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const assertion = expect(provider.generate({ model: "route/model", prompt: "task" })).rejects.toMatchObject({ code: "timeout_error", message: expect.stringContaining("300s (/chat/completions)") });
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds discovery response-body reads at 30 seconds", async () => {
    const transport = pendingBodyFetch();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const assertion = expect(provider.listModels()).rejects.toMatchObject({ code: "timeout_error", message: expect.stringContaining("30s (/models)") });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a slow JSON body to complete within the generation budget", async () => {
    const transport = pendingBodyFetch();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const pending = provider.generate({ model: "route/model", prompt: "task" });
    await vi.advanceTimersByTimeAsync(60_000);
    transport.complete(await generationResponse().text());
    await expect(pending).resolves.toMatchObject({ text: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["openai-compatible", "openai"])("preserves caller cancellation during %s response consumption", async (providerId) => {
    const transport = pendingBodyFetch();
    const caller = new AbortController();
    const provider = new OpenAICompatibleProvider({ providerId, fetch: transport.fetch });
    const reason = new DOMException("Task cancelled", "AbortError");
    const assertion = expect(provider.generate({ model: "route/model", prompt: "task", signal: caller.signal, onProgress: vi.fn() })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(reason);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an official OpenAI stream without masking timeout as an invalid stream", async () => {
    const transport = pendingBodyFetch();
    const provider = new OpenAICompatibleProvider({ providerId: "openai", fetch: transport.fetch });
    const assertion = expect(provider.generate({ model: "route/model", prompt: "task", onProgress: vi.fn() })).rejects.toMatchObject({ code: "timeout_error" });
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves real OpenAI streaming and usage after a slow response", async () => {
    const transport = pendingBodyFetch();
    const progress = vi.fn();
    const provider = new OpenAICompatibleProvider({ providerId: "openai", fetch: transport.fetch });
    const pending = provider.generate({ model: "route/model", prompt: "task", onProgress: progress });
    await vi.advanceTimersByTimeAsync(60_000);
    transport.complete(`data: ${JSON.stringify({ model: "route/model", choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    await expect(pending).resolves.toMatchObject({ text: "done", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(["request_started", "response_started", "output_receiving", "request_completed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the deadline and caller listener after success", async () => {
    const transport = pendingFetch();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const pending = provider.generate({ model: "route/model", prompt: "task", signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    transport.complete(generationResponse());
    await pending;
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    caller.abort();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(transport.signal()?.aborted).toBe(false);
  });

  it("keeps a real upstream 502 distinct from client timeout and never retries", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream failure", { status: 502 }));
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const provider = new OpenAICompatibleProvider({ fetch: fetchMock as typeof fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task", signal: caller.signal })).rejects.toMatchObject({ code: "provider_error", statusCode: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps malformed JSON distinct from timeout and cleans up the timer", async () => {
    const provider = new OpenAICompatibleProvider({ fetch: vi.fn(async () => new Response("not json")) as typeof fetch });
    await expect(provider.generate({ model: "route/model", prompt: "task" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps independent deadlines for simultaneous requests", async () => {
    const transport = pendingFetch();
    const caller = new AbortController();
    const otherTransport = pendingFetch();
    const provider = new OpenAICompatibleProvider({ fetch: transport.fetch });
    const otherProvider = new OpenAICompatibleProvider({ fetch: otherTransport.fetch });
    const assertion = expect(provider.generate({ model: "route/model", prompt: "first", signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const otherPending = otherProvider.generate({ model: "route/model", prompt: "second" });
    await vi.advanceTimersByTimeAsync(60_000);
    caller.abort();
    await assertion;
    expect(otherTransport.signal()?.aborted).toBe(false);
    otherTransport.complete(generationResponse());
    await expect(otherPending).resolves.toMatchObject({ text: "done" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
