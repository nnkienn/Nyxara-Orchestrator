import type {
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  ProviderCapabilities,
} from "./provider.types.js";

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;

  listModels(): Promise<ModelInfo[]>;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  capabilities(): ProviderCapabilities;
}

