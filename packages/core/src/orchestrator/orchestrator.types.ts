import type { ModelProvider } from "@nyxara/provider-sdk";
import type { ToolRegistry } from "@nyxara/tools";

export interface RunInput {
  readonly workspace: string;
  readonly prompt: string;
}

export interface NyxaraOrchestratorConfig {
  readonly providers?: readonly ModelProvider[];
  readonly toolRegistry?: ToolRegistry;
}

export interface ModelGenerateInput {
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
}
