import type {
  GenerateRequest,
  GenerateResponse,
  ModelCapabilities,
  ModelInfo,
  ProviderCapabilities,
} from "./provider.types.js";

export interface ModelProvider {
  readonly id: string;
  /** Stable provider/catalog identity; `id` remains the local provider configuration identity. */
  readonly providerId?: string;
  readonly displayName: string;

  listModels(): Promise<ModelInfo[]>;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  capabilities(): ProviderCapabilities;
  /** Synchronous, locally cached/known capabilities. This method never performs discovery. */
  modelCapabilities?(modelId: string): ModelCapabilities | undefined;
}
