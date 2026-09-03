import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { BenchmarkProviderResponse, BenchmarkRealProvider } from "./scenario.types.js";

interface PublicModelProvider { id: string; capabilities(): { toolCalling?: boolean }; generate(input: Record<string, unknown>): Promise<any>; }

/** Thin benchmark adapter over the public provider SDK. It intentionally does
 * not expose prompts, responses, tool arguments, or credentials. */
export class PublicRealProviderAdapter implements BenchmarkRealProvider {
  constructor(private readonly providers: ReadonlyMap<string, PublicModelProvider>, private readonly roles: Readonly<Record<"planner" | "executor" | "reviewer", string>>) {}
  async generate(role: "planner" | "executor" | "reviewer" | "repair", input: { prompt: string; model: string; tools?: boolean; structured?: boolean; workspaceRoot?: string }): Promise<BenchmarkProviderResponse> {
    const providerId = role === "repair" ? this.roles.executor : this.roles[role];
    const provider = this.providers.get(providerId);
    if (!provider) throw Object.assign(new Error("Provider is not configured"), { code: "provider_not_configured" });
    const start = performance.now();
    const selectedModel = input.model === "default" && "listModels" in provider ? ((await (provider as any).listModels())[0]?.id ?? input.model) : input.model;
    const tools = input.tools ? [{ name: "write_fixture_file", description: "Write one deterministic file inside the benchmark fixture only.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative fixture path" }, content: { type: "string", description: "Deterministic utility source" } }, required: ["path", "content"], additionalProperties: false } }] : undefined;
    const response = await provider.generate({ model: selectedModel, prompt: input.prompt, ...(input.structured ? { responseFormat: "json" as const } : {}), ...(tools ? { tools } : {}) });
    const usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, totalTokens: response.usage.totalTokens, ...(response.usage.cost !== undefined ? { cost: response.usage.cost } : {}), ...(response.usage.currency ? { currency: response.usage.currency } : {}) } : undefined;
    let toolCallSucceeded = false;
    if (input.tools && response.toolCalls?.length && input.workspaceRoot) {
      const call = response.toolCalls[0]; const args = call.arguments as any; const relative = typeof args?.path === "string" ? args.path : ""; const content = typeof args?.content === "string" ? args.content : ""; const target = path.resolve(input.workspaceRoot, relative);
      if (relative && target.startsWith(`${path.resolve(input.workspaceRoot)}${path.sep}`) && content.length <= 32_000) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, "utf8"); toolCallSucceeded = true; }
    }
    return { provider: response.provider, model: response.model, requestedModelId: input.model, latencyMs: performance.now() - start, ...(usage ? { usage } : {}), ...(input.structured ? { structuredOutputValid: role === "planner" ? validPlanJson(response.text) : role === "reviewer" ? validReviewJson(response.text) : isJson(response.text) } : {}), ...(role === "reviewer" ? { reviewStatus: reviewStatus(response.text) } : {}), ...(input.tools ? { toolCallSupported: Boolean(provider.capabilities().toolCalling), toolCallSucceeded, invalidToolCalls: toolCallSucceeded ? 0 : 1, toolCallCount: response.toolCalls?.length ?? 0 } : {}) };
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
function validPlanJson(value: string): boolean { try { const parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as any; return typeof parsed?.objective === "string" && parsed.objective.length > 0 && Array.isArray(parsed.tasks) && parsed.tasks.length > 0 && parsed.tasks.every((task: any) => typeof task?.id === "string" && typeof task?.title === "string" && typeof task?.description === "string" && Array.isArray(task?.dependencies) && Array.isArray(task?.acceptanceCriteria) && task.acceptanceCriteria.length > 0); } catch { return false; } }
function reviewStatus(value: string): "passed" | "failed" | "unavailable" { try { const parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as any; return parsed?.status === "passed" || parsed?.status === "failed" ? parsed.status : "unavailable"; } catch { return "unavailable"; } }
function validReviewJson(value: string): boolean { return reviewStatus(value) !== "unavailable"; }
