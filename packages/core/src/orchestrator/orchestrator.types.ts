import type { ModelProvider } from "@nyxara/provider-sdk";

export interface RunInput {
  readonly workspace: string;
  readonly prompt: string;
}

export interface NyxaraOrchestratorConfig {
  readonly providers?: readonly ModelProvider[];
}

export interface ModelGenerateInput {
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
}
