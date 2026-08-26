export type AgentRole = "planner" | "executor" | "reviewer";

export interface AgentModelConfig {
  readonly role: AgentRole;
  readonly providerId: string;
  readonly modelId: string;
}

