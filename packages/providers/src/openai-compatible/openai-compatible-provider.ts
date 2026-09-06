import {
  assertExecutionOptionsSupported,
  capabilityForModel,
  ProviderError,
  type CredentialStore,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateUsage,
  type ModelCapabilities,
  type ModelConversationMessage,
  type ModelInfo,
  type ModelExecutionCapability,
  type ModelExecutionCapabilityRule,
  type ModelProvider,
  type ModelToolCall,
  type ProviderCapabilities,
  type ProviderErrorCode,
} from "@nyxara/provider-sdk";
import { knownModelExecutionCapability } from "../execution-capabilities.js";
import { consumeSse, parseSseJson } from "../sse.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_PROVIDER_ID = "openai-compatible";
const DEFAULT_DISPLAY_NAME = "OpenAI Compatible";

export interface OpenAICompatibleProviderConfig {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentialStore?: CredentialStore;
  readonly credentialKey?: string;
  readonly credentialRequired?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  /** Stable catalog/provider identity, distinct from the local configuration ID. */
  readonly providerId?: string;
  /** Explicit provider-owned declaration for compatible gateways. Empty means unknown. */
  readonly modelExecutionCapabilities?: readonly ModelExecutionCapabilityRule[];
}

type Operation = "list_models" | "generate";
type UnknownRecord = Record<string, unknown>;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly credentialStore: CredentialStore | undefined;
  private readonly credentialKey: string;
  private readonly credentialRequired: boolean;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly discoveredModelCapabilities = new Map<string, ModelCapabilities>();

  constructor(private readonly config: OpenAICompatibleProviderConfig = {}) {
    this.id = config.id ?? DEFAULT_PROVIDER_ID;
    this.providerId = config.providerId ?? this.id;
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = config.apiKey;
    this.headers = { ...config.headers };
    this.credentialStore = config.credentialStore;
    this.credentialKey = config.credentialKey ?? `${this.id}.apiKey`;
    this.credentialRequired = config.credentialRequired ?? false;
    this.fetchImplementation = config.fetch ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      modelDiscovery: true,
      textGeneration: true,
      toolCalling: true,
      // Generic compatible gateways do not all implement the OpenAI stream
      // contract. Only the official OpenAI catalog identity opts in.
      progressStreaming: this.providerId === "openai",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = await this.request("/models", { method: "GET" }, "list_models");
    const record = this.requireRecord(payload, "models response");

    if (!Array.isArray(record.data)) {
      throw this.invalidResponse("Provider returned an invalid models response");
    }

    const models = record.data.map((model, index) =>
      this.normalizeModel(model, `models response item ${index}`),
    );
    for (const model of models) if (model.capabilities) this.discoveredModelCapabilities.set(model.id, model.capabilities);
    return models;
  }

  modelCapabilities(modelId: string): ModelCapabilities | undefined {
    const discovered = this.discoveredModelCapabilities.get(modelId);
    const candidate = capabilityForModel(this.configuredExecutionRules(), modelId)
      ?? knownModelExecutionCapability(this.providerId, modelId);
    const declared = candidate?.kind === "openai_reasoning" ? candidate : undefined;
    if (!discovered && !declared) return undefined;
    return { ...discovered, ...(declared && !discovered?.execution ? { execution: declared } : {}) };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const executionOptions = assertExecutionOptionsSupported(request.executionOptions, this.modelCapabilities(request.model)?.execution);
    const maxOutputTokens = boundedOutputTokens(request.maxOutputTokens);
    const body = {
      model: request.model,
      messages: [
        { role: "user", content: request.prompt },
        ...(request.conversation?.map((message) => this.serializeMessage(message)) ?? []),
      ],
      ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
      ...(request.tools && request.tools.length > 0 ? {
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: "auto",
      } : {}),
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      ...(executionOptions.kind === "openai_reasoning" ? { reasoning_effort: executionOptions.effort } : {}),
    };
    if (request.onProgress && this.capabilities().progressStreaming) {
      return this.generateStreaming(request, body);
    }
    const payload = await this.request(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ ...body, stream: false }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      "generate",
    );
    const record = this.requireRecord(payload, "generation response");
    const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
    const choiceRecord = this.requireRecord(choice, "generation choice");
    const message = this.requireRecord(choiceRecord.message, "generation message");
    const toolCalls = this.normalizeToolCalls(message.tool_calls);

    if (typeof message.content !== "string" && toolCalls.length === 0) {
      throw this.invalidResponse("Provider returned no text content");
    }

    const responseModel =
      typeof record.model === "string" && record.model.length > 0
        ? record.model
        : request.model;
    const usage = this.normalizeUsage(record.usage);

    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      provider: this.id,
      model: responseModel,
      text: typeof message.content === "string" ? message.content : "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(typeof choiceRecord.finish_reason === "string"
        ? { finishReason: choiceRecord.finish_reason }
        : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async generateStreaming(request: GenerateRequest, body: UnknownRecord): Promise<GenerateResponse> {
    request.onProgress?.({ phase: "request_started" });
    const response = await this.requestResponse("/chat/completions", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      ...(request.signal ? { signal: request.signal } : {}),
    }, "generate");
    let id: string | undefined;
    let model = request.model;
    let text = "";
    let finishReason: string | undefined;
    let usage: GenerateUsage | undefined;
    let responseStarted = false;
    let receiving = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    try { await consumeSse(response, this.id, (data) => {
      const event = parseSseJson(data, this.id);
      if (!event) return;
      if (isRecord(event.error)) throw this.invalidResponse("Provider stream failed");
      if (typeof event.id === "string") id = event.id;
      if (typeof event.model === "string") model = event.model;
      if (isRecord(event.usage)) usage = this.normalizeUsage(event.usage);
      const choice = Array.isArray(event.choices) && event.choices.length > 0 ? this.requireRecord(event.choices[0], "stream choice") : undefined;
      if (!choice) return;
      if (!responseStarted) { responseStarted = true; request.onProgress?.({ phase: "response_started" }); }
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string") text += delta.content;
      if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
        if (!isRecord(raw) || typeof raw.index !== "number") continue;
        const current = calls.get(raw.index) ?? { id: "", name: "", arguments: "" };
        const fn = isRecord(raw.function) ? raw.function : {};
        if (typeof raw.id === "string") current.id += raw.id;
        if (typeof fn.name === "string") current.name += fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        calls.set(raw.index, current);
        if (typeof fn.name === "string" && fn.name && current.name === fn.name) request.onProgress?.({ phase: "tool_call_requested", toolName: safeToolName(fn.name) });
      }
      if (!receiving && (typeof delta.content === "string" || Array.isArray(delta.tool_calls))) {
        receiving = true; request.onProgress?.({ phase: "output_receiving" });
      }
    }); } catch (error) { throw streamError(error, this.id); }
    const toolCalls = this.normalizeToolCalls([...calls.values()].map((call) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })));
    if (!text && toolCalls.length === 0) throw this.invalidResponse("Provider returned no text content");
    request.onProgress?.({ phase: "request_completed" });
    return { ...(id ? { id } : {}), provider: this.id, model, text, ...(toolCalls.length ? { toolCalls } : {}), ...(finishReason ? { finishReason } : {}), ...(usage ? { usage } : {}) };
  }

  private serializeMessage(message: ModelConversationMessage): UnknownRecord {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content ?? null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      };
    }

    const payload = message.toolResult.error
      ? { error: message.toolResult.error }
      : { result: message.toolResult.result ?? null };
    return {
      role: "tool",
      tool_call_id: message.toolResult.callId,
      name: message.toolResult.name,
      content: JSON.stringify(payload),
    };
  }

  private normalizeToolCalls(value: unknown): ModelToolCall[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw this.invalidResponse("Provider returned invalid tool calls");
    }

    return value.map((rawCall) => {
      const call = this.requireRecord(rawCall, "tool call");
      const fn = this.requireRecord(call.function, "tool call function");
      if (
        typeof call.id !== "string" ||
        call.id.length === 0 ||
        typeof fn.name !== "string" ||
        fn.name.length === 0 ||
        typeof fn.arguments !== "string"
      ) {
        throw this.invalidResponse("Provider returned an invalid tool call");
      }

      let args: unknown;
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        throw this.invalidResponse("Provider returned invalid tool arguments");
      }

      return { id: call.id, name: fn.name, arguments: args };
    });
  }

  private async request(
    path: string,
    init: RequestInit,
    operation: Operation,
  ): Promise<unknown> {
    const response = await this.requestResponse(path, init, operation);
    try { return await response.json(); }
    catch { throw this.invalidResponse("Provider returned invalid JSON"); }
  }

  private async requestResponse(path: string, init: RequestInit, operation: Operation): Promise<Response> {
    const headers = new Headers(this.headers);
    headers.set("Accept", "application/json");
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));

    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const apiKey = await this.resolveApiKey();
    if (apiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }

    let response: Response;

    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ProviderError("Provider request timed out", { code: "timeout_error", providerId: this.id });
      }
      throw new ProviderError("Unable to reach the model provider", {
        code: "network_error",
        providerId: this.id,
      });
    }

    if (!response.ok) {
      throw this.httpError(response.status, operation);
    }
    return response;
  }

  private async resolveApiKey(): Promise<string | undefined> {
    if (this.apiKey !== undefined) {
      return this.apiKey;
    }

    try {
      const credential = await this.credentialStore?.get(this.credentialKey);
      if (!credential && this.credentialRequired) {
        throw new ProviderError("Provider credential is missing", { code: "authentication_error", providerId: this.id });
      }
      return credential;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Unable to load provider credentials", {
        code: "provider_error",
        providerId: this.id,
      });
    }
  }

  private normalizeModel(value: unknown, label: string): ModelInfo {
    const model = this.requireRecord(value, label);

    if (typeof model.id !== "string" || model.id.length === 0) {
      throw this.invalidResponse("Provider returned a model without an ID");
    }

    const contextWindow = this.optionalNumber(
      model.context_window ?? model.contextWindow,
    );
    const capabilities = this.normalizeModelCapabilities(model.capabilities);
    const candidateExecution = capabilityForModel(this.configuredExecutionRules(), model.id)
      ?? knownModelExecutionCapability(this.providerId, model.id);
    const declaredExecution = candidateExecution?.kind === "openai_reasoning" ? candidateExecution : undefined;

    return {
      id: model.id,
      name:
        typeof model.name === "string" && model.name.length > 0
          ? model.name
          : model.id,
      provider: this.id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(capabilities || declaredExecution ? { capabilities: { ...capabilities, ...(declaredExecution && !capabilities?.execution ? { execution: declaredExecution } : {}) } } : {}),
    };
  }

  private normalizeModelCapabilities(
    value: unknown,
  ): ModelCapabilities | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const capabilities: ModelCapabilities = {
      ...(typeof value.text === "boolean" ? { text: value.text } : {}),
      ...(typeof value.vision === "boolean" ? { vision: value.vision } : {}),
      ...(typeof value.tools === "boolean" ? { tools: value.tools } : {}),
      ...(typeof value.reasoning === "boolean"
        ? { reasoning: value.reasoning }
        : {}),
      ...(typeof (value.structuredOutput ?? value.structured_output) === "boolean"
        ? {
            structuredOutput: (value.structuredOutput ??
              value.structured_output) as boolean,
          }
        : {}),
      ...(this.normalizeDiscoveredExecution(value.execution ?? value.executionOptions ?? value.execution_options)
        ? { execution: this.normalizeDiscoveredExecution(value.execution ?? value.executionOptions ?? value.execution_options)! }
        : {}),
    };

    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
  }

  private configuredExecutionRules(): readonly ModelExecutionCapabilityRule[] {
    return this.config.modelExecutionCapabilities ?? [];
  }

  private normalizeDiscoveredExecution(value: unknown): ModelExecutionCapability | undefined {
    if (!this.isRecord(value)) return undefined;
    const reasoning = this.isRecord(value.reasoningEffort ?? value.reasoning_effort)
      ? value.reasoningEffort ?? value.reasoning_effort
      : value.kind === "openai_reasoning" ? value : undefined;
    if (!this.isRecord(reasoning)) return undefined;
    const rawValues = reasoning.values;
    if (!Array.isArray(rawValues)) return undefined;
    const supported = rawValues.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    if (supported.length === 0 || supported.length !== rawValues.length) return undefined;
    return {
      kind: "openai_reasoning",
      label: "Reasoning",
      control: "select",
      values: supported.map((item) => ({ value: item, label: item[0]!.toUpperCase() + item.slice(1) })),
      provenance: "provider_discovery",
    };
  }

  private normalizeUsage(value: unknown): GenerateUsage | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const inputTokens = this.optionalNumber(value.prompt_tokens ?? value.input_tokens ?? value.inputTokens);
    const outputTokens = this.optionalNumber(value.completion_tokens ?? value.output_tokens ?? value.outputTokens);
    const totalTokens = this.optionalNumber(value.total_tokens ?? value.totalTokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    const cost = this.optionalNumber(value.cost ?? value.total_cost);
    const currency = typeof value.currency === "string" && value.currency.trim() ? value.currency.trim() : undefined;
    const usage: GenerateUsage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(currency !== undefined ? { currency } : {}),
    };

    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  private httpError(statusCode: number, operation: Operation): ProviderError {
    let code: ProviderErrorCode = "provider_error";

    if (statusCode === 401 || statusCode === 403) {
      code = "authentication_error";
    } else if (statusCode === 429) {
      code = "rate_limit_error";
    } else if (operation === "generate" && statusCode === 404) {
      code = "invalid_model";
    }

    return new ProviderError(`Provider request failed with status ${statusCode}`, {
      code,
      providerId: this.id,
      statusCode,
    });
  }

  private invalidResponse(message: string): ProviderError {
    return new ProviderError(message, {
      code: "invalid_response",
      providerId: this.id,
    });
  }

  private requireRecord(value: unknown, label: string): UnknownRecord {
    if (!this.isRecord(value)) {
      throw this.invalidResponse(`Provider returned an invalid ${label}`);
    }

    return value;
  }

  private isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private normalizeBaseUrl(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return url.toString().replace(/\/$/, "");
    } catch {
      throw new ProviderError("Provider base URL is invalid", {
        code: "provider_error",
        providerId: this.id ?? DEFAULT_PROVIDER_ID,
      });
    }
  }
}

function isRecord(value: unknown): value is UnknownRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeToolName(value: string): string { return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "tool"; }
function streamError(error: unknown, providerId: string): unknown {
  if (error instanceof ProviderError || error instanceof Error && error.name === "AbortError") return error;
  return new ProviderError("Provider stream was interrupted", { code: "network_error", providerId });
}

function boundedOutputTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
