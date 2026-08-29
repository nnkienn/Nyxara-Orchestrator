import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ContextBundle, ContextFile } from "../context/context.types.js";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import type { Executor } from "../executor/executor.js";
import type { ExecutionResult } from "../executor/executor.types.js";
import type { ReviewResult } from "../review/reviewer.types.js";
import type { ValidationResult } from "../validation/validation.types.js";
import { RepairCycleStore } from "./repair-cycle-store.js";
import { RepairEvidenceBuilder } from "./repair-evidence-builder.js";
import { RepairError } from "./repair.errors.js";
import {
  deduplicateFindings,
  findingKey,
  RepairTaskBuilder,
  reviewFindings,
  validationFindings,
} from "./repair-task-builder.js";
import type {
  RepairCycleHistory,
  RepairEvidence,
  RepairFinding,
  RepairLimits,
  RepairOperations,
  RepairResult,
  RepairResultStatus,
  RepairTask,
  RepairWorkflowInput,
} from "./repair.types.js";

export const DEFAULT_REPAIR_LIMITS: RepairLimits = {
  maxRepairCycles: 3,
  maxExecutorAttemptsPerTask: 3,
  maxValidationAttempts: 4,
  maxReviewAttempts: 4,
  maxContextExpansions: 1,
  maxEvidenceBytes: 64 * 1024,
  maxDiffBytes: 48 * 1024,
  maxHistoryEntries: 6,
  stuckThreshold: 2,
};

interface LoopState {
  execution: ExecutionResult;
  validation: ValidationResult;
  review: ReviewResult | undefined;
  context: ContextBundle;
  cycles: number;
  executorAttempts: number;
  validationAttempts: number;
  reviewAttempts: number;
  contextExpansions: number;
  remainingFindings: readonly RepairFinding[];
}

/**
 * Bounded automatic repair loop.
 *
 * The loop repairs the current failure only. It never re-enters the Planner,
 * never rescans the repository, and never calls the Reviewer while
 * deterministic validation still fails.
 */
