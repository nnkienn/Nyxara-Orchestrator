import { performance } from "node:perf_hooks";
import type { BenchmarkProviderResponse, BenchmarkRealProvider } from "./scenario.types.js";

interface PublicModelProvider { id: string; capabilities(): { toolCalling?: boolean }; generate(input: Record<string, unknown>): Promise<any>; }

/** Thin benchmark adapter over the public provider SDK. It intentionally does
 * not expose prompts, responses, tool arguments, or credentials. */
export class PublicRealProviderAdapter implements BenchmarkRealProvider {
  constructor(private readonly providers: ReadonlyMap<string, PublicModelProvider>, private readonly roles: Readonly<Record<"planner" | "executor" | "reviewer", string>>) {}
  async generate(role: "planner" | "executor" | "reviewer" | "repair", input: { prompt: string; model: string; tools?: boolean; structured?: boolean }): Promise<BenchmarkProviderResponse> {
    const providerId = role === "repair" ? this.roles.executor : this.roles[role];
    const provider = this.providers.get(providerId);
    if (!provider) throw Object.assign(new Error("Provider is not configured"), { code: "provider_not_configured" });
    const start = performance.now();
    const selectedModel = input.model === "default" && "listModels" in provider ? ((await (provider as any).listModels())[0]?.id ?? input.model) : input.model;
    const response = await provider.generate({ model: selectedModel, prompt: input.prompt, ...(input.structured ? { responseFormat: "json" as const } : {}), ...(input.tools ? { tools: [] } : {}) });
    const usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, totalTokens: response.usage.totalTokens } : undefined;
    return { provider: response.provider, model: response.model, latencyMs: performance.now() - start, ...(usage ? { usage } : {}), ...(input.structured ? { structuredOutputValid: isJson(response.text) } : {}), ...(input.tools ? { toolCallSupported: Boolean(provider.capabilities().toolCalling), toolCallSucceeded: (response.toolCalls?.length ?? 0) >= 0, invalidToolCalls: 0, toolCallCount: response.toolCalls?.length ?? 0 } : {}) };
  }
}

export async function createPublicRealProvider(roleProviders: Readonly<Record<"planner" | "executor" | "reviewer", string>>): Promise<{ adapter: PublicRealProviderAdapter; providers: PublicModelProvider[] }> {
  // The benchmark is outside the pnpm workspace packages. Load the built
  // package entrypoint so real mode still consumes only @nyxara/providers'
  // public export, never implementation internals.
  const relative = import.meta.url.includes("/dist/") ? "../../../packages/providers/dist/index.js" : "../../packages/providers/dist/index.js";
  const { OpenAICompatibleProvider } = await import(new URL(relative, import.meta.url).href);
  const credentialStore = { async get(key: string) { return process.env[key] ?? (key === "NYXARA_OPENAI_COMPATIBLE_API_KEY" ? process.env.NYXARA_OPENAI_API_KEY : undefined); }, async set() {}, async delete() {} };
  const providers = [...new Set(Object.values(roleProviders))].map(id => new OpenAICompatibleProvider({ id, displayName: id, ...(process.env.NYXARA_OPENAI_BASE_URL ? { baseUrl: process.env.NYXARA_OPENAI_BASE_URL } : {}), credentialStore, credentialKey: `NYXARA_${id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY` }) as PublicModelProvider);
  return { providers, adapter: new PublicRealProviderAdapter(new Map(providers.map(provider => [provider.id, provider])), roleProviders) };
}

function isJson(value: string): boolean { try { JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); return true; } catch { return false; } }
