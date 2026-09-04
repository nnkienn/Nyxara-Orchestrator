import {
  ProviderError,
  type CredentialStore,
  type GenerateRequest,
  type GenerateResponse,
  type ModelInfo,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderErrorCode,
} from "@nyxara/provider-sdk";

export interface GeminiProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialStore?: CredentialStore;
  readonly credentialKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

type JsonRecord = Record<string, unknown>;

/** Official Gemini REST transport. Core sees only the provider-sdk contract. */
export class GeminiProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly credentialKey: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly config: GeminiProviderConfig = {}) {
    this.id = config.id ?? "gemini";
    this.displayName = config.displayName ?? "Google Gemini";
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", this.id);
    this.credentialKey = config.credentialKey ?? `${this.id}.apiKey`;
    this.fetchImplementation = config.fetch ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilities {
    return { modelDiscovery: true, textGeneration: true, structuredOutput: true, toolCalling: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = record(await this.request("/models", { method: "GET" }, "list_models"));
    if (!Array.isArray(payload.models)) throw this.invalidResponse("Provider returned an invalid models response");
    return payload.models.flatMap((value): ModelInfo[] => {
      const model = record(value);
      if (typeof model.name !== "string" || !model.name) return [];
      const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
      if (!methods.includes("generateContent")) return [];
      const id = model.name.replace(/^models\//, "");
      const contextWindow = finiteNumber(model.inputTokenLimit);
      return [{
        id,
        name: typeof model.displayName === "string" && model.displayName ? model.displayName : id,
        provider: this.id,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        capabilities: { text: true, tools: true, structuredOutput: true },
      }];
    });
  }

  async generate(input: GenerateRequest): Promise<GenerateResponse> {
    const modelId = input.model.replace(/^models\//, "");
    const contents: JsonRecord[] = [{ role: "user", parts: [{ text: input.prompt }] }];
    for (const message of input.conversation ?? []) {
      if (message.role === "assistant") {
        contents.push({ role: "model", parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.toolCalls?.map((call) => ({ functionCall: { name: call.name, args: call.arguments } })) ?? []),
        ] });
      } else {
        contents.push({ role: "user", parts: [{ functionResponse: { name: message.toolResult.name, response: message.toolResult.error ? { error: message.toolResult.error } : { result: message.toolResult.result ?? null } } }] });
      }
    }
    const payload = record(await this.request(`/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      body: JSON.stringify({
        contents,
        ...(input.tools?.length ? { tools: [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }] } : {}),
        ...(input.responseFormat === "json" ? { generationConfig: { responseMimeType: "application/json" } } : {}),
      }),
    }, "generate"));
    const candidate = record(Array.isArray(payload.candidates) ? payload.candidates[0] : undefined);
    const content = record(candidate.content);
    if (!Array.isArray(content.parts)) throw this.invalidResponse("Provider returned no content");
    const parts = content.parts.map(record);
    const text = parts.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
    const toolCalls = parts.flatMap((part, index) => {
      const call = record(part.functionCall);
      return typeof call.name === "string" && call.name ? [{ id: `gemini-call-${index + 1}`, name: call.name, arguments: call.args ?? {} }] : [];
    });
    if (!text && toolCalls.length === 0) throw this.invalidResponse("Provider returned no text or tool calls");
    const usage = record(payload.usageMetadata);
    const inputTokens = finiteNumber(usage.promptTokenCount);
    const outputTokens = finiteNumber(usage.candidatesTokenCount);
    const totalTokens = finiteNumber(usage.totalTokenCount);
    return {
      provider: this.id,
      model: typeof candidate.modelVersion === "string" ? candidate.modelVersion : input.model,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof candidate.finishReason === "string" ? { finishReason: candidate.finishReason } : {}),
      ...(inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined ? { usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      } } : {}),
    };
  }

  private async request(path: string, init: RequestInit, operation: "list_models" | "generate"): Promise<unknown> {
    let apiKey: string | undefined;
    try { apiKey = await this.config.credentialStore?.get(this.credentialKey); }
    catch { throw new ProviderError("Unable to load provider credentials", { code: "provider_error", providerId: this.id }); }
    if (!apiKey) throw new ProviderError("Provider credential is missing", { code: "authentication_error", providerId: this.id });
    const headers = new Headers({ Accept: "application/json", "x-goog-api-key": apiKey });
    if (init.body) headers.set("Content-Type", "application/json");
    let response: Response;
    try { response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) }); }
    catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new ProviderError("Provider request timed out", { code: "timeout_error", providerId: this.id });
      throw new ProviderError("Unable to reach the model provider", { code: "network_error", providerId: this.id });
    }
    if (!response.ok) {
      let code: ProviderErrorCode = "provider_error";
      if (response.status === 400 || response.status === 401 || response.status === 403) code = "authentication_error";
      else if (response.status === 429) code = "rate_limit_error";
      else if (operation === "generate" && response.status === 404) code = "invalid_model";
      throw new ProviderError(`Provider request failed with status ${response.status}`, { code, providerId: this.id, statusCode: response.status });
    }
    try { return await response.json(); } catch { throw this.invalidResponse("Provider returned invalid JSON"); }
  }

  private invalidResponse(message: string): ProviderError {
    return new ProviderError(message, { code: "invalid_response", providerId: this.id });
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function normalizeBaseUrl(value: string, providerId: string): string {
  try { return new URL(value).toString().replace(/\/$/, ""); }
  catch { throw new ProviderError("Provider base URL is invalid", { code: "provider_error", providerId }); }
}
