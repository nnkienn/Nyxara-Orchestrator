import type { RepairCycleState, RepairCycleStatus } from "./repair.types.js";

/**
 * Bounded, Core-owned repair cycle state. Only the most recent cycles are
 * retained so a long repair session cannot grow without limit.
 */
export class RepairCycleStore {
  private readonly cycles: RepairCycleState[] = [];

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  begin(input: {
    readonly taskId: string;
    readonly cycle: number;
    readonly executorAttempts: number;
    readonly validationAttempts: number;
    readonly reviewAttempts: number;
  }): RepairCycleState {
    const state: RepairCycleState = {
      taskId: input.taskId,
      cycle: input.cycle,
      status: "repairing",
      executorAttempts: input.executorAttempts,
      validationAttempts: input.validationAttempts,
      reviewAttempts: input.reviewAttempts,
      startedAt: this.now(),
    };
    this.cycles.push(state);
    while (this.cycles.length > this.maxEntries) this.cycles.shift();
    return state;
  }

  update(
    cycle: number,
    status: RepairCycleStatus,
    attempts?: {
      readonly executorAttempts?: number;
      readonly validationAttempts?: number;
      readonly reviewAttempts?: number;
    },
  ): RepairCycleState | undefined {
    const index = this.cycles.findIndex((state) => state.cycle === cycle);
    if (index < 0) return undefined;
    const current = this.cycles[index]!;
    const terminal = ["passed", "failed", "limit_reached"].includes(status);
    const next: RepairCycleState = {
      ...current,
      status,
      ...(attempts?.executorAttempts !== undefined
        ? { executorAttempts: attempts.executorAttempts }
        : {}),
      ...(attempts?.validationAttempts !== undefined
        ? { validationAttempts: attempts.validationAttempts }
        : {}),
      ...(attempts?.reviewAttempts !== undefined
        ? { reviewAttempts: attempts.reviewAttempts }
        : {}),
      ...(terminal ? { completedAt: this.now() } : {}),
    };
    this.cycles[index] = next;
    return next;
  }

  list(): readonly RepairCycleState[] {
    return [...this.cycles];
  }

  current(): RepairCycleState | undefined {
    return this.cycles.at(-1);
  }
}
