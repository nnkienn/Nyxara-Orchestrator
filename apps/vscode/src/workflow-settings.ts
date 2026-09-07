import {
  DEFAULT_ALLOW_REPAIR,
  DEFAULT_REVIEWER_LIMITS,
  DEFAULT_TIMEOUTS,
  DEFAULT_VALIDATION_ENABLED,
  VALIDATION_KINDS,
  normalizeValidationConfig,
  resolveRepairLimits,
  resolveReviewerLimits,
  type RepairLimits,
  type ValidationKind,
} from "@nyxara/core";

export const WORKFLOW_SETTING = "nyxara.workflow";

type RepairSettings = Pick<RepairLimits, "maxRepairCycles" | "maxExecutorAttemptsPerTask" | "maxValidationAttempts" | "maxReviewAttempts">;
type ValidationSettings = { readonly failFast: boolean } & Record<ValidationKind, { readonly enabled: boolean; readonly timeoutMs: number }>;

export interface WorkflowSettings {
  readonly allowRepair: boolean;
  readonly repairLimits: RepairSettings;
  readonly validation: ValidationSettings;
  readonly reviewerLimits: { readonly maxReviewerTurns: number };
}

export interface WorkflowSettingsPatch {
  readonly allowRepair?: boolean;
  readonly repairLimits?: Partial<RepairSettings>;
  readonly validation?: { readonly failFast?: boolean } & Partial<Record<ValidationKind, { readonly enabled?: boolean; readonly timeoutMs?: number }>>;
  readonly reviewerLimits?: { readonly maxReviewerTurns?: number };
}

export interface WorkflowControl {
  readonly path: readonly string[];
  readonly group: "Repair" | "Validation" | "Review";
  readonly label: string;
  readonly type: "boolean" | "integer";
  readonly value: boolean | number;
  readonly minimum?: number;
  readonly maximum?: number;
}

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid Workflow settings. Check nyxara.workflow.");
}

function boolean(value: unknown): void {
  if (typeof value !== "boolean") throw new Error("Workflow settings require a boolean.");
}

function integer(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new Error("Workflow limits require a finite integer.");
}

export function validateWorkflowSettingsPatch(value: unknown): WorkflowSettingsPatch {
  object(value, ["allowRepair", "repairLimits", "validation", "reviewerLimits"]);
  if ("allowRepair" in value) boolean(value.allowRepair);
  if ("repairLimits" in value) {
    object(value.repairLimits, ["maxRepairCycles", "maxExecutorAttemptsPerTask", "maxValidationAttempts", "maxReviewAttempts"]);
    Object.values(value.repairLimits).forEach(integer);
    resolveRepairLimits(value.repairLimits);
  }
  if ("validation" in value) {
    object(value.validation, ["failFast", ...VALIDATION_KINDS]);
    if ("failFast" in value.validation) boolean(value.validation.failFast);
    for (const kind of VALIDATION_KINDS) {
      if (!(kind in value.validation)) continue;
      const step = value.validation[kind];
      object(step, ["enabled", "timeoutMs"]);
      if ("enabled" in step) boolean(step.enabled);
      if ("timeoutMs" in step) integer(step.timeoutMs);
    }
    normalizeValidationConfig(value.validation);
  }
  if ("reviewerLimits" in value) {
    object(value.reviewerLimits, ["maxReviewerTurns"]);
    Object.values(value.reviewerLimits).forEach(integer);
    resolveReviewerLimits({ ...value.reviewerLimits, maxContextExpansions: 0 });
  }
  const patch = value as WorkflowSettingsPatch;
  const validation = patch.validation;
  return {
    ...patch,
    ...(patch.repairLimits ? { repairLimits: { ...patch.repairLimits } } : {}),
    ...(validation ? { validation: {
      ...validation,
      ...Object.fromEntries(VALIDATION_KINDS.flatMap((kind) => {
        const step = validation[kind];
        return step ? [[kind, { ...step }]] : [];
      })),
    } } : {}),
    ...(patch.reviewerLimits ? { reviewerLimits: { ...patch.reviewerLimits } } : {}),
  };
}

