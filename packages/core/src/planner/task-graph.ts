import { PlannerError } from "./planner-error.js";
import type { ExecutionPlan, PlannedTask } from "./planner.types.js";

export class TaskGraph {
  private readonly tasks: ReadonlyMap<string, PlannedTask>;
  private readonly dependents = new Map<string, string[]>();

  constructor(plan: ExecutionPlan) {
    this.tasks = new Map(plan.tasks.map((task) => [task.id, task]));
    for (const task of plan.tasks) {
      for (const dependency of task.dependencies) {
        const dependents = this.dependents.get(dependency) ?? [];
        dependents.push(task.id);
        this.dependents.set(dependency, dependents);
      }
    }
  }

  getReadyTasks(completedTaskIds: ReadonlySet<string> = new Set()): PlannedTask[] {
    return [...this.tasks.values()].filter(
      (task) =>
        !completedTaskIds.has(task.id) &&
        task.dependencies.every((dependency) => completedTaskIds.has(dependency)),
    );
  }

  getTask(taskId: string): PlannedTask {
    return this.requireTask(taskId);
  }

  isReady(
    taskId: string,
    completedTaskIds: ReadonlySet<string> = new Set(),
  ): boolean {
    const task = this.requireTask(taskId);
    return (
      !completedTaskIds.has(taskId) &&
      task.dependencies.every((dependency) => completedTaskIds.has(dependency))
    );
  }

  getBlockedTasks(
    completedTaskIds: ReadonlySet<string> = new Set(),
  ): PlannedTask[] {
    const ready = new Set(
      this.getReadyTasks(completedTaskIds).map((task) => task.id),
    );
    return [...this.tasks.values()].filter(
      (task) => !completedTaskIds.has(task.id) && !ready.has(task.id),
    );
  }

  getDependents(taskId: string): PlannedTask[] {
    this.requireTask(taskId);
    return (this.dependents.get(taskId) ?? []).map((id) => this.tasks.get(id)!);
  }

  getDependencies(taskId: string, transitive = false): PlannedTask[] {
    const task = this.requireTask(taskId);
    if (!transitive) {
      return task.dependencies.map((id) => this.tasks.get(id)!);
    }

    const visited = new Set<string>();
    const visit = (id: string): void => {
      for (const dependency of this.requireTask(id).dependencies) {
        if (!visited.has(dependency)) {
          visited.add(dependency);
          visit(dependency);
        }
      }
    };
    visit(taskId);
    return [...visited].map((id) => this.tasks.get(id)!);
  }

  hasCycle(): boolean {
    return detectTaskCycle([...this.tasks.values()]);
  }

  private requireTask(taskId: string): PlannedTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new PlannerError("invalid_plan", `Unknown task: ${taskId}`);
    }
    return task;
  }
}

export function detectTaskCycle(tasks: readonly PlannedTask[]): boolean {
  const dependencies = new Map(
    tasks.map((task) => [task.id, task.dependencies] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    for (const dependency of dependencies.get(taskId) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };

  return tasks.some((task) => visit(task.id));
}
