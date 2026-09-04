import type { CredentialStore } from "@nyxara/provider-sdk";
import {
  AnthropicProvider,
  CliSubscriptionProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  providerDefinition,
  type ProviderAdapterType,
} from "@nyxara/providers";

export interface ProviderConfig {
  readonly id: string;
  readonly catalogId?: string;
  readonly type: ProviderAdapterType;
  readonly displayName: string;
  /** Last explicitly selected model for this local configuration. Non-secret. */
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly authStrategy: "api_key" | "subscription" | "local" | "none";
  readonly createdAt?: string;
  /** Local lifecycle marker for externally authenticated CLI providers. */
  readonly signedOut?: boolean;
}

export const PROVIDER_CONFIGS_SETTING = "nyxara.providerConfigs";
export const DEFAULT_PROVIDER_SETTING = "nyxara.defaultProviderConfigId";
export const LEGACY_SECRET_KEY = "openai-compatible.apiKey";

export function providerSecretKey(providerConfigId: string): string {
  return `provider/${providerConfigId}/api-key`;
}

export function readProviderConfigs(get: <T>(key: string, fallback: T) => T): ProviderConfig[] {
  const raw = get<unknown>(PROVIDER_CONFIGS_SETTING, []);
  if (Array.isArray(raw) && raw.length > 0) {
    const parsed = raw.flatMap(parseProviderConfig);
    return parsed.filter((config, index) => parsed.findIndex((candidate) => candidate.id === config.id) === index);
  }

  // Alpha.1 compatibility: role settings identify whether the old single config was real.
  const hasLegacyModels = ["planner", "executor", "reviewer"].every((role) => Boolean(get(`nyxara.${role}.model`, "").trim()));
  if (!hasLegacyModels) return [];
  return [{
    id: "openai-compatible",
    type: "openai-compatible",
    displayName: "OpenAI-compatible",
    baseUrl: get("nyxara.openaiCompatible.baseUrl", "https://api.openai.com/v1"),
    authStrategy: "api_key",
  }];
}

function parseProviderConfig(value: unknown): ProviderConfig[] {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return [];
  const supported: ProviderAdapterType[] = ["codex-cli", "claude-code-cli", "gemini-cli", "openai", "anthropic", "gemini", "openai-compatible", "ollama", "lm-studio", "local-openai-compatible"];
  if (!supported.includes(value.type as ProviderAdapterType)) return [];
  const catalogId = typeof value.catalogId === "string" ? value.catalogId : value.type;
  let definition;
  try { definition = providerDefinition(catalogId); } catch { return []; }
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : definition.onboarding.defaultEndpoint;
  if (!baseUrl && !definition.cli) return [];
  const authStrategy = value.authStrategy === "api_key" || value.authStrategy === "subscription" || value.authStrategy === "local" || value.authStrategy === "none" ? value.authStrategy : definition.cli ? "subscription" : definition.onboarding.category === "official" ? "api_key" : "none";
  const modelId = typeof value.modelId === "string" && value.modelId.trim() ? value.modelId.trim() : undefined;
  const createdAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) ? value.createdAt : undefined;
  return [{ id: value.id, ...(catalogId !== value.type ? { catalogId } : {}), type: value.type as ProviderAdapterType, displayName: typeof value.displayName === "string" && value.displayName.trim() ? value.displayName.trim() : definition.displayName, ...(modelId ? { modelId } : {}), ...(baseUrl ? { baseUrl } : {}), authStrategy, ...(createdAt ? { createdAt } : {}), ...(value.signedOut === true ? { signedOut: true } : {}) }];
}

export function createProvider(config: ProviderConfig, secrets: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }) {
  if (config.type === "codex-cli" || config.type === "claude-code-cli" || config.type === "gemini-cli") return new CliSubscriptionProvider({ kind: config.type, id: config.id, displayName: config.displayName });
  if (!config.baseUrl) throw new Error(`Provider endpoint is missing: ${config.id}`);
  const credentialKey = providerSecretKey(config.id);
  const credentialStore: CredentialStore = {
    get: async (key) => (await secrets.get(key)) ?? (config.id === "openai-compatible" ? await secrets.get(LEGACY_SECRET_KEY) : undefined),
    set: (key, value) => secrets.store(key, value),
    delete: (key) => secrets.delete(key),
  };
  if (config.type === "anthropic") return new AnthropicProvider({ id: config.id, displayName: config.displayName, baseUrl: config.baseUrl, credentialStore, credentialKey });
  if (config.type === "gemini") return new GeminiProvider({ id: config.id, displayName: config.displayName, baseUrl: config.baseUrl, credentialStore, credentialKey });
  return new OpenAICompatibleProvider({ id: config.id, displayName: config.displayName, baseUrl: config.baseUrl, credentialStore, credentialKey, credentialRequired: config.authStrategy === "api_key" });
}

export function defaultProviderId(configs: readonly ProviderConfig[], configuredId: string): string | undefined {
  return configs.some((config) => config.id === configuredId) ? configuredId : configs[0]?.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
