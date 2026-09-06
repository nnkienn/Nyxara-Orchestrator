import { z } from "zod";
import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ContextBudget, ContextBundle } from "../context/context.types.js";
import type {
  PlanningClarificationReason,
  PlanningContextMode,
  PlanningRequestSignals,
} from "../context/planning-context-policy.js";
import type { TaskGraph } from "./task-graph.js";
import type { PlanningProfile, PlanningProfileMetadata } from "./planning-profile.js";
import type { ResolvedRuleSet } from "../rules/engineering-rule.js";
import type { EngineeringRule } from "../rules/engineering-rule.js";

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
  /**
   * Cheap client-known signals for the deterministic pre-planning context gate.
   * They only anchor minimal or targeted retrieval; no model call is involved.
   */
  readonly requestSignals?: PlanningRequestSignals;
  /** Optional Planner-specific output bound. It is validated to a safe range. */
  readonly plannerMaxOutputTokens?: number;
  /** Links the plan to Core workflow state so planning transitions are recorded. */
  readonly workflowId?: string;
  readonly constraints?: readonly string[];
  readonly contextBudget?: Partial<ContextBudget>;
  readonly signal?: AbortSignal;
  /** Omit to use the built-in default. An explicit unknown ID fails before provider use. */
  readonly planningProfileId?: string;
  /** Process-local overrides for this planning run; workspace overrides global rules. */
  readonly workspaceRules?: readonly EngineeringRule[];
  /** Task-specific overrides keyed by the stable planned task ID. */
  readonly taskRules?: Readonly<Record<string, readonly EngineeringRule[]>>;
}

export interface PlannerRunInput {
  readonly input: PlannerInput;
  readonly model: AgentModelConfig;
  readonly planningProfile?: PlanningProfile;
  readonly engineeringRules?: ResolvedRuleSet;
  readonly workflowId?: string;
  /**
   * Planner-specific output bound. It is role-scoped: Executor, Reviewer, and
   * Repair generation is unaffected.
   */
  readonly maxOutputTokens?: number;
}

export interface PlanClarificationResult {
  readonly kind: "clarification_required";
  readonly reason: PlanningClarificationReason;
  readonly planningContextMode: PlanningContextMode;
  readonly prompt: string;
  /** Metadata-only record of the context Nyxara deliberately did not collect. */
  readonly contextMetrics: PlanningContextMetrics;
}

export interface PlanningContextMetrics {
  readonly planningContextMode: PlanningContextMode;
  readonly files: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly plannerMaxOutputTokens: number | null;
}

export interface PlanResult {
  readonly plan: ExecutionPlan;
  readonly context: ContextBundle;
  readonly model: AgentModelConfig;
  readonly graph: TaskGraph;
  /** Compact generation metadata; it is not part of the execution plan fingerprint. */
  readonly planningProfile: PlanningProfileMetadata;
  readonly planningProfileId: string;
  readonly ruleSetFingerprint?: string;
  readonly effectiveRuleIds?: readonly string[];
  /** Deterministic pre-planning context decision applied to this run. */
  readonly planningContextMode: PlanningContextMode;
  readonly contextMetrics: PlanningContextMetrics;
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