export class RepairOrchestrator {
  constructor(
    private readonly executor: Executor,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly taskBuilder = new RepairTaskBuilder(),
    private readonly evidenceBuilder = new RepairEvidenceBuilder(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(
    input: RepairWorkflowInput,
    model: AgentModelConfig,
    operations: RepairOperations,
  ): Promise<RepairResult> {
    const limits = resolveRepairLimits(input.limits);
    const cycleStore = new RepairCycleStore(limits.maxHistoryEntries, this.now);
    const history: RepairCycleHistory[] = [];
    const failureCounts = new Map<string, number>();
    const state: LoopState = {
      execution: input.execution,
      validation: input.validation,
      review: input.review,
      context: input.executorContext,
      cycles: 0,
      executorAttempts: 0,
      validationAttempts: 0,
      reviewAttempts: 0,
      contextExpansions: 0,
      remainingFindings: currentFindings(input.validation, input.review),
    };

    this.events.emit("repair.started", {
      taskId: input.originalTask.id,
      findingCount: state.remainingFindings.length,
    });

    const finish = (status: RepairResultStatus): RepairResult =>
      this.finish(status, input, state, history, limits);

    while (true) {
      if (input.signal?.aborted) return finish("aborted");

      if (state.validation.status === "passed" && state.review === undefined) {
        if (state.reviewAttempts >= limits.maxReviewAttempts) {
          this.emitLimit(input.originalTask.id, state.cycles);
          return finish("limit_reached");
        }
        const reviewed = await this.review(input, state, operations);
        if (reviewed === "aborted") return finish("aborted");
        if (reviewed === "failed") return finish("failed");
        continue;
      }

      if (
        state.validation.status === "passed" &&
        state.review?.status === "passed"
      ) {
        cycleStore.update(state.cycles, "passed", state);
        return finish("passed");
      }

      state.remainingFindings = currentFindings(state.validation, state.review);
      if (state.remainingFindings.length === 0) {
        return finish("failed");
      }
      if (
        state.cycles >= limits.maxRepairCycles ||
        state.executorAttempts >= limits.maxExecutorAttemptsPerTask ||
        state.validationAttempts >= limits.maxValidationAttempts
      ) {
        this.emitLimit(input.originalTask.id, state.cycles);
        cycleStore.update(state.cycles, "limit_reached", state);
        return finish("limit_reached");
      }

      state.cycles += 1;
      this.events.emit("repair.cycle_started", {
        taskId: input.originalTask.id,
        cycle: state.cycles,
      });
      cycleStore.begin({
        taskId: input.originalTask.id,
        cycle: state.cycles,
        executorAttempts: state.executorAttempts,
        validationAttempts: state.validationAttempts,
        reviewAttempts: state.reviewAttempts,
      });

      let evidence = this.buildEvidence(input, state, limits);
      const repairTask = this.taskBuilder.build({
        originalTask: input.originalTask,
        execution: state.execution,
        validation: state.validation,
        ...(state.review ? { review: state.review } : {}),
        evidence,
        cycle: state.cycles,
      });
      this.events.emit("repair.task_created", {
        taskId: input.originalTask.id,
        repairTaskId: repairTask.id,
        cycle: state.cycles,
        reason: repairTask.reason,
        findingCount: repairTask.findings.length,
      });

      const repeatKeys = repairTask.findings.map(findingKey);
      if (isStuck(failureCounts, repeatKeys, limits.stuckThreshold)) {
        history.push(
          historyEntry(state.cycles, "stalled", repeatKeys, state.execution),
        );
        this.events.emit("repair.stalled", {
          taskId: input.originalTask.id,
          cycle: state.cycles,
          reason: "repeated_failure",
        });
        cycleStore.update(state.cycles, "failed", state);
        return finish("stalled");
      }

      await this.expandContextIfNeeded(input, state, repairTask, limits, operations);
      // Targeted expansion updates the reused context; rebuild the bounded
      // evidence envelope so the repair Executor can actually consume it.
      evidence = this.buildEvidence(input, state, limits);

      const previousDiff = state.execution.git.diff.diff;
      state.executorAttempts += 1;
      cycleStore.update(state.cycles, "repairing", state);
      this.events.emit("repair.execution_started", {
        taskId: input.originalTask.id,
        repairTaskId: repairTask.id,
        cycle: state.cycles,
        attempt: state.executorAttempts,
      });

      let repaired: ExecutionResult;
      try {
        repaired = await this.executor.executeRepair({
          input: {
            originalTask: input.originalTask,
            repairTask,
            workspaceRoot: input.workspaceRoot,
            context: state.context,
            evidence,
            attempt: state.executorAttempts,
            ...(input.signal ? { signal: input.signal } : {}),
          },
          model,
          ...(input.executorLimits ? { limits: input.executorLimits } : {}),
        });
      } catch (error: unknown) {
        if (isAbort(error, input.signal)) {
          cycleStore.update(state.cycles, "failed", state);
          return finish("aborted");
        }
        history.push(
          historyEntry(state.cycles, "execution_failed", repeatKeys, state.execution),
        );
        this.events.emit("repair.failed", {
          taskId: input.originalTask.id,
          cycle: state.cycles,
          reason: errorCode(error),
        });
        cycleStore.update(state.cycles, "failed", state);
        state.remainingFindings = repairTask.findings;
        return finish("failed");
      }

      state.execution = repaired;
      this.events.emit("repair.execution_completed", {
        taskId: input.originalTask.id,
        repairTaskId: repairTask.id,
        cycle: state.cycles,
        changedFileCount: repaired.changedFiles.length,
      });

      if (repaired.status === "failed") {
        history.push(
          historyEntry(state.cycles, "execution_failed", repeatKeys, repaired),
        );
        this.events.emit("repair.failed", {
          taskId: input.originalTask.id,
          cycle: state.cycles,
          reason: "executor_reported_failure",
        });
        cycleStore.update(state.cycles, "failed", state);
        state.remainingFindings = repairTask.findings;
        return finish("failed");
      }

      // Git is the only trusted change evidence; model prose is not evidence.
      if (
        repaired.changedFiles.length === 0 ||
        repaired.git.diff.diff === previousDiff ||
        (repairTask.relevantFiles.length > 0 &&
          !repaired.changedFiles.some((path) =>
            repairTask.relevantFiles.includes(path),
          ))
      ) {
        history.push(historyEntry(state.cycles, "stalled", repeatKeys, repaired));
        this.events.emit("repair.stalled", {
          taskId: input.originalTask.id,
          cycle: state.cycles,
          reason: "no_change",
        });
        cycleStore.update(state.cycles, "failed", state);
        state.remainingFindings = repairTask.findings;
        return finish("stalled");
      }

      if (input.signal?.aborted) {
        cycleStore.update(state.cycles, "failed", state);
        return finish("aborted");
      }
      if (state.validationAttempts >= limits.maxValidationAttempts) {
        this.emitLimit(input.originalTask.id, state.cycles);
        cycleStore.update(state.cycles, "limit_reached", state);
        return finish("limit_reached");
      }

      state.validationAttempts += 1;
      cycleStore.update(state.cycles, "validating", state);
      this.events.emit("repair.validation_started", {
        taskId: input.originalTask.id,
        cycle: state.cycles,
        attempt: state.validationAttempts,
      });
      try {
        state.validation = await operations.validate({
          workspaceRoot: input.workspaceRoot,
          taskId: input.originalTask.id,
          ...(input.validationConfig ? { config: input.validationConfig } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error: unknown) {
        if (isAbort(error, input.signal)) return finish("aborted");
        this.events.emit("repair.failed", {
          taskId: input.originalTask.id,
          cycle: state.cycles,
          reason: errorCode(error),
        });
        cycleStore.update(state.cycles, "failed", state);
        return finish("failed");
      }

      if (state.validation.status === "failed") {
        // Validation-first retry: never spend Reviewer tokens on code that
        // already fails deterministic checks.
        state.review = undefined;
        state.remainingFindings = currentFindings(state.validation, undefined);
        this.events.emit("repair.validation_failed", {
          taskId: input.originalTask.id,
          cycle: state.cycles,
          findingCount: state.remainingFindings.length,
        });
        history.push(
          historyEntry(
            state.cycles,
            "validation_failed",
            state.remainingFindings.map(findingKey),
            state.execution,
          ),
        );
        cycleStore.update(state.cycles, "failed", state);
        continue;
      }

      this.events.emit("repair.validation_passed", {
        taskId: input.originalTask.id,
        cycle: state.cycles,
      });

      if (state.reviewAttempts >= limits.maxReviewAttempts) {
        this.emitLimit(input.originalTask.id, state.cycles);
        cycleStore.update(state.cycles, "limit_reached", state);
        return finish("limit_reached");
      }
      cycleStore.update(state.cycles, "reviewing", state);
      const reviewed = await this.review(input, state, operations);
      if (reviewed === "aborted") return finish("aborted");
      if (reviewed === "failed") {
        cycleStore.update(state.cycles, "failed", state);
        return finish("failed");
      }
      if (state.review?.status === "passed") {
        history.push(historyEntry(state.cycles, "passed", [], state.execution));
        cycleStore.update(state.cycles, "passed", state);
        continue;
      }
      state.remainingFindings = currentFindings(state.validation, state.review);
      history.push(
        historyEntry(
          state.cycles,
          "review_failed",
          state.remainingFindings.map(findingKey),
          state.execution,
        ),
      );
      cycleStore.update(state.cycles, "failed", state);
    }
  }

  private async review(
    input: RepairWorkflowInput,
    state: LoopState,
    operations: RepairOperations,
  ): Promise<"reviewed" | "failed" | "aborted"> {
    state.reviewAttempts += 1;
    this.events.emit("repair.review_started", {
      taskId: input.originalTask.id,
      cycle: state.cycles,
      attempt: state.reviewAttempts,
    });
    try {
      state.review = await operations.review({
        requirement: input.requirement,
        objective: input.objective,
        task: input.originalTask,
        execution: state.execution,
        validation: state.validation,
        executorContext: state.context,
        ...(input.plannerContext ? { plannerContext: input.plannerContext } : {}),
        ...(input.reviewEvidenceBudget
          ? { evidenceBudget: input.reviewEvidenceBudget }
          : {}),
        ...(input.reviewerLimits ? { limits: input.reviewerLimits } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error: unknown) {
      if (isAbort(error, input.signal)) return "aborted";
      this.events.emit("repair.failed", {
        taskId: input.originalTask.id,
        cycle: state.cycles,
        reason: errorCode(error),
      });
      return "failed";
    }
    if (state.review.status === "passed") {
      this.events.emit("repair.review_passed", {
        taskId: input.originalTask.id,
        cycle: state.cycles,
      });
    } else {
      this.events.emit("repair.review_failed", {
        taskId: input.originalTask.id,
        cycle: state.cycles,
        findingCount: state.review.findings.length,
      });
    }
    return "reviewed";
  }

  private buildEvidence(
    input: RepairWorkflowInput,
    state: LoopState,
    limits: RepairLimits,
  ): RepairEvidence {
    return this.evidenceBuilder.build({
      taskId: input.originalTask.id,
      execution: state.execution,
      validation: state.validation,
      ...(state.review ? { review: state.review } : {}),
      contexts: [
        state.context,
        ...(input.plannerContext ? [input.plannerContext] : []),
      ],
      limits,
    });
  }

  private async expandContextIfNeeded(
    input: RepairWorkflowInput,
    state: LoopState,
    repairTask: RepairTask,
    limits: RepairLimits,
    operations: RepairOperations,
  ): Promise<void> {
    if (!operations.expandContext) return;
    if (state.contextExpansions >= limits.maxContextExpansions) return;
    const missing = repairTask.relevantFiles.filter(
      (path) => !state.context.files.some((file) => file.path === path),
    );
    if (missing.length === 0) return;

    try {
      const files = await operations.expandContext({
        workspaceRoot: input.workspaceRoot,
        paths: missing.slice(0, 4),
        symbols: [],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (files.length === 0) return;
      state.context = mergeContext(state.context, files);
      state.contextExpansions += 1;
    } catch {
      // Targeted expansion is best-effort; the repair continues with the
      // evidence already available.
    }
  }

  private emitLimit(taskId: string, cycle: number): void {
    this.events.emit("repair.limit_reached", { taskId, cycle });
  }

  private finish(
    status: RepairResultStatus,
    input: RepairWorkflowInput,
    state: LoopState,
    history: readonly RepairCycleHistory[],
    limits: RepairLimits,
  ): RepairResult {
    const remaining = status === "passed" ? [] : state.remainingFindings;
    this.events.emit(
      status === "passed" ? "repair.completed" : "repair.failed",
      {
        taskId: input.originalTask.id,
        status,
        cycle: state.cycles,
        findingCount: remaining.length,
      },
    );
    return Object.freeze({
      taskId: input.originalTask.id,
      status,
      cycles: state.cycles,
      executorAttempts: state.executorAttempts,
      validationAttempts: state.validationAttempts,
      reviewAttempts: state.reviewAttempts,
      finalExecution: state.execution,
      finalValidation: state.validation,
      ...(state.review ? { finalReview: state.review } : {}),
      ...(remaining.length > 0 ? { remainingFindings: remaining } : {}),
      changedFiles: [...state.execution.changedFiles],
      history: history.slice(-limits.maxHistoryEntries),
      completedAt: this.now(),
    });
  }
}

export function resolveRepairLimits(
  input?: Partial<RepairLimits>,
): RepairLimits {
  const limits = { ...DEFAULT_REPAIR_LIMITS, ...input };
  const positive = [
    limits.maxRepairCycles,
    limits.maxExecutorAttemptsPerTask,
    limits.maxValidationAttempts,
    limits.maxReviewAttempts,
    limits.maxEvidenceBytes,
    limits.maxDiffBytes,
    limits.maxHistoryEntries,
    limits.stuckThreshold,
  ];
  if (
    positive.some((value) => !Number.isInteger(value) || value <= 0) ||
    !Number.isInteger(limits.maxContextExpansions) ||
    limits.maxContextExpansions < 0 ||
    limits.maxRepairCycles > 5 ||
    limits.maxExecutorAttemptsPerTask > 5
  ) {
    throw new RepairError("repair_limits_invalid", "Repair limits are invalid");
  }
  return limits;
}

function currentFindings(
  validation: ValidationResult,
  review: ReviewResult | undefined,
): readonly RepairFinding[] {
  return deduplicateFindings([
    ...validationFindings(validation),
    ...reviewFindings(review),
  ]);
}

function isStuck(
  counts: Map<string, number>,
  keys: readonly string[],
  threshold: number,
): boolean {
  let stuck = false;
  for (const key of keys) {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > threshold) stuck = true;
  }
  return stuck;
}

function historyEntry(
  cycle: number,
  outcome: RepairCycleHistory["outcome"],
  findingKeys: readonly string[],
  execution: ExecutionResult,
): RepairCycleHistory {
  return {
    cycle,
    outcome,
    findingKeys: [...findingKeys].slice(0, 8),
    changedFiles: [...execution.changedFiles].slice(0, 16),
  };
}

function mergeContext(
  base: ContextBundle,
  files: readonly ContextFile[],
): ContextBundle {
  const merged = [...base.files];
  const seen = new Set(merged.map((file) => file.path));
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }
  return {
    ...base,
    files: merged,
    totalBytes: merged.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      Buffer.byteLength(base.git.diff.diff, "utf8"),
    ),
  };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "repair_error";
}
