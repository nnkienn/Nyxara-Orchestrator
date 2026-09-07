import type { ModelCapabilities, ModelExecutionCapability, ModelInfo } from "@nyxara/provider-sdk";

export const MODEL_CACHE_KEY = "nyxara.providerModelCache.v1";
const MAX_PROVIDERS = 32;
const MAX_MODELS = 512;
const MAX_TEXT = 2_048;

export type ModelDiscoveryStatus = "unknown" | "loading" | "loaded" | "cached" | "failed" | "unsupported";

export interface SafeModelInfo {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly capabilities?: ModelCapabilities;
}

export interface ProviderModelState {
  readonly providerConfigId: string;
  readonly status: ModelDiscoveryStatus;
  readonly models: readonly SafeModelInfo[];
  readonly lastRefreshedAt?: string;
  readonly message?: string;
}

interface StoredCatalog {
  readonly providerConfigId: string;
  readonly models: readonly SafeModelInfo[];
  readonly lastRefreshedAt: string;
}

interface MementoLike {
  get?<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class ProviderModelDiscovery {
  private readonly catalogs = new Map<string, StoredCatalog>();
  private readonly runtime = new Map<string, Omit<ProviderModelState, "providerConfigId" | "models" | "lastRefreshedAt">>();
  onChange?: (providerConfigId: string, status: ModelDiscoveryStatus) => void;

  constructor(private readonly storage?: MementoLike, private readonly now: () => Date = () => new Date()) {
    const raw = storage?.get?.<unknown>(MODEL_CACHE_KEY, []);
    if (!Array.isArray(raw)) return;
    for (const value of raw.slice(0, MAX_PROVIDERS)) {
      const catalog = parseCatalog(value);
      if (catalog && !this.catalogs.has(catalog.providerConfigId)) this.catalogs.set(catalog.providerConfigId, catalog);
    }
  }

  state(providerConfigId: string, supported = true): ProviderModelState {
    const catalog = this.catalogs.get(providerConfigId);
    const active = this.runtime.get(providerConfigId);
    if (!supported) return { providerConfigId, status: "unsupported", models: catalog?.models ?? [], ...(catalog ? { lastRefreshedAt: catalog.lastRefreshedAt } : {}) };
    if (active) return { providerConfigId, ...active, models: catalog?.models ?? [], ...(catalog ? { lastRefreshedAt: catalog.lastRefreshedAt } : {}) };
    return { providerConfigId, status: catalog ? "cached" : "unknown", models: catalog?.models ?? [], ...(catalog ? { lastRefreshedAt: catalog.lastRefreshedAt } : {}) };
  }

  capabilities(providerConfigId: string, modelId: string): ModelCapabilities | undefined {
    return this.catalogs.get(providerConfigId)?.models.find((model) => model.id === modelId)?.capabilities;
  }

  async refresh(providerConfigId: string, discover: () => Promise<readonly ModelInfo[]>): Promise<readonly SafeModelInfo[]> {
    const previous = this.catalogs.get(providerConfigId);
    this.runtime.set(providerConfigId, { status: "loading" });
    this.onChange?.(providerConfigId, "loading");
    try {
      const discovered = await discover();
      console.log(`[Model Discovery] Provider ${providerConfigId}: Raw discovered models: ${discovered.length}`);
      const models = sanitizeModels(discovered);
      console.log(`[Model Discovery] Provider ${providerConfigId}: After sanitization: ${models.length}`);
      const catalog: StoredCatalog = { providerConfigId, models, lastRefreshedAt: this.now().toISOString() };
      this.catalogs.set(providerConfigId, catalog);
      this.runtime.set(providerConfigId, { status: "loaded" });
      try { await this.persist(); }
      catch (error) { if (previous) this.catalogs.set(providerConfigId, previous); else this.catalogs.delete(providerConfigId); throw error; }
      this.onChange?.(providerConfigId, "loaded");
      return models;
    } catch (error) {
      const statusCode = errorStatus(error);
      const unsupported = statusCode === 404 || statusCode === 405 || statusCode === 501;
      const message = unsupported ? "Model discovery unsupported. Enter a model ID manually." : statusCode === 401 || statusCode === 403 ? "Authentication failed while loading models." : "Models could not be loaded.";
      this.runtime.set(providerConfigId, { status: unsupported ? "unsupported" : "failed", message });
      this.onChange?.(providerConfigId, unsupported ? "unsupported" : "failed");
      throw error;
    }
  }

  markCached(providerConfigId: string): void {
    this.runtime.delete(providerConfigId);
  }

  async clear(providerConfigId: string): Promise<void> {
    const previous = this.catalogs.get(providerConfigId);
    this.catalogs.delete(providerConfigId);
    this.runtime.delete(providerConfigId);
    try { await this.persist(); }
    catch (error) { if (previous) this.catalogs.set(providerConfigId, previous); throw error; }
    this.onChange?.(providerConfigId, "unknown");
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    await this.storage.update(MODEL_CACHE_KEY, [...this.catalogs.values()].slice(-MAX_PROVIDERS));
  }
}

export function sanitizeModels(values: readonly ModelInfo[]): SafeModelInfo[] {
  const result: SafeModelInfo[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const value of values.slice(0, MAX_MODELS)) {
    if (typeof value?.id !== "string" || !value.id || value.id.length > MAX_TEXT || seen.has(value.id)) {
      skipped++;
      continue;
    }
    seen.add(value.id);
    const capabilities = sanitizeCapabilities(value.capabilities);
    result.push({
      id: value.id,
      name: typeof value.name === "string" && value.name ? value.name.slice(0, MAX_TEXT) : value.id,
      ...(typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) && value.contextWindow >= 0 ? { contextWindow: value.contextWindow } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  if (skipped > 0) console.log(`[sanitizeModels] Skipped ${skipped} invalid/duplicate models out of ${values.length} total`);
  return result;
}

function parseCatalog(value: unknown): StoredCatalog | undefined {
  if (!record(value) || typeof value.providerConfigId !== "string" || !value.providerConfigId || typeof value.lastRefreshedAt !== "string" || Number.isNaN(Date.parse(value.lastRefreshedAt)) || !Array.isArray(value.models)) return undefined;
  const models = sanitizeModels(value.models.map((model) => record(model) ? { ...model, provider: value.providerConfigId } as unknown as ModelInfo : {} as ModelInfo));
  return { providerConfigId: value.providerConfigId.slice(0, 200), lastRefreshedAt: value.lastRefreshedAt, models };
}

function sanitizeCapabilities(value: ModelCapabilities | undefined): ModelCapabilities | undefined {
  if (!record(value)) return undefined;
  const execution = sanitizeExecution(value.execution);
  const result: ModelCapabilities = {
    ...(typeof value.text === "boolean" ? { text: value.text } : {}),
    ...(typeof value.vision === "boolean" ? { vision: value.vision } : {}),
    ...(typeof value.tools === "boolean" ? { tools: value.tools } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(typeof value.structuredOutput === "boolean" ? { structuredOutput: value.structuredOutput } : {}),
    ...(execution ? { execution } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function sanitizeExecution(value: ModelExecutionCapability | undefined): ModelExecutionCapability | undefined {
  if (!record(value) || !["provider_discovery", "provider_catalog", "adapter_known", "unknown"].includes(String(value.provenance))) return undefined;
  if ((value.kind === "openai_reasoning" || value.kind === "anthropic_effort" || value.kind === "gemini_thinking_level") && value.control === "select" && Array.isArray(value.values)) {
    const values = value.values.flatMap((item) => record(item) && typeof item.value === "string" && item.value && typeof item.label === "string" ? [{ value: item.value.slice(0, 100), label: item.label.slice(0, 100) }] : []);
    if (!values.length) return undefined;
    return value.kind === "openai_reasoning"
      ? { kind: value.kind, label: "Reasoning", control: "select", values, provenance: value.provenance }
      : value.kind === "anthropic_effort"
        ? { kind: value.kind, label: "Effort", control: "select", values, provenance: value.provenance }
      : { kind: value.kind, label: "Thinking", control: "select", values, provenance: value.provenance };
  }
  if ((value.kind === "anthropic_thinking" || value.kind === "gemini_thinking_budget") && value.control === "toggle_number" && Number.isInteger(value.minimumBudgetTokens) && Number.isInteger(value.maximumBudgetTokens) && value.maximumBudgetTokens >= value.minimumBudgetTokens) {
    return value.kind === "anthropic_thinking"
      ? { kind: value.kind, label: "Thinking", control: "toggle_number", enabledLabel: "Enabled", budgetLabel: "Thinking Budget", minimumBudgetTokens: value.minimumBudgetTokens, maximumBudgetTokens: value.maximumBudgetTokens, integerBudget: true, provenance: value.provenance }
      : { kind: value.kind, label: "Thinking", control: "toggle_number", enabledLabel: "Custom Budget", budgetLabel: "Thinking Budget", minimumBudgetTokens: value.minimumBudgetTokens, maximumBudgetTokens: value.maximumBudgetTokens, integerBudget: true, ...(value.allowZero ? { allowZero: true } : {}), provenance: value.provenance };
  }
  return undefined;
}

function errorStatus(error: unknown): number | undefined {
  return record(error) && typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
