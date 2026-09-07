import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, providerSecretKey } from "../src/provider-config.js";

describe("VS Code gateway request budgets", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the longer generation budget with the existing SecretStorage config and no idle work", async () => {
    vi.useFakeTimers();
    const config = Object.freeze({ id: "9router", type: "openai-compatible" as const, displayName: "Gateway", baseUrl: "https://router.invalid/v1", authStrategy: "api_key" as const, modelId: "route/model" });
    const before = JSON.stringify(config);
    const secrets = { get: vi.fn(async () => "test-only-key"), store: vi.fn(), delete: vi.fn() };
    let signal: AbortSignal | undefined;
    let finish: (response: Response) => void = () => { throw new Error("Request has not started"); };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((resolve, reject) => {
      signal = init?.signal ?? undefined;
      const aborted = () => reject(signal?.reason);
      signal?.addEventListener("abort", aborted, { once: true });
      finish = (response) => { signal?.removeEventListener("abort", aborted); resolve(response); };
    }));
    const provider = createProvider(config, secrets);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const caller = new AbortController();
    const pending = provider.generate({ model: "route/model", prompt: "test task", executionOptions: { kind: "provider_default" }, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect((request?.headers as Headers).get("Authorization")).toBe("Bearer test-only-key");
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "route/model", stream: false });
    expect(secrets.get).toHaveBeenCalledWith(providerSecretKey("9router"));
    finish(new Response(JSON.stringify({ model: "route/model", choices: [{ message: { content: "done" } }] })));
    await expect(pending).resolves.toMatchObject({ text: "done" });

    expect(JSON.stringify(config)).toBe(before);
    expect(secrets.store).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
