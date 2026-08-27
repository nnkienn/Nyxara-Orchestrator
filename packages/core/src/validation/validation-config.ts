import { z } from "zod";
import { ValidationError } from "./validation.errors.js";
import {
  VALIDATION_KINDS,
  type ValidationConfig,
  type ValidationKind,
} from "./validation.types.js";

const ValidationStepConfigSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  command: z.array(z.string().trim().min(1)).min(1).optional(),
  timeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
  maxOutputBytes: z.number().int().positive().max(1024 * 1024).optional(),
});

const ValidationConfigSchema = z.object({
  typecheck: ValidationStepConfigSchema.optional(),
  lint: ValidationStepConfigSchema.optional(),
  test: ValidationStepConfigSchema.optional(),
  build: ValidationStepConfigSchema.optional(),
  failFast: z.boolean().optional(),
  order: z.array(z.enum(VALIDATION_KINDS)).optional(),
});

export interface NormalizedValidationConfig {
  readonly config: ValidationConfig;
  readonly failFast: boolean;
  readonly order: readonly ValidationKind[];
}

export function normalizeValidationConfig(
  input: ValidationConfig | undefined,
): NormalizedValidationConfig {
  const parsed = ValidationConfigSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      "invalid_validation_config",
      "Validation configuration is invalid",
    );
  }

  const order = parsed.data.order ?? [...VALIDATION_KINDS];
  if (
    order.length !== VALIDATION_KINDS.length ||
    new Set(order).size !== VALIDATION_KINDS.length
  ) {
    throw new ValidationError(
      "invalid_validation_config",
      "Validation order must contain each validation kind exactly once",
    );
  }

  for (const kind of VALIDATION_KINDS) {
    const command = parsed.data[kind]?.command;
    if (command && hasExecutablePath(command[0]!)) {
      throw new ValidationError(
        "invalid_validation_config",
        "Validation executables must be resolved from PATH",
      );
    }
  }

  const config = Object.fromEntries(
    Object.entries(parsed.data).filter((entry) => entry[1] !== undefined),
  ) as ValidationConfig;
  return {
    config,
    failFast: parsed.data.failFast ?? true,
    order,
  };
}

function hasExecutablePath(executable: string): boolean {
  return executable.includes("/") || executable.includes("\\");
}
