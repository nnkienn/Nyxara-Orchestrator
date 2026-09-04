export interface ModelCapabilities {
  readonly text?: boolean;
  readonly vision?: boolean;
  readonly tools?: boolean;
  readonly reasoning?: boolean;
  readonly structuredOutput?: boolean;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly contextWindow?: number;
  readonly capabilities?: ModelCapabilities;
}

export interface GenerateRequest {
  readonly model: string;
  readonly prompt: string;
  readonly responseFormat?: "text" | "json";
  readonly tools?: readonly ModelToolDefinition[];
  readonly conversation?: readonly ModelConversationMessage[];
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ModelToolResult {
  readonly callId: string;
  readonly name: string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type ModelConversationMessage =
  | {
      readonly role: "assistant";
      readonly content?: string;
      readonly toolCalls?: readonly ModelToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolResult: ModelToolResult;
    };

export interface GenerateUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** Provider-reported authoritative cost, when supplied by the provider. */
  readonly cost?: number;
  readonly currency?: string;
}

export interface GenerateResponse {
  readonly id?: string;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly finishReason?: string;
  readonly usage?: GenerateUsage;
}

export interface ProviderCapabilities {
  readonly modelDiscovery: boolean;
  readonly textGeneration: boolean;
  readonly structuredOutput?: boolean;
  readonly toolCalling?: boolean;
}

export type ProviderCategory = "official" | "compatible" | "local" | "community";
export type ProviderAuthMethod = "api_key" | "oauth" | "device_code" | "local" | "none";

/** Provider-owned onboarding facts. Clients render only the capabilities declared here. */
export interface ProviderOnboardingCapabilities {
  readonly category: ProviderCategory;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly defaultEndpoint?: string;
  readonly modelDiscovery: boolean;
  readonly manualModelId: boolean;
  /** Official/non-secret destination for creating a provider API key. */
  readonly apiKeyHelpUrl?: string;
}

export interface ProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
}
