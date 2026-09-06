import { randomBytes } from "node:crypto";
import type { ProviderAuthMethod } from "@nyxara/provider-sdk";

export const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60_000;

export interface PendingAuthSession {
  readonly providerConfigId: string;
  readonly sessionId: string;
  readonly state: string;
  readonly authMethod: ProviderAuthMethod;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export class AuthSessionError extends Error {
  constructor(readonly code: "already_pending" | "unknown_callback" | "invalid_state" | "replayed_callback" | "expired_callback" | "cancelled", message: string) {
    super(message);
    this.name = "AuthSessionError";
  }
}

/** One-time state validation for active provider-owned browser/device/CLI authentication attempts. */
export class AuthSessionController {
  private readonly pending = new Map<string, PendingAuthSession>();
  private readonly consumed = new Set<string>();

  constructor(private readonly now: () => number = Date.now, private readonly random: () => string = () => randomBytes(32).toString("base64url")) {}

  start(providerConfigId: string, authMethod: ProviderAuthMethod, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS): PendingAuthSession {
    if (this.pending.has(providerConfigId)) throw new AuthSessionError("already_pending", "Authentication is already pending for this provider.");
    const startedAt = this.now();
    const session: PendingAuthSession = { providerConfigId, authMethod, sessionId: this.random(), state: this.random(), startedAt, expiresAt: startedAt + timeoutMs };
    this.pending.set(providerConfigId, session);
    return session;
  }

  get(providerConfigId: string): PendingAuthSession | undefined {
    return this.pending.get(providerConfigId);
  }

  list(): readonly PendingAuthSession[] {
    return [...this.pending.values()];
  }

  async complete(providerConfigId: string, sessionId: string, state: string, finalize: () => Promise<void>): Promise<void> {
    const replayKey = `${sessionId}\0${state}`;
    if (this.consumed.has(replayKey)) throw new AuthSessionError("replayed_callback", "Authentication completion was already processed.");
    const session = this.pending.get(providerConfigId);
    if (!session || session.sessionId !== sessionId) throw new AuthSessionError("unknown_callback", "Authentication completion is no longer pending.");
    if (session.state !== state) throw new AuthSessionError("invalid_state", "Authentication completion state was invalid.");
    if (this.now() >= session.expiresAt) {
      this.pending.delete(providerConfigId);
      this.remember(replayKey);
      throw new AuthSessionError("expired_callback", "Authentication timed out. Try again.");
    }
    this.pending.delete(providerConfigId);
    this.remember(replayKey);
    await finalize();
  }

  cancel(providerConfigId: string, sessionId: string): boolean {
    const session = this.pending.get(providerConfigId);
    if (!session || session.sessionId !== sessionId) return false;
    this.pending.delete(providerConfigId);
    this.remember(`${session.sessionId}\0${session.state}`);
    return true;
  }

  expire(providerConfigId: string, sessionId: string): boolean {
    const session = this.pending.get(providerConfigId);
    if (!session || session.sessionId !== sessionId || this.now() < session.expiresAt) return false;
    this.pending.delete(providerConfigId);
    this.remember(`${session.sessionId}\0${session.state}`);
    return true;
  }

  private remember(key: string): void {
    this.consumed.add(key);
    while (this.consumed.size > 256) {
      const oldest = this.consumed.values().next().value;
      if (typeof oldest !== "string") break;
      this.consumed.delete(oldest);
    }
  }
}
