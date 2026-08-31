import { z } from "zod";
import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ContextBudget, ContextBundle } from "../context/context.types.js";
import type { TaskGraph } from "./task-graph.js";

export const PlanRiskSchema = z.object({
  description: z.string().trim().min(1),
  severity: z.enum(["low", "medium", "high"]),
  mitigation: z.string().trim().min(1).optional(),
});

export const PlannedTaskSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  dependencies: z.array(z.string().trim().min(1)),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  relevantFiles: z.array(z.string().trim().min(1)).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
});

export const ExecutionPlanDraftSchema = z.object({
  objective: z.string().trim().min(1),
  summary: z.string().trim().min(1).optional(),
  tasks: z.array(PlannedTaskSchema).min(1),
  risks: z.array(PlanRiskSchema).optional(),
  assumptions: z.array(z.string().trim().min(1)).optional(),
});

export const ExecutionPlanSchema = ExecutionPlanDraftSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type PlanRisk = Readonly<z.infer<typeof PlanRiskSchema>>;
export type PlannedTask = Readonly<z.infer<typeof PlannedTaskSchema>>;
export type ExecutionPlanDraft = Readonly<
  z.infer<typeof ExecutionPlanDraftSchema>
>;
export type ExecutionPlan = Readonly<z.infer<typeof ExecutionPlanSchema>>;

export interface PlannerInput {
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly context: ContextBundle;
  readonly constraints?: readonly string[];
}

export interface CreatePlanInput {
  readonly workspaceRoot: string;
  readonly prompt: string;
  /** Links the plan to Core workflow state so planning transitions are recorded. */
  readonly workflowId?: string;
  readonly constraints?: readonly string[];
  readonly contextBudget?: Partial<ContextBudget>;
  readonly signal?: AbortSignal;
}

export interface PlannerRunInput {
  readonly input: PlannerInput;
  readonly model: AgentModelConfig;
}

export interface PlanResult {
  readonly plan: ExecutionPlan;
  readonly context: ContextBundle;
  readonly model: AgentModelConfig;
  readonly graph: TaskGraph;
}

export function normalizePlannerInput(input: PlannerInput): PlannerInput {
  const prompt = input.prompt.trim();
  const workspaceRoot = input.workspaceRoot.trim();
  if (prompt.length === 0 || workspaceRoot.length === 0) {
    throw new Error("Planner prompt and workspace root are required");
  }

  const constraints = input.constraints
    ?.map((constraint) => constraint.trim())
    .filter((constraint, index, values) =>
      constraint.length > 0 && values.indexOf(constraint) === index,
    );

  return {
    prompt,
    workspaceRoot,
    context: input.context,
    ...(constraints && constraints.length > 0 ? { constraints } : {}),
  };
}
