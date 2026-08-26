import type { AgentModelConfig, AgentRole } from "./agent.types.js";

export type AgentModelConfigErrorCode =
  | "invalid_agent_config"
  | "duplicate_agent_role"
  | "unconfigured_agent_role";

export class AgentModelConfigError extends Error {
  constructor(
    readonly code: AgentModelConfigErrorCode,
    readonly role: AgentRole,
    message: string,
  ) {
    super(message);
    this.name = "AgentModelConfigError";
  }
}

export class AgentModelRegistry {
  private readonly configurations = new Map<AgentRole, AgentModelConfig>();

  constructor(configurations: readonly AgentModelConfig[] = []) {
    for (const configuration of configurations) {
      if (this.configurations.has(configuration.role)) {
        throw new AgentModelConfigError(
          "duplicate_agent_role",
          configuration.role,
          `Agent role is configured more than once: ${configuration.role}`,
        );
      }
      this.set(configuration);
    }
  }

  set(configuration: AgentModelConfig): void {
    const normalized = normalizeAgentModelConfig(configuration);
    this.configurations.set(normalized.role, normalized);
  }

  get(role: AgentRole): AgentModelConfig {
    const configuration = this.configurations.get(role);
    if (!configuration) {
      throw new AgentModelConfigError(
        "unconfigured_agent_role",
        role,
        `No model is configured for agent role: ${role}`,
      );
    }
    return configuration;
  }

  list(): AgentModelConfig[] {
    return [...this.configurations.values()];
  }
}

function normalizeAgentModelConfig(
  configuration: AgentModelConfig,
): AgentModelConfig {
  const providerId = configuration.providerId.trim();
  const modelId = configuration.modelId.trim();
  if (providerId.length === 0 || modelId.length === 0) {
    throw new AgentModelConfigError(
      "invalid_agent_config",
      configuration.role,
      "Agent provider and model IDs are required",
    );
  }

  return { role: configuration.role, providerId, modelId };
}

