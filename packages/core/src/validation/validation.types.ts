export const VALIDATION_KINDS = [
  "typecheck",
  "lint",
  "test",
  "build",
] as const;

export type ValidationKind = (typeof VALIDATION_KINDS)[number];
export type PackageManager = "pnpm" | "npm" | "yarn";

export type ValidationStepStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "timed_out"
  | "errored";

export interface ValidationStepConfig {
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ValidationConfig {
  readonly typecheck?: ValidationStepConfig;
  readonly lint?: ValidationStepConfig;
  readonly test?: ValidationStepConfig;
  readonly build?: ValidationStepConfig;
  readonly failFast?: boolean;
  readonly order?: readonly ValidationKind[];
}

export interface ResolvedValidationStep {
  readonly kind: ValidationKind;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly source: "discovered" | "explicit" | "missing";
  readonly command?: readonly [string, ...string[]];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ValidationDiscoveryResult {
  readonly packageManager: PackageManager | null;
  readonly packageManagerMissing: boolean;
  readonly steps: readonly ResolvedValidationStep[];
}

export interface ValidationStepResult {
  readonly kind: ValidationKind;
  readonly status: ValidationStepStatus;
  readonly required: boolean;
  readonly source: ResolvedValidationStep["source"];
  readonly command?: readonly string[];
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly errorCode?: string;
  readonly changedTrackedFiles?: readonly string[];
}

export interface ValidationResult {
  readonly status: "passed" | "failed";
  readonly steps: readonly ValidationStepResult[];
  readonly packageManager: PackageManager | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly planId?: string;
  readonly taskId?: string;
}

export interface ValidateInput {
  readonly workspaceRoot: string;
  readonly config?: ValidationConfig;
  readonly planId?: string;
  readonly taskId?: string;
  readonly signal?: AbortSignal;
}
