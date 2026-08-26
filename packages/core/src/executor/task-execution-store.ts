import type { ExecutionPlan } from "../planner/planner.types.js";
import { TaskGraph } from "../planner/task-graph.js";
import { ExecutorError } from "./executor-error.js";
import type {
  ExecutionResult,
  TaskExecutionState,
} from "./executor.types.js";

export class TaskExecutionStore {
  private readonly workflows = new Map<
    string,
    Map<string, TaskExecutionState>
  >();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  list(plan: ExecutionPlan): TaskExecutionState[] {
    return [...this.states(plan).values()];
  }

  begin(
    plan: ExecutionPlan,
    taskId: string,
  ): { readonly task: ReturnType<TaskGraph["getTask"]>; readonly state: TaskExecutionState } {
    const graph = new TaskGraph(plan);
    let task: ReturnType<TaskGraph["getTask"]>;
    try {
      task = graph.getTask(taskId);
    } catch {
      throw new ExecutorError("task_not_found", `Plan task does not exist: ${taskId}`);
    }
    const states = this.states(plan);
    const current = states.get(taskId)!;
    const completed = completedTaskIds(states);
    if (
      current.status === "running" ||
      current.status === "completed" ||
      !graph.isReady(taskId, completed)
    ) {
      throw new ExecutorError(
        "task_blocked",
        `Plan task is not ready for execution: ${taskId}`,
      );
    }

    const state: TaskExecutionState = {
      taskId,
      status: "running",
      attempts: current.attempts + 1,
      startedAt: this.now(),
    };
    states.set(taskId, state);
    return { task, state };
  }

  finish(plan: ExecutionPlan, result: ExecutionResult): TaskExecutionState {
    const states = this.states(plan);
    const current = states.get(result.taskId);
    if (!current || current.status !== "running") {
      throw new ExecutorError(
        "executor_error",
        `Task is not running: ${result.taskId}`,
      );
    }
    const state: TaskExecutionState = {
      ...current,
      status: result.status,
      completedAt: this.now(),
      result,
    };
    states.set(result.taskId, state);
    this.refresh(plan, states);
    return state;
  }

  fail(plan: ExecutionPlan, taskId: string): TaskExecutionState {
    const states = this.states(plan);
    const current = states.get(taskId);
    if (!current) {
      throw new ExecutorError("task_not_found", `Plan task does not exist: ${taskId}`);
    }
    const state: TaskExecutionState = {
      ...current,
      status: "failed",
      completedAt: this.now(),
    };
    states.set(taskId, state);
    this.refresh(plan, states);
    return state;
  }

  private states(plan: ExecutionPlan): Map<string, TaskExecutionState> {
    const existing = this.workflows.get(plan.id);
    if (existing) return existing;

    const states = new Map(
      plan.tasks.map((task) => [
        task.id,
        {
          taskId: task.id,
          status: task.dependencies.length === 0 ? "ready" : "pending",
          attempts: 0,
        } satisfies TaskExecutionState,
      ]),
    );
    this.workflows.set(plan.id, states);
    return states;
  }

  private refresh(
    plan: ExecutionPlan,
    states: Map<string, TaskExecutionState>,
  ): void {
    const graph = new TaskGraph(plan);
    const completed = completedTaskIds(states);
    for (const task of plan.tasks) {
      const state = states.get(task.id)!;
      if (["running", "completed", "failed"].includes(state.status)) continue;
      const hasFailedDependency = task.dependencies.some(
        (dependency) => states.get(dependency)?.status === "failed",
      );
      states.set(task.id, {
        ...state,
        status: hasFailedDependency
          ? "blocked"
          : graph.isReady(task.id, completed)
            ? "ready"
            : "pending",
      });
    }
  }
}

function completedTaskIds(
  states: ReadonlyMap<string, TaskExecutionState>,
): ReadonlySet<string> {
  return new Set(
    [...states.values()]
      .filter((state) => state.status === "completed")
      .map((state) => state.taskId),
  );
}
