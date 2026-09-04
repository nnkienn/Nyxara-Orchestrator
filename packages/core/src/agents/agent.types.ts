import type { ExecutionOptions } from "@nyxara/provider-sdk";

export type AgentRole = "planner" | "executor" | "reviewer";

export interface AgentModelConfig {
  readonly role: AgentRole;
  readonly providerId: string;
  readonly modelId: string;
  /** Omitted legacy values migrate to Provider Default in AgentModelRegistry. */
  readonly executionOptions?: ExecutionOptions;
}
