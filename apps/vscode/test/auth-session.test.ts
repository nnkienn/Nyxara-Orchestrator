import { describe, expect, it, vi } from "vitest";
import { AuthSessionController, AuthSessionError } from "../src/auth-session.js";

describe("bounded browser authentication sessions", () => {
  it("starts once and creates provider-scoped pending state", () => {
    let sequence = 0; const auth = new AuthSessionController(() => 1_000, () => `random-${++sequence}`);
    const pending = auth.start("codex-work", "subscription_cli", 5_000);
    expect(pending).toEqual({ providerConfigId: "codex-work", authMethod: "subscription_cli", sessionId: "random-1", state: "random-2", startedAt: 1_000, expiresAt: 6_000 });
    expect(() => auth.start("codex-work", "subscription_cli")).toThrowError(expect.objectContaining({ code: "already_pending" }));
  });

  it("accepts one valid completion and rejects invalid state and replay", async () => {
    const auth = new AuthSessionController(() => 1_000, () => "fixed"); const pending = auth.start("codex", "subscription_cli"); const finalize = vi.fn(async () => {});
    await expect(auth.complete("codex", pending.sessionId, "wrong", finalize)).rejects.toMatchObject({ code: "invalid_state" });
    expect(auth.get("codex")).toEqual(pending); expect(finalize).not.toHaveBeenCalled();
    await auth.complete("codex", pending.sessionId, pending.state, finalize); expect(finalize).toHaveBeenCalledOnce(); expect(auth.get("codex")).toBeUndefined();
    await expect(auth.complete("codex", pending.sessionId, pending.state, finalize)).rejects.toMatchObject({ code: "replayed_callback" });
  });

  it("rejects expired and unknown callbacks and cleans pending state", async () => {
    let now = 10; const auth = new AuthSessionController(() => now, () => "fixed"); const pending = auth.start("claude", "subscription_cli", 5); now = 15;
    await expect(auth.complete("claude", pending.sessionId, pending.state, async () => {})).rejects.toEqual(expect.objectContaining<AuthSessionError>({ code: "expired_callback" }));
    expect(auth.get("claude")).toBeUndefined();
    await expect(auth.complete("missing", "unknown", "unknown", async () => {})).rejects.toMatchObject({ code: "unknown_callback" });
  });

  it("cancels exactly one matching pending session", () => {
    const auth = new AuthSessionController(() => 1, () => "fixed"); const pending = auth.start("gemini", "subscription_cli");
    expect(auth.cancel("gemini", "wrong")).toBe(false); expect(auth.get("gemini")).toEqual(pending);
    expect(auth.cancel("gemini", pending.sessionId)).toBe(true); expect(auth.get("gemini")).toBeUndefined(); expect(auth.cancel("gemini", pending.sessionId)).toBe(false);
  });

  it("expires only after the bounded deadline", () => {
    let now = 100; const auth = new AuthSessionController(() => now, () => "fixed"); const pending = auth.start("work", "subscription_cli", 50);
    expect(auth.expire("work", pending.sessionId)).toBe(false); now = 150; expect(auth.expire("work", pending.sessionId)).toBe(true); expect(auth.get("work")).toBeUndefined();
  });

  it("preserves previous credential/config state when finalization fails", async () => {
    const auth = new AuthSessionController(() => 1, () => "fixed"); const pending = auth.start("work", "subscription_cli"); const previous = { authenticated: true };
    await expect(auth.complete("work", pending.sessionId, pending.state, async () => { throw new Error("token exchange failed"); })).rejects.toThrow("token exchange failed");
    expect(previous).toEqual({ authenticated: true }); expect(auth.get("work")).toBeUndefined();
  });
});
