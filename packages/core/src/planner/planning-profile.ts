import { z } from "zod";

export const PLANNING_PROFILE_LIMITS = Object.freeze({
  maxProfiles: 64,
  maxInstructions: 8,
  maxInstructionCharacters: 240,
  maxTotalInstructionCharacters: 1_200,
  maxCompiledCharacters: 2_400,
});

const PlanningProfileIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Profile ID must use lowercase letters, numbers, dots, underscores, or hyphens");
const LocaleSchema = z.string().trim().min(2).max(35)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, "Locale must be a locale-style identifier such as en-US");
const CustomInstructionSchema = z.string().trim().min(1)
  .max(PLANNING_PROFILE_LIMITS.maxInstructionCharacters);

export const PlanningProfileSchema = z.object({
  id: PlanningProfileIdSchema,
  name: z.string().trim().min(1).max(100),
  locale: LocaleSchema.optional(),
  outputLanguage: z.string().trim().min(1).max(64),
  planStyle: z.enum(["concise", "balanced", "detailed"]),
  riskMode: z.enum(["fast", "balanced", "conservative"]),
  requireAcceptanceCriteria: z.boolean(),
  requireDependencies: z.boolean(),
  requireRiskAnalysis: z.boolean(),
  customInstructions: z.array(CustomInstructionSchema)
    .max(PLANNING_PROFILE_LIMITS.maxInstructions)
    .readonly()
    .optional(),
}).strict().superRefine((profile, context) => {
  const total = profile.customInstructions?.reduce((sum, item) => sum + item.length, 0) ?? 0;
  if (total > PLANNING_PROFILE_LIMITS.maxTotalInstructionCharacters) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customInstructions"],
      message: `Custom instructions may contain at most ${PLANNING_PROFILE_LIMITS.maxTotalInstructionCharacters} characters in total`,
    });
  }
});

export type PlanStyle = "concise" | "balanced" | "detailed";
export type RiskMode = "fast" | "balanced" | "conservative";
export type PlanningProfile = Readonly<z.infer<typeof PlanningProfileSchema>>;

export interface PlanningProfileMetadata {
  readonly id: string;
  readonly locale?: string;
  readonly outputLanguage: string;
  readonly planStyle: PlanStyle;
  readonly riskMode: RiskMode;
}

export type PlanningProfileErrorCode =
  | "invalid_planning_profile"
  | "unknown_planning_profile"
  | "duplicate_planning_profile"
  | "planning_profile_limit_exceeded";

export class PlanningProfileError extends Error {
  constructor(readonly code: PlanningProfileErrorCode, message: string = code) {
    super(message);
    this.name = "PlanningProfileError";
  }
}

const profileDefinitions = [
  {
    id: "default", name: "Default", outputLanguage: "en", planStyle: "balanced", riskMode: "balanced",
    requireAcceptanceCriteria: true, requireDependencies: true, requireRiskAnalysis: true,
  },
  {
    id: "concise", name: "Concise", outputLanguage: "en", planStyle: "concise", riskMode: "balanced",
    requireAcceptanceCriteria: true, requireDependencies: true, requireRiskAnalysis: false,
  },
  {
    id: "detailed", name: "Detailed", outputLanguage: "en", planStyle: "detailed", riskMode: "balanced",
    requireAcceptanceCriteria: true, requireDependencies: true, requireRiskAnalysis: true,
  },
  {
    id: "conservative", name: "Risk-conscious", outputLanguage: "en", planStyle: "detailed", riskMode: "conservative",
    requireAcceptanceCriteria: true, requireDependencies: true, requireRiskAnalysis: true,
  },
] as const;

export const BUILT_IN_PLANNING_PROFILES: readonly PlanningProfile[] = Object.freeze(
  profileDefinitions.map((profile) => parsePlanningProfile(profile)),
);
export const DEFAULT_PLANNING_PROFILE = BUILT_IN_PLANNING_PROFILES[0]!;

export function parsePlanningProfile(profile: unknown): PlanningProfile {
  const result = PlanningProfileSchema.safeParse(profile);
  if (!result.success) {
    throw new PlanningProfileError("invalid_planning_profile", result.error.issues[0]?.message ?? "Invalid planning profile");
  }
  return freezeProfile(result.data);
}

export function planningProfileMetadata(profile: PlanningProfile): PlanningProfileMetadata {
  return Object.freeze({
    id: profile.id,
    ...(profile.locale ? { locale: profile.locale } : {}),
    outputLanguage: profile.outputLanguage,
    planStyle: profile.planStyle,
    riskMode: profile.riskMode,
  });
}

function freezeProfile(profile: z.infer<typeof PlanningProfileSchema>): PlanningProfile {
  return Object.freeze({
    ...profile,
    ...(profile.customInstructions
      ? { customInstructions: Object.freeze([...profile.customInstructions]) }
      : {}),
  });
}
