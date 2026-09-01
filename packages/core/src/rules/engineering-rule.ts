import { createHash } from "node:crypto";
import { z } from "zod";

export type RuleScope = "global" | "workspace" | "task";
export type RuleSeverity = "info" | "warning" | "error";

export const ENGINEERING_RULE_LIMITS = Object.freeze({
  maxRules: 256,
  maxEffectiveRules: 64,
  maxInstructionChars: 500,
  maxDescriptionChars: 300,
  maxCompiledChars: 8_000,
  maxTagCount: 12,
  maxIdChars: 96,
});

const RuleIdSchema = z.string().trim().min(1).max(ENGINEERING_RULE_LIMITS.maxIdChars)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Rule ID must use lowercase letters, numbers, dots, underscores, or hyphens");

export const EngineeringRuleSchema = z.object({
  id: RuleIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(ENGINEERING_RULE_LIMITS.maxDescriptionChars),
  scope: z.enum(["global", "workspace", "task"]),
  severity: z.enum(["info", "warning", "error"]),
  enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(ENGINEERING_RULE_LIMITS.maxInstructionChars),
  tags: z.array(z.string().trim().min(1).max(40)).max(ENGINEERING_RULE_LIMITS.maxTagCount).optional(),
}).strict();

export type EngineeringRule = Readonly<Omit<z.infer<typeof EngineeringRuleSchema>, "tags"> & { readonly tags?: readonly string[] }>;

export interface ResolvedRuleSet {
  readonly rules: readonly EngineeringRule[];
  readonly sourceCount: { readonly global: number; readonly workspace: number; readonly task: number };
  readonly truncated: boolean;
  readonly fingerprint: string;
}

export class EngineeringRuleError extends Error {
  constructor(readonly code: string, message: string = code) { super(message); this.name = "EngineeringRuleError"; }
}

export function parseEngineeringRule(value: unknown): EngineeringRule {
  const parsed = EngineeringRuleSchema.safeParse(value);
  if (!parsed.success) throw new EngineeringRuleError("invalid_rule", parsed.error.issues[0]?.message ?? "Invalid engineering rule");
  const { tags, ...rule } = parsed.data;
  return Object.freeze({ ...rule, ...(tags ? { tags: Object.freeze([...tags]) } : {}) });
}

export function ruleSetFingerprint(rules: readonly EngineeringRule[]): string {
  const canonical = [...rules].map((rule) => ({ id: rule.id, severity: rule.severity, enabled: rule.enabled, instruction: rule.instruction, scope: rule.scope }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function resolveEngineeringRules(
  global: readonly EngineeringRule[], workspace: readonly EngineeringRule[] = [], task: readonly EngineeringRule[] = [],
): ResolvedRuleSet {
  const byId = new Map<string, EngineeringRule>();
  const sourceCount = { global: global.length, workspace: workspace.length, task: task.length };
  for (const rule of global) byId.set(rule.id, rule);
  for (const rule of workspace) byId.set(rule.id, rule);
  for (const rule of task) byId.set(rule.id, rule);
  const ordered = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const effective = ordered.filter((rule) => rule.enabled);
  const truncated = effective.length > ENGINEERING_RULE_LIMITS.maxEffectiveRules;
  const rules = effective.slice(0, ENGINEERING_RULE_LIMITS.maxEffectiveRules);
  return Object.freeze({ rules: Object.freeze(rules), sourceCount: Object.freeze(sourceCount), truncated, fingerprint: ruleSetFingerprint(rules) });
}

export function compileEngineeringRules(ruleSet: ResolvedRuleSet): string {
  const lines = ["Engineering rules:"];
  for (const rule of ruleSet.rules) lines.push(`[${rule.severity.toUpperCase()}] ${rule.id}\n${rule.instruction}`);
  const compiled = lines.join("\n\n");
  return compiled.length <= ENGINEERING_RULE_LIMITS.maxCompiledChars
    ? compiled
    : compiled.slice(0, ENGINEERING_RULE_LIMITS.maxCompiledChars);
}
