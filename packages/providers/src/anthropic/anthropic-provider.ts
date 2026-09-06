import {
  assertExecutionOptionsSupported,
  ProviderError,
  type CredentialStore,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateUsage,
  type ModelInfo,
  type ModelCapabilities,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderErrorCode,
} from "@nyxara/provider-sdk";
import { knownModelExecutionCapability } from "../execution-capabilities.js";
import { consumeSse, parseSseJson } from "../sse.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** Keeps a caller-supplied bound inside the range the Messages API accepts. */
const MIN_MAX_OUTPUT_TOKENS = 512;
const MAX_MAX_OUTPUT_TOKENS = 64_000;

export interface AnthropicProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credentialStore?: CredentialStore;
  readonly credentialKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly providerId?: string;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly credentialKey: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  /** Ephemeral adapter-only blocks required by Anthropic tool continuation; never projected to Core. */
  private readonly thinkingBlocksByToolCallId = new Map<string, readonly Record<string, unknown>[]>();

  constructor(private readonly config: AnthropicProviderConfig = {}) {
    this.id = config.id ?? "anthropic";
    this.providerId = config.providerId ?? "anthropic";
    this.displayName = config.displayName ?? "Anthropic / Claude";
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://api.anthropic.com", this.id);
    this.credentialKey = config.credentialKey ?? `${this.id}.apiKey`;
    this.fetchImplementation = config.fetch ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilities {
    return { modelDiscovery: true, textGeneration: true, toolCalling: true, progressStreaming: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    const cursors = new Set<string>();
    let afterId: string | undefined;
    for (let page = 0; page < 32; page += 1) {
      const path = `/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
      const payload = record(await this.request(path, { method: "GET" }, "list_models"));
      if (!Array.isArray(payload.data)) throw this.invalidResponse("Provider returned an invalid models response");
      for (const value of payload.data) {
        const model = record(value);
        if (typeof model.id !== "string" || !model.id) throw this.invalidResponse("Provider returned a model without an ID");
        const declared = this.modelCapabilities(model.id);
        const discovered = discoveredCapabilities(model.capabilities);
        const capabilities = { ...discovered, ...declared };
        const contextWindow = finiteNumber(model.max_input_tokens);
        models.push({ id: model.id, name: typeof model.display_name === "string" ? model.display_name : model.id, provider: this.id, ...(contextWindow !== undefined ? { contextWindow } : {}), ...(Object.keys(capabilities).length ? { capabilities } : {}) });
      }
      if (payload.has_more !== true) break;
      if (typeof payload.last_id !== "string" || !payload.last_id || cursors.has(payload.last_id)) throw this.invalidResponse("Provider returned an invalid models cursor");
      cursors.add(payload.last_id); afterId = payload.last_id;
    }
    return models;
  }

  modelCapabilities(modelId: string): ModelCapabilities | undefined {
    const execution = knownModelExecutionCapability(this.providerId, modelId);
    return execution ? { execution } : undefined;
  }

  async generate(input: GenerateRequest): Promise<GenerateResponse> {
    const executionOptions = assertExecutionOptionsSupported(input.executionOptions, this.modelCapabilities(input.model)?.execution);
    const requestedOutputBound = boundedOutputTokens(input.maxOutputTokens);
    const maxTokens = executionOptions.kind === "anthropic_thinking"
      ? Math.max(requestedOutputBound ?? DEFAULT_MAX_OUTPUT_TOKENS, executionOptions.budgetTokens + 1_024)
      : requestedOutputBound ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const body = {
        model: input.model,
        max_tokens: maxTokens,
        ...(executionOptions.kind === "anthropic_thinking" ? { thinking: { type: "enabled", budget_tokens: executionOptions.budgetTokens } } : {}),
        messages: [
          { role: "user", content: input.prompt },
          ...(input.conversation?.map((message) => message.role === "assistant"
            ? { role: "assistant", content: [
                ...this.thinkingBlocksFor(message.toolCalls?.map((call) => call.id) ?? []),
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
    };
    if (input.onProgress) return this.generateStreaming(input, body);
    const payload = record(await this.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(body),
      ...(input.signal ? { signal: input.signal } : {}),
    }, "generate"));
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content.filter((part) => record(part).type === "text").map((part) => record(part).text).filter((value): value is string => typeof value === "string").join("\n");
    const toolCalls = content.filter((part) => record(part).type === "tool_use").map((part) => {
      const call = record(part);
      if (typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) throw this.invalidResponse("Provider returned an invalid tool call");
      return { id: call.id, name: call.name, arguments: call.input };
    });
    const thinkingBlocks = content.map(record).filter((part) => part.type === "thinking" || part.type === "redacted_thinking");
    if (thinkingBlocks.length) for (const call of toolCalls) this.rememberThinkingBlocks(call.id, thinkingBlocks);
    if (!text && toolCalls.length === 0) throw this.invalidResponse("Provider returned no content");
    const usage = normalizeAnthropicUsage(payload.usage);
    return {
      ...(typeof payload.id === "string" ? { id: payload.id } : {}),
      provider: this.id,
      model: typeof payload.model === "string" ? payload.model : input.model,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof payload.stop_reason === "string" ? { finishReason: payload.stop_reason } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async generateStreaming(input: GenerateRequest, body: Record<string, unknown>): Promise<GenerateResponse> {
    input.onProgress?.({ phase: "request_started" });
    const response = await this.requestResponse("/v1/messages", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true }),
      ...(input.signal ? { signal: input.signal } : {}),
    }, "generate");
    const blocks = new Map<number, Record<string, unknown>>();
    let id: string | undefined;
    let model = input.model;
    let finishReason: string | undefined;
    let startUsage: unknown;
    let finalUsage: unknown;
    let receiving = false;
    try { await consumeSse(response, this.id, (data) => {
      const event = parseSseJson(data, this.id);
      if (!event) return;
      if (event.type === "error") throw new ProviderError("Provider stream failed", { code: "provider_error", providerId: this.id });
      if (event.type === "message_start") {
        const message = record(event.message);
        if (typeof message.id === "string") id = message.id;
        if (typeof message.model === "string") model = message.model;
        startUsage = message.usage;
        input.onProgress?.({ phase: "response_started" });
        return;
      }
      if (event.type === "content_block_start" && typeof event.index === "number") {
        const block = { ...record(event.content_block) };
        blocks.set(event.index, block);
        if (block.type === "tool_use" && typeof block.name === "string") input.onProgress?.({ phase: "tool_call_requested", toolName: safeToolName(block.name) });
        return;
      }
      if (event.type === "content_block_delta" && typeof event.index === "number") {
        const block = blocks.get(event.index);
        if (!block) return;
        const delta = record(event.delta);
        if (delta.type === "text_delta" && typeof delta.text === "string") block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.__json = `${typeof block.__json === "string" ? block.__json : ""}${delta.partial_json}`;
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        else if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = `${typeof block.signature === "string" ? block.signature : ""}${delta.signature}`;
        if (!receiving && (delta.type === "text_delta" || delta.type === "input_json_delta")) { receiving = true; input.onProgress?.({ phase: "output_receiving" }); }
        return;
      }
      if (event.type === "message_delta") {
        const delta = record(event.delta);
        if (typeof delta.stop_reason === "string") finishReason = delta.stop_reason;
        finalUsage = event.usage;
      }
    }); } catch (error) { throw streamError(error, this.id); }
    const content: Record<string, unknown>[] = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]): Record<string, unknown> => {
      if (block.type === "tool_use" && typeof block.__json === "string") {
        try { const { __json: _ignored, ...rest } = block; return { ...rest, input: JSON.parse(block.__json) }; }
        catch { throw this.invalidResponse("Provider returned invalid tool arguments"); }
      }
      return block;
    });
    const text = content.filter((part) => part.type === "text").map((part) => part.text).filter((value): value is string => typeof value === "string").join("\n");
    const toolCalls = content.filter((part) => part.type === "tool_use").map((part) => {
      if (typeof part.id !== "string" || !part.id || typeof part.name !== "string" || !part.name) throw this.invalidResponse("Provider returned an invalid tool call");
      return { id: part.id, name: part.name, arguments: part.input };
    });
    const thinkingBlocks = content.filter((part) => part.type === "thinking" || part.type === "redacted_thinking").map(({ __json: _ignored, ...part }) => part);
    if (thinkingBlocks.length) for (const call of toolCalls) this.rememberThinkingBlocks(call.id, thinkingBlocks);
    if (!text && toolCalls.length === 0) throw this.invalidResponse("Provider returned no content");
    const usage = normalizeAnthropicUsage({ ...record(startUsage), ...record(finalUsage) });
    input.onProgress?.({ phase: "request_completed" });
    return { ...(id ? { id } : {}), provider: this.id, model, text, ...(toolCalls.length ? { toolCalls } : {}), ...(finishReason ? { finishReason } : {}), ...(usage ? { usage } : {}) };
  }

  private thinkingBlocksFor(toolCallIds: readonly string[]): readonly Record<string, unknown>[] {
    for (const id of toolCallIds) {
      const blocks = this.thinkingBlocksByToolCallId.get(id);
      if (blocks) return blocks;
    }
    return [];
  }

  private rememberThinkingBlocks(toolCallId: string, blocks: readonly Record<string, unknown>[]): void {
    this.thinkingBlocksByToolCallId.set(toolCallId, blocks.map((block) => ({ ...block })));
    while (this.thinkingBlocksByToolCallId.size > 256) {
      const oldest = this.thinkingBlocksByToolCallId.keys().next().value;
      if (typeof oldest !== "string") break;
      this.thinkingBlocksByToolCallId.delete(oldest);
    }
  }

  private async request(path: string, init: RequestInit, operation: "list_models" | "generate"): Promise<unknown> {
    const response = await this.requestResponse(path, init, operation);
    try { return await response.json(); } catch { throw this.invalidResponse("Provider returned invalid JSON"); }
  }

  private async requestResponse(path: string, init: RequestInit, operation: "list_models" | "generate"): Promise<Response> {
    let apiKey: string | undefined;
    try { apiKey = await this.config.credentialStore?.get(this.credentialKey); }
    catch { throw new ProviderError("Unable to load provider credentials", { code: "provider_error", providerId: this.id }); }
    if (!apiKey) throw new ProviderError("Provider credential is missing", { code: "authentication_error", providerId: this.id });
    const headers = new Headers({ Accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (init.body) headers.set("Content-Type", "application/json");
    let response: Response;
    try { response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) }); }
    catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
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
    return response;
  }

  private invalidResponse(message: string): ProviderError { return new ProviderError(message, { code: "invalid_response", providerId: this.id }); }
}

function boundedOutputTokens(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(value)));
}

/**
 * Preserves Anthropic input/cache provenance separately. `input_tokens` excludes
 * cached input, so `totalTokens` is the total processed token count (uncached
 * input + cache write + cache read + output) rather than a plain input+output sum.
 * Absent provider fields stay absent; they are never coerced to zero.
 */
export function normalizeAnthropicUsage(value: unknown): GenerateUsage | undefined {
  const usage = record(value);
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  const cacheWriteTokens = finiteNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = finiteNumber(usage.cache_read_input_tokens);
  const parts: readonly (number | undefined)[] = [inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens];
  if (parts.every((part) => part === undefined)) return undefined;
  const totalTokens = parts.reduce<number>((total, part) => total + (part ?? 0), 0);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeToolName(value: string): string { return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "tool"; }
function streamError(error: unknown, providerId: string): unknown {
  if (error instanceof ProviderError || error instanceof Error && error.name === "AbortError") return error;
  return new ProviderError("Provider stream was interrupted", { code: "network_error", providerId });
}
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function discoveredCapabilities(value: unknown): ModelCapabilities {
  const capabilities = record(value);
  const supported = (entry: unknown): boolean => record(entry).supported === true;
  return {
    ...(supported(capabilities.image_input) ? { vision: true } : {}),
    ...(supported(capabilities.structured_outputs) ? { structuredOutput: true } : {}),
    ...(supported(capabilities.thinking) || supported(capabilities.effort) ? { reasoning: true } : {}),
  };
}
function normalizeBaseUrl(value: string, providerId: string): string {
  try { return new URL(value).toString().replace(/\/$/, ""); }
  catch { throw new ProviderError("Provider base URL is invalid", { code: "provider_error", providerId }); }
}
