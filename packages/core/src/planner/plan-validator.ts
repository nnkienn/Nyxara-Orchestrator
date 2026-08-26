import { ExecutionPlanSchema, type ExecutionPlan } from "./planner.types.js";
import { PlannerError } from "./planner-error.js";
import { detectTaskCycle } from "./task-graph.js";

export class PlanValidator {
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

    return plan;
  }
}
