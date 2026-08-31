import type { ExecutionPlan } from "../planner/planner.types.js";
import { TaskGraph } from "../planner/task-graph.js";
import { ExecutorError } from "./executor-error.js";
import type {
  ExecutionResult,
  TaskExecutionState,
  TaskExecutionStatus,
  TaskExecutionSummary,
} from "./executor.types.js";

export interface TaskExecutionStoreLimits {
  readonly maxPlans: number;
  readonly maxTasksPerPlan: number;
}

export const DEFAULT_TASK_EXECUTION_STORE_LIMITS: TaskExecutionStoreLimits = {
  maxPlans: 10,
  maxTasksPerPlan: 200,
};

/**
 * Legal task runtime transitions. `failed -> running` exists only so the repair
 * path can retry a task; everything outside this table is rejected instead of
 * being silently applied.
 */
export const TASK_TRANSITIONS: Readonly<
  Record<TaskExecutionStatus, readonly TaskExecutionStatus[]>
> = {
  pending: ["ready", "blocked"],
  ready: ["running", "pending", "blocked"],
  running: ["completed", "failed"],
  completed: [],
  failed: ["running"],
  blocked: ["pending", "ready"],
};

export function canTransitionTask(
  from: TaskExecutionStatus,
  to: TaskExecutionStatus,
): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
}

interface PlanRecord {
  readonly states: Map<string, TaskExecutionState>;
  heavyTaskId?: string;
}

export class TaskExecutionStore {
  private readonly plans = new Map<string, PlanRecord>();
  private readonly limits: TaskExecutionStoreLimits;

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    limits: Partial<TaskExecutionStoreLimits> = {},
  ) {
    this.limits = { ...DEFAULT_TASK_EXECUTION_STORE_LIMITS, ...limits };
  }

  list(plan: ExecutionPlan): TaskExecutionState[] {
    return [...this.record(plan).states.values()];
  }

  get(plan: ExecutionPlan, taskId: string): TaskExecutionState | undefined {
    return this.record(plan).states.get(taskId);
  }

  begin(
    plan: ExecutionPlan,
    taskId: string,
  ): {
    readonly task: ReturnType<TaskGraph["getTask"]>;
    readonly state: TaskExecutionState;
  } {
    const graph = new TaskGraph(plan);
    let task: ReturnType<TaskGraph["getTask"]>;
    try {
      task = graph.getTask(taskId);
    } catch {
      throw new ExecutorError(
        "task_not_found",
        "Plan task does not exist: " + taskId,
      );
    }
    const record = this.record(plan);
    const current = record.states.get(taskId)!;
    const completed = completedTaskIds(record.states);
    if (
      !canTransitionTask(current.status, "running") ||
      !graph.isReady(taskId, completed)
    ) {
      throw new ExecutorError(
        "task_blocked",
        "Plan task is not ready for execution: " + taskId,
      );
    }

    const state: TaskExecutionState = {
      taskId,
      status: "running",
      attempts: current.attempts + 1,
      startedAt: this.now(),
    };
    record.states.set(taskId, state);
    return { task, state };
  }

  finish(plan: ExecutionPlan, result: ExecutionResult): TaskExecutionState {
    const record = this.record(plan);
    const current = record.states.get(result.taskId);
    if (!current || current.status !== "running") {
      throw new ExecutorError(
        "executor_error",
        "Task is not running: " + result.taskId,
      );
    }
    this.assertTransition(current.status, result.status, result.taskId);

    const state: TaskExecutionState = {
      ...current,
      status: result.status,
      completedAt: this.now(),
      result,
      resultSummary: summarize(result),
    };
    record.states.set(result.taskId, state);
    this.releaseSupersededEvidence(record, result.taskId);
    this.refresh(plan, record.states);
    return state;
  }

  fail(plan: ExecutionPlan, taskId: string): TaskExecutionState {
    const record = this.record(plan);
    const current = record.states.get(taskId);
    if (!current) {
      throw new ExecutorError(
        "task_not_found",
        "Plan task does not exist: " + taskId,
      );
    }
    this.assertTransition(current.status, "failed", taskId);
    const state: TaskExecutionState = {
      ...current,
      status: "failed",
      completedAt: this.now(),
    };
    record.states.set(taskId, state);
    this.releaseSupersededEvidence(record, taskId);
    this.refresh(plan, record.states);
    return state;
  }

  private assertTransition(
    from: TaskExecutionStatus,
    to: TaskExecutionStatus,
    taskId: string,
  ): void {
    if (!canTransitionTask(from, to)) {
      throw new ExecutorError(
        "invalid_task_transition",
        "Illegal task transition for " + taskId + ": " + from + " -> " + to,
      );
    }
  }

  /**
   * Only the most recent terminal task keeps its full ExecutionResult, because
   * Reviewer and Repair consume it immediately after the task finishes. Earlier
   * tasks fall back to their compacted summary.
   */
  private releaseSupersededEvidence(record: PlanRecord, taskId: string): void {
    const previous = record.heavyTaskId;
    record.heavyTaskId = taskId;
    if (previous === undefined || previous === taskId) return;
    const stale = record.states.get(previous);
    if (!stale?.result) return;
    const { result, ...compacted } = stale;
    record.states.set(previous, compacted);
  }

  private record(plan: ExecutionPlan): PlanRecord {
    const existing = this.plans.get(plan.id);
    if (existing) {
      // Re-insert so eviction order tracks recency of use.
      this.plans.delete(plan.id);
      this.plans.set(plan.id, existing);
      return existing;
    }

    if (plan.tasks.length > this.limits.maxTasksPerPlan) {
      throw new ExecutorError(
        "task_limit_reached",
        "Plan exceeds the task retention bound: " + String(plan.tasks.length),
      );
    }

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
    const record: PlanRecord = { states };
    this.plans.set(plan.id, record);
    this.evictPlans();
    return record;
  }

  /** Plans holding a running task are never evicted. */
  private evictPlans(): void {
    while (this.plans.size > this.limits.maxPlans) {
      let victim: string | undefined;
      for (const [planId, record] of this.plans) {
        const running = [...record.states.values()].some(
          (state) => state.status === "running",
        );
        if (!running) {
          victim = planId;
          break;
        }
      }
      if (victim === undefined) return;
      this.plans.delete(victim);
    }
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
      const next: TaskExecutionStatus = hasFailedDependency
        ? "blocked"
        : graph.isReady(task.id, completed)
          ? "ready"
          : "pending";
      if (!canTransitionTask(state.status, next)) continue;
      states.set(task.id, { ...state, status: next });
    }
  }
}

function summarize(result: ExecutionResult): TaskExecutionSummary {
  return {
    taskId: result.taskId,
    status: result.status,
    summary: result.summary,
    changedFiles: [...result.changedFiles],
    diffFiles: [...result.diff.files],
    diffTruncated: result.diff.truncated,
    toolCalls: result.toolCalls,
    modelTurns: result.modelTurns,
    ...(result.unresolvedIssues
      ? { unresolvedIssues: [...result.unresolvedIssues] }
      : {}),
  };
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
