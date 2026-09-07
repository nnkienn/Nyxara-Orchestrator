import type { ProviderConfig } from "./provider-config.js";

export const CLI_SESSION_STATE_KEY = "nyxara.providerCliSessions.v1";

export interface CliSessionEvidence {
  readonly providerConfigId: string;
  readonly adapterId: ProviderConfig["type"];
  readonly state: "present" | "missing" | "unavailable";
  readonly checkedAt: string;
}

interface SessionStorage {
  get(key: string, fallback: unknown): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class ProviderCliSessionStore {
  private readonly sessions = new Map<string, CliSessionEvidence>();

  constructor(private readonly storage?: SessionStorage) {
    const saved = storage?.get(CLI_SESSION_STATE_KEY, []);
    if (!Array.isArray(saved)) return;
    for (const value of saved.slice(-128)) {
      if (!value || typeof value !== "object" || typeof value.providerConfigId !== "string" || !value.providerConfigId || value.providerConfigId.length > 200) continue;
      if (!["codex-cli", "claude-code-cli", "gemini-cli"].includes(value.adapterId)) continue;
      if (!["present", "missing", "unavailable"].includes(value.state) || typeof value.checkedAt !== "string" || Number.isNaN(Date.parse(value.checkedAt))) continue;
      this.sessions.set(value.providerConfigId, { providerConfigId: value.providerConfigId, adapterId: value.adapterId, state: value.state, checkedAt: value.checkedAt });
    }
  }

  get(config: ProviderConfig): CliSessionEvidence | undefined {
    const evidence = this.sessions.get(config.id);
    return config.authStrategy === "subscription_cli" && evidence?.adapterId === config.type ? evidence : undefined;
  }

  async record(config: ProviderConfig, state: CliSessionEvidence["state"]): Promise<void> {
    if (config.authStrategy !== "subscription_cli") return;
    this.sessions.set(config.id, { providerConfigId: config.id, adapterId: config.type, state, checkedAt: new Date().toISOString() });
    await this.persist();
  }

  async clear(providerConfigId: string): Promise<void> {
    this.sessions.delete(providerConfigId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.storage?.update(CLI_SESSION_STATE_KEY, [...this.sessions.values()].slice(-128));
  }
}