export function resolveWorkflowSettings(input: unknown = {}): WorkflowSettings {
  const patch = validateWorkflowSettingsPatch(input);
  const repair = resolveRepairLimits(patch.repairLimits);
  const validation = normalizeValidationConfig(patch.validation);
  return {
    allowRepair: patch.allowRepair ?? DEFAULT_ALLOW_REPAIR,
    repairLimits: { maxRepairCycles: repair.maxRepairCycles, maxExecutorAttemptsPerTask: repair.maxExecutorAttemptsPerTask, maxValidationAttempts: repair.maxValidationAttempts, maxReviewAttempts: repair.maxReviewAttempts },
    validation: {
      failFast: validation.failFast,
      ...Object.fromEntries(VALIDATION_KINDS.map((kind) => [kind, { enabled: validation.config[kind]?.enabled ?? DEFAULT_VALIDATION_ENABLED, timeoutMs: validation.config[kind]?.timeoutMs ?? DEFAULT_TIMEOUTS[kind] }])) as Record<ValidationKind, ValidationSettings[ValidationKind]>,
    },
    reviewerLimits: { maxReviewerTurns: patch.reviewerLimits?.maxReviewerTurns ?? DEFAULT_REVIEWER_LIMITS.maxReviewerTurns },
  };
}

export function mergeWorkflowSettings(current: WorkflowSettings, patch: WorkflowSettingsPatch): WorkflowSettings {
  return resolveWorkflowSettings({
    ...current, ...patch,
    repairLimits: { ...current.repairLimits, ...patch.repairLimits },
    reviewerLimits: { ...current.reviewerLimits, ...patch.reviewerLimits },
    validation: { ...current.validation, ...patch.validation, ...Object.fromEntries(VALIDATION_KINDS.map((kind) => [kind, { ...current.validation[kind], ...patch.validation?.[kind] }])) },
  });
}

export function workflowControls(settings: WorkflowSettings): readonly WorkflowControl[] {
  return [
    { path: ["allowRepair"], group: "Repair", label: "Automatic Repair", type: "boolean", value: settings.allowRepair },
    ...([ ["maxRepairCycles", "Maximum Repair Cycles", 5], ["maxExecutorAttemptsPerTask", "Maximum Executor Attempts", 5], ["maxValidationAttempts", "Maximum Validation Attempts", undefined], ["maxReviewAttempts", "Maximum Review Attempts", undefined] ] as const).map(([key, label, maximum]) => ({ path: ["repairLimits", key], group: "Repair" as const, label, type: "integer" as const, value: settings.repairLimits[key], minimum: 1, ...(maximum === undefined ? {} : { maximum }) })),
    { path: ["validation", "failFast"], group: "Validation", label: "Stop Validation on First Failure", type: "boolean", value: settings.validation.failFast },
    ...VALIDATION_KINDS.flatMap((kind): WorkflowControl[] => [
      { path: ["validation", kind, "enabled"], group: "Validation", label: `${kind === "test" ? "Tests" : kind[0]!.toUpperCase() + kind.slice(1)} Validation`, type: "boolean", value: settings.validation[kind].enabled },
      { path: ["validation", kind, "timeoutMs"], group: "Validation", label: `${kind[0]!.toUpperCase() + kind.slice(1)} Timeout (ms)`, type: "integer", value: settings.validation[kind].timeoutMs, minimum: 1, maximum: 30 * 60_000 },
    ]),
    { path: ["reviewerLimits", "maxReviewerTurns"], group: "Review", label: "Maximum Reviewer Turns", type: "integer", value: settings.reviewerLimits.maxReviewerTurns, minimum: 1, maximum: 4 },
  ];
}
