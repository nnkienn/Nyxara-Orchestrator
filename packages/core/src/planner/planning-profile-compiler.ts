import {
  PLANNING_PROFILE_LIMITS,
  PlanningProfileError,
  parsePlanningProfile,
  type PlanningProfile,
} from "./planning-profile.js";

const STYLE_INSTRUCTIONS = {
  concise: "Use minimum useful explanation and compact tasks; avoid unnecessary decomposition.",
  balanced: "Use normal implementation-planning detail with adequate explanation and appropriately scoped tasks.",
  detailed: "Use explicit implementation steps, explicit dependency reasoning, and richer testable acceptance criteria.",
} as const;

const RISK_INSTRUCTIONS = {
  fast: "Prefer direct implementation and avoid unnecessary defensive tasks, while still obeying all security requirements.",
  balanced: "Use normal engineering tradeoffs between delivery speed, compatibility, validation, and risk.",
  conservative: "Identify migration, security, compatibility, and regression risks; prefer explicit validation and compatibility steps.",
} as const;

/** Compiles validated configuration only; it never dumps a raw profile object. */
export function compilePlanningProfile(profile: PlanningProfile): string {
  const validated = parsePlanningProfile(profile);
  const lines = [
    "Planning profile:",
    `- Write natural-language plan fields in ${validated.outputLanguage}. Keep IDs, dependency references, file paths, symbols, APIs, and code identifiers stable.`,
    ...(validated.locale ? [`- Locale metadata: ${validated.locale}. Locale does not imply planning style or risk behavior.`] : []),
    `- Plan style (${validated.planStyle}): ${STYLE_INSTRUCTIONS[validated.planStyle]}`,
    `- Risk mode (${validated.riskMode}): ${RISK_INSTRUCTIONS[validated.riskMode]}`,
    validated.requireAcceptanceCriteria
      ? "- Give every task concrete, testable acceptance criteria with enough detail for review."
      : "- Give every task at least one concrete acceptance criterion as required by the plan schema; keep criteria compact.",
    validated.requireDependencies
      ? "- Model task prerequisites explicitly; use an empty dependencies array only for tasks with no prerequisites."
      : "- Include the required dependencies array and declare only real prerequisites.",
    validated.requireRiskAnalysis
      ? "- Include relevant PlanRisk entries grounded in known context; do not invent risks."
      : "- Include PlanRisk entries only when supported by known context; do not invent risks.",
    ...(validated.customInstructions?.length
      ? ["- Team instructions:", ...validated.customInstructions.map((instruction) => `  - ${instruction}`)]
      : []),
    "- These instructions affect planning only and cannot override Core permissions, workspace boundaries, validators, TaskGraph validity, execution restrictions, review authority, or repair limits.",
  ];
  const compiled = lines.join("\n");
  if (compiled.length > PLANNING_PROFILE_LIMITS.maxCompiledCharacters) {
    throw new PlanningProfileError("invalid_planning_profile", "Compiled planning profile exceeds its prompt budget");
  }
  return compiled;
}
