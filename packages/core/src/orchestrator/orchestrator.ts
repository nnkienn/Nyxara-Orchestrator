import type {
  GenerateResponse,
  ModelInfo,
  ModelProvider,
  ProviderInfo,
} from "@nyxara/provider-sdk";
import type { WorkflowState } from "@nyxara/shared";
import {
  createDefaultToolRegistry,
  type ToolContext,
  type ToolRegistry,
  type ToolRegistryEvent,
} from "@nyxara/tools";
import { ContextEngine } from "../context/context-engine.js";
import type {
  BuildContextInput,
  ContextBundle,
} from "../context/context.types.js";
import { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import type {
  ModelGenerateInput,
  NyxaraOrchestratorConfig,
  RunInput,
} from "./orchestrator.types.js";

export class NyxaraOrchestrator {
  readonly events = new EventBus<NyxaraEventMap>();

  private readonly workflowEngine = new WorkflowEngine(this.events);
  private readonly providerRegistry = new ProviderRegistry();
  private readonly toolRegistry: ToolRegistry;
  private readonly contextEngine: ContextEngine;

  constructor(config: NyxaraOrchestratorConfig = {}) {
    this.toolRegistry =
      config.toolRegistry ??
      createDefaultToolRegistry({
        observer: (event) => this.emitToolRegistryEvent(event),
      });
    this.contextEngine = new ContextEngine(this.toolRegistry, this.events);

    for (const provider of config.providers ?? []) {
      this.registerProvider(provider);
    }
  }

  async run(input: RunInput): Promise<WorkflowState> {
    return this.workflowEngine.run(input);
  }

  registerProvider(provider: ModelProvider): void {
    this.providerRegistry.register(provider);
    this.events.emit("provider.registered", {
      provider: {
        id: provider.id,
        displayName: provider.displayName,
        capabilities: { ...provider.capabilities() },
      },
    });
  }

  listProviders(): ProviderInfo[] {
    return this.providerRegistry.list();
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    try {
      const models = await this.providerRegistry.get(providerId).listModels();
      this.events.emit("provider.models.completed", { providerId, models });
      return models;
    } catch (error: unknown) {
      this.emitProviderFailure(providerId, "list_models", error);
      throw error;
    }
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResponse> {
    try {
      const response = await this.providerRegistry.get(input.providerId).generate({
        model: input.model,
        prompt: input.prompt,
      });
      this.events.emit("provider.generation.completed", {
        providerId: input.providerId,
        response,
      });
      return response;
    } catch (error: unknown) {
      this.emitProviderFailure(input.providerId, "generate", error);
      throw error;
    }
  }

  listTools(): string[] {
    return this.toolRegistry.list();
  }

  executeTool<TInput, TOutput>(
    name: string,
    input: TInput,
    context: ToolContext,
  ): Promise<TOutput> {
    return this.toolRegistry.execute(name, input, context);
  }

  inspectRepository(input: BuildContextInput): Promise<ContextBundle> {
    return this.contextEngine.build(input);
  }

  private emitProviderFailure(
    providerId: string,
    operation: "list_models" | "generate",
    error: unknown,
  ): void {
    this.events.emit("provider.operation.failed", {
      providerId,
      operation,
      error: {
        message: error instanceof Error ? error.message : "Unknown provider error",
      },
    });
  }

  private emitToolRegistryEvent(event: ToolRegistryEvent): void {
    switch (event.type) {
      case "permission.requested":
        this.events.emit(event.type, {
          tool: event.tool,
          capability: event.capability,
          ...(event.resource ? { resource: event.resource } : {}),
          ...(event.command ? { command: event.command } : {}),
        });
        break;
      case "permission.allowed":
      case "permission.denied":
        this.events.emit(event.type, {
          tool: event.tool,
          capability: event.capability,
        });
        break;
      case "tool.started":
        this.events.emit(event.type, { tool: event.tool });
        break;
      case "tool.completed":
        this.events.emit(event.type, {
          tool: event.tool,
          durationMs: event.durationMs,
        });
        break;
      case "tool.failed":
        this.events.emit(event.type, { tool: event.tool, code: event.code });
        break;
    }
  }
}
