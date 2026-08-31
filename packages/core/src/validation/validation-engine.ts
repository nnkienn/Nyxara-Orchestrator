import {
  NyxaraToolError,
  ToolRegistryError,
  type CommandResult,
  type GitDiffResult,
  type GitStatusResult,
  type RunCommandInput,
  type ToolContext,
  type ToolRegistry,
} from "@nyxara/tools";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { VALIDATION_DIFF_MAX_BYTES } from "../internal/byte-limits.js";
import { diffSectionMap } from "../internal/diff-sections.js";
import { errorCodeOr } from "../internal/error-code.js";
import { ValidationCommandDiscovery } from "./validation-command-discovery.js";
import { normalizeValidationConfig } from "./validation-config.js";
import { ValidationError } from "./validation.errors.js";
import type {
  ResolvedValidationStep,
  ValidateInput,
  ValidationResult,
  ValidationStepResult,
} from "./validation.types.js";

interface GitSnapshot {
  readonly status: GitStatusResult;
  readonly diff: GitDiffResult;
}

export class ValidationEngine {
  private readonly discovery: ValidationCommandDiscovery;

  constructor(
    private readonly tools: ToolRegistry,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.discovery = new ValidationCommandDiscovery(tools);
  }

  async run(input: ValidateInput): Promise<ValidationResult> {
    const started = this.now();
    this.events.emit("validation.started", {
      workspaceRoot: input.workspaceRoot,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });

    try {
      const normalized = normalizeValidationConfig(input.config);
      const discovery = await this.discovery.discover(
        input.workspaceRoot,
        normalized,
        input.signal,
      );
      const context: ToolContext = {
        workspaceRoot: input.workspaceRoot,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const attemptedSteps = discovery.steps.filter(
        (step) => step.enabled && step.command,
      );
      if (attemptedSteps.length === 0) {
        const errorCode = discovery.packageManagerMissing
          ? "package_manager_not_found"
          : "no_validation_commands";
        const steps = discovery.steps.map((step) =>
          this.skippedStep(
            step,
            step.required ? "validation_command_not_found" : undefined,
          ),
        );
        for (const step of steps) {
          this.events.emit("validation.step_skipped", stepEvent(step));
        }
        const result = this.result(
          "failed",
          steps,
          discovery.packageManager,
          started,
          input,
          errorCode,
        );
        this.emitFailed(result, errorCode);
        return result;
      }

      await this.requireGitEvidence(context);
      const results: ValidationStepResult[] = [];
      let shouldStop = false;
      for (const step of discovery.steps) {
        if (!step.enabled || !step.command) {
          const skipped = this.skippedStep(
            step,
            step.required ? "validation_command_not_found" : undefined,
          );
          results.push(skipped);
          this.events.emit("validation.step_skipped", stepEvent(skipped));
          if (stepInvalidates(skipped) && normalized.failFast) shouldStop = true;
          continue;
        }
        if (shouldStop) {
          const skipped = this.skippedStep(step, "fail_fast");
          results.push(skipped);
          this.events.emit("validation.step_skipped", stepEvent(skipped));
          continue;
        }

        const result = await this.runStep(step, context);
        results.push(result);
        if (stepInvalidates(result) && normalized.failFast) shouldStop = true;
      }

      const status = results.some(stepInvalidates) ? "failed" : "passed";
      const errorCode = status === "failed" ? firstFailureCode(results) : undefined;
      const result = this.result(
        status,
        results,
        discovery.packageManager,
        started,
        input,
        errorCode,
      );
      if (status === "passed") {
        this.events.emit("validation.completed", {
          durationMs: result.durationMs,
          stepCount: results.length,
        });
      } else {
        this.emitFailed(result, errorCode!);
      }
      return result;
    } catch (error: unknown) {
      this.events.emit("validation.failed", {
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        errorCode: validationErrorCode(error),
        failedKinds: [],
      });
      throw error;
    }
  }

  private async runStep(
    step: ResolvedValidationStep,
    context: ToolContext,
  ): Promise<ValidationStepResult> {
    const command = step.command!;
    this.events.emit("validation.step_started", {
      kind: step.kind,
      command: [...command],
    });
    const startedAt = Date.now();
    const before = await this.snapshot(context);
    let result: ValidationStepResult;
    try {
      const processResult = await this.tools.execute<
        RunCommandInput,
        CommandResult
      >(
        "run_command",
        {
          command: command[0],
          args: command.slice(1),
          timeoutMs: step.timeoutMs,
          maxOutputBytes: step.maxOutputBytes,
        },
        context,
      );
      result = {
        kind: step.kind,
        status: processResult.exitCode === 0 ? "passed" : "failed",
        required: step.required,
        source: step.source,
        command: [...command],
        ...(processResult.exitCode !== null
          ? { exitCode: processResult.exitCode }
          : {}),
        durationMs: processResult.durationMs,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        truncated: processResult.truncated,
      };
    } catch (error: unknown) {
      result = normalizeProcessError(
        step,
        Date.now() - startedAt,
        error,
      );
    }

    const after = await this.snapshot(context);
    if (!after.status.isRepository || !after.diff.isRepository) {
      result = {
        ...result,
        status: "errored",
        errorCode: "validation_workspace_changed",
      };
    }
    const changedTrackedFiles = detectTrackedChanges(before, after);
    if (changedTrackedFiles.length > 0) {
      result = {
        ...result,
        status: "errored",
        errorCode: "validation_workspace_changed",
        changedTrackedFiles,
      };
    }
    this.emitStepResult(result);
    return result;
  }

  private async requireGitEvidence(context: ToolContext): Promise<void> {
    const snapshot = await this.snapshot(context);
    if (!snapshot.status.isRepository || !snapshot.diff.isRepository) {
      throw new ValidationError(
        "validation_error",
        "Validation requires a Git repository for workspace safety",
      );
    }
  }

  private async snapshot(context: ToolContext): Promise<GitSnapshot> {
    const [status, diff] = await Promise.all([
      this.tools.execute<Record<string, never>, GitStatusResult>(
        "git_status",
        {},
        context,
      ),
      this.tools.execute<{ maxBytes: number }, GitDiffResult>(
        "git_diff",
        { maxBytes: VALIDATION_DIFF_MAX_BYTES },
        context,
      ),
    ]);
    return { status, diff };
  }

  private skippedStep(
    step: ResolvedValidationStep,
    errorCode?: string,
  ): ValidationStepResult {
    return {
      kind: step.kind,
      status: "skipped",
      required: step.required,
      source: step.source,
      ...(step.command ? { command: [...step.command] } : {}),
      durationMs: 0,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private result(
    status: "passed" | "failed",
    steps: readonly ValidationStepResult[],
    packageManager: ValidationResult["packageManager"],
    started: Date,
    input: ValidateInput,
    errorCode?: string,
  ): ValidationResult {
    const completed = this.now();
    return {
      status,
      steps,
      packageManager,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      ...(errorCode ? { errorCode } : {}),
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
  }

  private emitStepResult(result: ValidationStepResult): void {
    const event = stepEvent(result);
    if (result.status === "passed") {
      this.events.emit("validation.step_passed", event);
    } else if (result.status === "timed_out") {
      this.events.emit("validation.step_timed_out", event);
    } else {
      this.events.emit("validation.step_failed", event);
    }
  }

  private emitFailed(result: ValidationResult, errorCode: string): void {
    this.events.emit("validation.failed", {
      durationMs: result.durationMs,
      errorCode,
      failedKinds: result.steps
        .filter(stepInvalidates)
        .map((step) => step.kind),
    });
  }
}

function normalizeProcessError(
  step: ResolvedValidationStep,
  durationMs: number,
  error: unknown,
): ValidationStepResult {
  let status: ValidationStepResult["status"] = "errored";
  let errorCode = "validation_process_error";
  if (error instanceof NyxaraToolError) {
    if (error.code === "command_timeout") {
      status = "timed_out";
      errorCode = "validation_timeout";
    } else if (
      ["command_blocked", "permission_required", "permission_error"].includes(
        error.code,
      )
    ) {
      errorCode = "validation_command_blocked";
    }
  } else if (error instanceof ToolRegistryError) {
    errorCode = "validation_process_error";
  }
  return {
    kind: step.kind,
    status,
    required: step.required,
    source: step.source,
    ...(step.command ? { command: [...step.command] } : {}),
    durationMs,
    errorCode,
  };
}

function stepInvalidates(step: ValidationStepResult): boolean {
  if (step.status === "skipped" && step.errorCode === "fail_fast") return false;
  if (step.status === "errored" || step.status === "timed_out") return true;
  if (!step.required) return false;
  return step.status !== "passed";
}

function firstFailureCode(steps: readonly ValidationStepResult[]): string {
  return (
    steps.find(stepInvalidates)?.errorCode ??
    "validation_error"
  );
}

function stepEvent(result: ValidationStepResult): {
  kind: ValidationStepResult["kind"];
  status: ValidationStepResult["status"];
  durationMs: number;
  command?: readonly string[];
  exitCode?: number;
  errorCode?: string;
} {
  return {
    kind: result.kind,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.command ? { command: result.command } : {}),
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}

function validationErrorCode(error: unknown): string {
  return errorCodeOr(error, "validation_error");
}

export function detectTrackedChanges(
  before: GitSnapshot,
  after: GitSnapshot,
): string[] {
  const beforeStates = trackedStatusMap(before.status);
  const afterStates = trackedStatusMap(after.status);
  const beforeDiffs = diffSectionMap(before.diff.diff);
  const afterDiffs = diffSectionMap(after.diff.diff);
  const paths = new Set([
    ...beforeStates.keys(),
    ...afterStates.keys(),
    ...beforeDiffs.keys(),
    ...afterDiffs.keys(),
  ]);
  return [...paths]
    .filter(
      (path) =>
        beforeStates.get(path) !== afterStates.get(path) ||
        beforeDiffs.get(path) !== afterDiffs.get(path),
    )
    .sort();
}

function trackedStatusMap(status: GitStatusResult): ReadonlyMap<string, string> {
  return new Map(
    status.files
      .filter((file) => file.status !== "untracked")
      .map((file) => [
        file.path,
        `${file.status}:${file.indexStatus}:${file.worktreeStatus}`,
      ]),
  );
}
