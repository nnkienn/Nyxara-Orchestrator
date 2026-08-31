import type { ValidationResult } from "./validation.types.js";

export const DEFAULT_VALIDATION_STORE_LIMITS = {
  maxHistoryPerTask: 4,
  maxTrackedTasks: 50,
} as const;

export interface ValidationStoreLimits {
  readonly maxHistoryPerTask: number;
  readonly maxTrackedTasks: number;
}

export interface ValidationSelector {
  readonly taskId: string;
  readonly planId?: string;
}

/**
 * Task-aware validation results with bounded history. Repair can validate the
 * same task several times, so the store keeps a small window per task and
 * compacts superseded entries: only the newest entry retains command output.
 */
export class ValidationStore {
  private readonly history = new Map<string, ValidationResult[]>();
  private readonly limits: ValidationStoreLimits;
  private latest: ValidationResult | undefined;

  constructor(limits: Partial<ValidationStoreLimits> = {}) {
    this.limits = { ...DEFAULT_VALIDATION_STORE_LIMITS, ...limits };
    if (
      !Number.isInteger(this.limits.maxHistoryPerTask) ||
      this.limits.maxHistoryPerTask <= 0 ||
      !Number.isInteger(this.limits.maxTrackedTasks) ||
      this.limits.maxTrackedTasks <= 0
    ) {
      throw new Error("Validation store limits must be positive integers");
    }
  }

  set(result: ValidationResult): void {
    this.latest = result;
    if (!result.taskId) return;

    const key = historyKey(result.planId, result.taskId);
    const entries = (this.history.get(key) ?? []).map(compactResult);
    entries.push(result);
    while (entries.length > this.limits.maxHistoryPerTask) entries.shift();
    this.history.delete(key);
    this.history.set(key, entries);

    while (this.history.size > this.limits.maxTrackedTasks) {
      const oldest = this.history.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      this.history.delete(oldest);
    }
  }

  getLatest(selector?: ValidationSelector): ValidationResult | undefined {
    if (!selector) return this.latest;
    const entries = this.entriesFor(selector);
    return entries[entries.length - 1];
  }

  getHistory(selector: ValidationSelector): readonly ValidationResult[] {
    return [...this.entriesFor(selector)];
  }

  private entriesFor(selector: ValidationSelector): readonly ValidationResult[] {
    const exact = this.history.get(historyKey(selector.planId, selector.taskId));
    if (exact) return exact;
    if (selector.planId !== undefined) return [];

    // Plan-agnostic lookup: the most recently updated entry for the task wins.
    const suffix = "::" + selector.taskId;
    let match: readonly ValidationResult[] = [];
    for (const [key, entries] of this.history) {
      if (key.endsWith(suffix)) match = entries;
    }
    return match;
  }
}

function historyKey(planId: string | undefined, taskId: string): string {
  return (planId ?? "-") + "::" + taskId;
}

function compactResult(result: ValidationResult): ValidationResult {
  return {
    ...result,
    steps: result.steps.map(({ stdout, stderr, ...step }) => step),
  };
}
