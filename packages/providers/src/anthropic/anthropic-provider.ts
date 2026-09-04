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

export interface AnthropicProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialStore?: CredentialStore;
  readonly credentialKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly credentialKey: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly config: AnthropicProviderConfig = {}) {
    this.id = config.id ?? "anthropic";
    this.displayName = config.displayName ?? "Anthropic / Claude";
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://api.anthropic.com", this.id);
    this.credentialKey = config.credentialKey ?? `${this.id}.apiKey`;
    this.fetchImplementation = config.fetch ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilities {
    return { modelDiscovery: true, textGeneration: true, toolCalling: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = await this.request("/v1/models", { method: "GET" }, "list_models");
    const data = record(payload).data;
    if (!Array.isArray(data)) throw this.invalidResponse("Provider returned an invalid models response");
    return data.map((value) => {
      const model = record(value);
      if (typeof model.id !== "string" || !model.id) throw this.invalidResponse("Provider returned a model without an ID");
      return { id: model.id, name: typeof model.display_name === "string" ? model.display_name : model.id, provider: this.id };
    });
  }

  async generate(input: GenerateRequest): Promise<GenerateResponse> {
    const payload = record(await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: input.model,
        max_tokens: 4096,
        messages: [
          { role: "user", content: input.prompt },
          ...(input.conversation?.map((message) => message.role === "assistant"
            ? { role: "assistant", content: [
                ...(message.content ? [{ type: "text", text: message.content }] : []),
                ...(message.toolCalls?.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })) ?? []),
              ] }
            : { role: "user", content: [{
                type: "tool_result",
                tool_use_id: message.toolResult.callId,
                content: JSON.stringify(message.toolResult.error ? { error: message.toolResult.error } : { result: message.toolResult.result ?? null }),
                is_error: Boolean(message.toolResult.error),
              }] }) ?? []),
        ],
        ...(input.tools?.length ? { tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
      }),
    }, "generate"));
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content.filter((part) => record(part).type === "text").map((part) => record(part).text).filter((value): value is string => typeof value === "string").join("\n");
    const toolCalls = content.filter((part) => record(part).type === "tool_use").map((part) => {
      const call = record(part);
      if (typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) throw this.invalidResponse("Provider returned an invalid tool call");
      return { id: call.id, name: call.name, arguments: call.input };
    });
    if (!text && toolCalls.length === 0) throw this.invalidResponse("Provider returned no content");
    const usage = record(payload.usage);
    const inputTokens = number(usage.input_tokens);
    const outputTokens = number(usage.output_tokens);
    return {
      ...(typeof payload.id === "string" ? { id: payload.id } : {}),
      provider: this.id,
      model: typeof payload.model === "string" ? payload.model : input.model,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof payload.stop_reason === "string" ? { finishReason: payload.stop_reason } : {}),
      ...((inputTokens !== undefined || outputTokens !== undefined) ? { usage: { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}) } } : {}),
    };
  }

  private async request(path: string, init: RequestInit, operation: "list_models" | "generate"): Promise<unknown> {
    let apiKey: string | undefined;
    try { apiKey = await this.config.credentialStore?.get(this.credentialKey); }
    catch { throw new ProviderError("Unable to load provider credentials", { code: "provider_error", providerId: this.id }); }
    if (!apiKey) throw new ProviderError("Provider credential is missing", { code: "authentication_error", providerId: this.id });
    const headers = new Headers({ Accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey });
    if (init.body) headers.set("Content-Type", "application/json");
    let response: Response;
    try { response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) }); }
    catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new ProviderError("Provider request timed out", { code: "timeout_error", providerId: this.id });
      throw new ProviderError("Unable to reach the model provider", { code: "network_error", providerId: this.id });
    }
    if (!response.ok) {
      let code: ProviderErrorCode = "provider_error";
      if (response.status === 401 || response.status === 403) code = "authentication_error";
      else if (response.status === 429) code = "rate_limit_error";
      else if (operation === "generate" && response.status === 404) code = "invalid_model";
      throw new ProviderError(`Provider request failed with status ${response.status}`, { code, providerId: this.id, statusCode: response.status });
    }
    try { return await response.json(); } catch { throw this.invalidResponse("Provider returned invalid JSON"); }
  }

  private invalidResponse(message: string): ProviderError { return new ProviderError(message, { code: "invalid_response", providerId: this.id }); }
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function normalizeBaseUrl(value: string, providerId: string): string {
  try { return new URL(value).toString().replace(/\/$/, ""); }
  catch { throw new ProviderError("Provider base URL is invalid", { code: "provider_error", providerId }); }
}
