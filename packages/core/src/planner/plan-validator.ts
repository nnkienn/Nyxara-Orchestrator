import { ExecutionPlanSchema, type ExecutionPlan } from "./planner.types.js";
import { PlannerError, type PlannerStructureViolation } from "./planner-error.js";
import { detectTaskCycle } from "./task-graph.js";

/**
 * Structural bounds on an accepted plan. They keep plan cards renderable and
 * bound history/projection size; semantic correctness stays in `validate`.
 */
export interface PlanStructureBounds {
  readonly maxTasks: number;
  readonly maxObjectiveCharacters: number;
  readonly maxSummaryCharacters: number;
  readonly maxTitleCharacters: number;
  readonly maxDescriptionCharacters: number;
  readonly maxAcceptanceCriteriaPerTask: number;
  readonly maxAcceptanceCriterionCharacters: number;
  readonly maxRelevantFilesPerTask: number;
  readonly maxRisks: number;
  readonly maxRiskDescriptionCharacters: number;
  readonly maxRiskMitigationCharacters: number;
  readonly maxAssumptions: number;
  readonly maxAssumptionCharacters: number;
}

export const DEFAULT_PLAN_STRUCTURE_BOUNDS: PlanStructureBounds = Object.freeze({
  maxTasks: 12,
  maxObjectiveCharacters: 500,
  maxSummaryCharacters: 1_000,
  maxTitleCharacters: 160,
  maxDescriptionCharacters: 2_000,
  maxAcceptanceCriteriaPerTask: 6,
  maxAcceptanceCriterionCharacters: 400,
  maxRelevantFilesPerTask: 12,
  maxRisks: 8,
  maxRiskDescriptionCharacters: 500,
  maxRiskMitigationCharacters: 500,
  maxAssumptions: 8,
  maxAssumptionCharacters: 400,
});

export class PlanValidator {
  constructor(
    private readonly bounds: PlanStructureBounds = DEFAULT_PLAN_STRUCTURE_BOUNDS,
  ) {}

  get structureBounds(): PlanStructureBounds {
    return this.bounds;
  }

  validate(input: unknown): ExecutionPlan {
    const result = ExecutionPlanSchema.safeParse(input);
    if (!result.success) {
      throw new PlannerError(
        "invalid_plan",
        "Planner returned a plan that does not match the required schema",
      );
    }

    const plan = result.data;
    const taskIds = new Set<string>();
    for (const task of plan.tasks) {
      if (taskIds.has(task.id)) {
        throw new PlannerError(
          "invalid_plan",
          `Planner returned duplicate task ID: ${task.id}`,
        );
      }
      taskIds.add(task.id);
    }

    for (const task of plan.tasks) {
      for (const dependency of task.dependencies) {
        if (dependency === task.id) {
          throw new PlannerError(
            "self_dependency",
            `Task cannot depend on itself: ${task.id}`,
          );
        }
        if (!taskIds.has(dependency)) {
          throw new PlannerError(
            "missing_dependency",
            `Task ${task.id} references missing dependency: ${dependency}`,
          );
        }
      }
    }

    if (detectTaskCycle(plan.tasks)) {
      throw new PlannerError(
        "plan_cycle_detected",
        "Planner returned a cyclic task graph",
      );
    }

    this.assertWithinStructureBounds(plan);
    return plan;
  }

  /**
   * Rejects an oversized plan instead of silently truncating it. Truncating
   * structured output would produce an incomplete or invalid plan, so the
   * Planner is asked to produce a plan within bounds.
   */
  private assertWithinStructureBounds(plan: ExecutionPlan): void {
    const violations: PlannerStructureViolation[] = [];
    const limit = (
      actual: number,
      maximum: number,
      path: string,
      kind: PlannerStructureViolation["kind"],
    ): void => {
      if (actual > maximum) violations.push({ path, actual, maximum, kind });
    };

    limit(plan.objective.length, this.bounds.maxObjectiveCharacters, "objective", "length");
    limit(plan.summary?.length ?? 0, this.bounds.maxSummaryCharacters, "summary", "length");
    limit(plan.tasks.length, this.bounds.maxTasks, "tasks", "count");
    limit((plan.risks ?? []).length, this.bounds.maxRisks, "risks", "count");
    limit((plan.assumptions ?? []).length, this.bounds.maxAssumptions, "assumptions", "count");
    for (const task of plan.tasks) {
      limit(task.title.length, this.bounds.maxTitleCharacters, `tasks.${task.id}.title`, "length");
      limit(task.description.length, this.bounds.maxDescriptionCharacters, `tasks.${task.id}.description`, "length");
      limit(task.acceptanceCriteria.length, this.bounds.maxAcceptanceCriteriaPerTask, `tasks.${task.id}.acceptanceCriteria`, "count");
      for (const [index, criterion] of task.acceptanceCriteria.entries()) {
        limit(criterion.length, this.bounds.maxAcceptanceCriterionCharacters, `tasks.${task.id}.acceptanceCriteria.${index}`, "length");
      }
      limit(task.relevantFiles?.length ?? 0, this.bounds.maxRelevantFilesPerTask, `tasks.${task.id}.relevantFiles`, "count");
    }
    for (const [index, risk] of (plan.risks ?? []).entries()) {
      limit(risk.description.length, this.bounds.maxRiskDescriptionCharacters, `risks.${index}.description`, "length");
      limit(risk.mitigation?.length ?? 0, this.bounds.maxRiskMitigationCharacters, `risks.${index}.mitigation`, "length");
    }
    for (const [index, assumption] of (plan.assumptions ?? []).entries()) {
      limit(assumption.length, this.bounds.maxAssumptionCharacters, `assumptions.${index}`, "length");
    }
    if (violations.length > 0) {
      const first = violations[0]!;
      throw new PlannerError(
        "plan_bounds_exceeded",
        `Planner returned a value beyond the supported bound (${first.path}: ${first.actual} > ${first.maximum})`,
        violations,
      );
    }
  }
}
