import { describe, expect, it, vi } from "vitest";
import { CLI_SESSION_STATE_KEY, ProviderCliSessionStore } from "../src/provider-connection-state.js";
import type { ProviderConfig } from "../src/provider-config.js";
import { providerStatus } from "../src/settings-projection.js";

const codex: ProviderConfig = { id: "codex-work", type: "codex-cli", displayName: "Codex Work", authStrategy: "subscription_cli" };
const claude: ProviderConfig = { id: "claude-work", type: "claude-code-cli", displayName: "Claude Work", authStrategy: "subscription_cli" };
const gemini: ProviderConfig = { id: "gemini-work", type: "gemini-cli", displayName: "Gemini Work", authStrategy: "subscription_cli" };
const api: ProviderConfig = { id: "api", type: "openai", displayName: "API", authStrategy: "api_key" };

function storage(initial: unknown = []) {
  const values = new Map<string, unknown>([[CLI_SESSION_STATE_KEY, initial]]);
  return { get: vi.fn((key: string, fallback: unknown) => values.get(key) ?? fallback), update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) };
}

describe("provider connection reload evidence", () => {
  it.each([codex, claude])("restores $type session evidence without restoring live verification", async (config) => {
    const saved = storage();
    const first = new ProviderCliSessionStore(saved);
    await first.record(config, "present");
    const reloaded = new ProviderCliSessionStore(saved);
    expect(reloaded.get(config)).toEqual(first.get(config));
    expect(reloaded.get(config)).toMatchObject({ providerConfigId: config.id, adapterId: config.type, state: "present", checkedAt: expect.any(String) });
    expect(providerStatus(config, false, false, reloaded.get(config))).toBe("Session recorded");
    expect(providerStatus(config, false, true, reloaded.get(config))).toBe("Session verified");
    expect(saved.update).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "unavailable"] as const)("retains explicitly observed %s CLI state", async (state) => {
    const saved = storage();
    await new ProviderCliSessionStore(saved).record(codex, state);
    const evidence = new ProviderCliSessionStore(saved).get(codex);
    expect(providerStatus(codex, false, false, evidence)).toBe(state === "missing" ? "Credential missing" : "Unavailable");
    expect(providerStatus({ ...codex, signedOut: true }, false, true, evidence)).toBe("Signed out");
  });

  it("does not invent a session from CLI configuration, installation, or an API key", () => {
    expect(providerStatus(codex, false)).toBe("CLI configured");
    expect(providerStatus(gemini, false, true)).toBe("CLI available");
    expect(providerStatus(api, true)).toBe("Credential present");
    expect(providerStatus(api, false, true)).toBe("Credential missing");
  });

  it("isolates evidence by provider instance and adapter and clears removed sessions", async () => {
    const saved = storage();
    const sessions = new ProviderCliSessionStore(saved);
    await sessions.record(codex, "present");
    expect(sessions.get(claude)).toBeUndefined();
    expect(sessions.get({ ...claude, id: codex.id })).toBeUndefined();
    expect(sessions.get({ ...api, id: codex.id })).toBeUndefined();
    await sessions.clear(codex.id);
    expect(new ProviderCliSessionStore(saved).get(codex)).toBeUndefined();
  });

  it("does not persist API credentials or live verification", async () => {
    const saved = storage();
    const sessions = new ProviderCliSessionStore(saved);
    await sessions.record(api, "present");
    expect(saved.update).not.toHaveBeenCalled();
    await sessions.record(codex, "present");
    const value = saved.update.mock.calls[0]![1] as object[];
    expect(Object.keys(value[0]!).sort()).toEqual(["adapterId", "checkedAt", "providerConfigId", "state"]);
  });

  it.each([null, {}, "bad data", [null, {}, { providerConfigId: codex.id, adapterId: codex.type, state: "present", checkedAt: "bad date" }]])("ignores malformed local evidence: %j", (initial) => {
    const saved = storage(initial);
    expect(new ProviderCliSessionStore(saved).get(codex)).toBeUndefined();
    expect(saved.update).not.toHaveBeenCalled();
  });

  it("restores only allowlisted fields from persisted evidence", () => {
    const saved = storage([{ providerConfigId: codex.id, adapterId: codex.type, state: "present", checkedAt: "2026-09-07T00:00:00.000Z", token: "not-for-projection", liveVerified: true }]);
    const evidence = new ProviderCliSessionStore(saved).get(codex);
    expect(evidence).not.toHaveProperty("token");
    expect(evidence).not.toHaveProperty("liveVerified");
  });
});
