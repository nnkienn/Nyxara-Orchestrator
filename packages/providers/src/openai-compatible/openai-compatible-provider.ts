import {
  ProviderError,
  type CredentialStore,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateUsage,
  type ModelCapabilities,
  type ModelInfo,
  type ModelProvider,
  type ProviderCapabilities,
  type ProviderErrorCode,
} from "@nyxara/provider-sdk";

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
  readonly fetch?: typeof globalThis.fetch;
}

type Operation = "list_models" | "generate";
type UnknownRecord = Record<string, unknown>;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly credentialStore: CredentialStore | undefined;
  private readonly credentialKey: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(config: OpenAICompatibleProviderConfig = {}) {
    this.id = config.id ?? DEFAULT_PROVIDER_ID;
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = config.apiKey;
    this.headers = { ...config.headers };
    this.credentialStore = config.credentialStore;
    this.credentialKey = config.credentialKey ?? `${this.id}.apiKey`;
    this.fetchImplementation = config.fetch ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      modelDiscovery: true,
      textGeneration: true,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = await this.request("/models", { method: "GET" }, "list_models");
    const record = this.requireRecord(payload, "models response");

    if (!Array.isArray(record.data)) {
      throw this.invalidResponse("Provider returned an invalid models response");
    }

    return record.data.map((model, index) =>
      this.normalizeModel(model, `models response item ${index}`),
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const payload = await this.request(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: "user", content: request.prompt }],
          stream: false,
        }),
      },
      "generate",
    );
    const record = this.requireRecord(payload, "generation response");
    const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
    const choiceRecord = this.requireRecord(choice, "generation choice");
    const message = this.requireRecord(choiceRecord.message, "generation message");

    if (typeof message.content !== "string") {
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
      text: message.content,
      ...(typeof choiceRecord.finish_reason === "string"
        ? { finishReason: choiceRecord.finish_reason }
        : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    operation: Operation,
  ): Promise<unknown> {
    const headers = new Headers(this.headers);
    headers.set("Accept", "application/json");

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
      });
    } catch {
      throw new ProviderError("Unable to reach the model provider", {
        code: "network_error",
        providerId: this.id,
      });
    }

    if (!response.ok) {
      throw this.httpError(response.status, operation);
    }

    try {
      return await response.json();
    } catch {
      throw this.invalidResponse("Provider returned invalid JSON");
    }
  }

  private async resolveApiKey(): Promise<string | undefined> {
    if (this.apiKey !== undefined) {
      return this.apiKey;
    }

    try {
      return await this.credentialStore?.get(this.credentialKey);
    } catch {
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

    return {
      id: model.id,
      name:
        typeof model.name === "string" && model.name.length > 0
          ? model.name
          : model.id,
      provider: this.id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(capabilities ? { capabilities } : {}),
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
    };

    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
  }

  private normalizeUsage(value: unknown): GenerateUsage | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const inputTokens = this.optionalNumber(value.prompt_tokens);
    const outputTokens = this.optionalNumber(value.completion_tokens);
    const totalTokens = this.optionalNumber(value.total_tokens);
    const usage: GenerateUsage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
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
