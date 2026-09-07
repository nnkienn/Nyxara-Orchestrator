import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider, GeminiProvider } from "../src/index.js";

const credentials = { get: async () => "test-only-key", set: vi.fn(), delete: vi.fn() };
const providers = [
  ["Anthropic", (transport: typeof fetch) => new AnthropicProvider({ credentialStore: credentials, fetch: transport })],
  ["Gemini", (transport: typeof fetch) => new GeminiProvider({ credentialStore: credentials, fetch: transport })],
] as const;

describe("official provider cancellation budgets", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(providers)("%s retains its existing deadline when Planner supplies a cancellation signal", async (_name, create) => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const transport = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      started();
    }));
    const provider = create(transport as typeof fetch);
    const assertion = expect(provider.generate({ model: "model-test", prompt: "test", signal: caller.signal })).rejects.toMatchObject({ code: "timeout_error" });
    await ready;
    expect(timeout).toHaveBeenCalledWith(30_000);
    deadline.abort(new DOMException("Provider deadline", "TimeoutError"));
    await assertion;
    expect(caller.signal.aborted).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(providers)("%s still honors caller cancellation before its deadline", async (_name, create) => {
    const deadline = new AbortController();
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const transport = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      started();
    }));
    const provider = create(transport as typeof fetch);
    const assertion = expect(provider.generate({ model: "model-test", prompt: "test", signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await ready;
    caller.abort();
    await assertion;
    expect(deadline.signal.aborted).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
