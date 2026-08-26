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
}

export interface GenerateUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface GenerateResponse {
  readonly id?: string;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly finishReason?: string;
  readonly usage?: GenerateUsage;
}

export interface ProviderCapabilities {
  readonly modelDiscovery: boolean;
  readonly textGeneration: boolean;
}

export interface ProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
}

