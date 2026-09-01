import { ENGINEERING_RULE_LIMITS, EngineeringRuleError, parseEngineeringRule, type EngineeringRule } from "./engineering-rule.js";

export class EngineeringRuleRegistry {
  private readonly rules = new Map<string, EngineeringRule>();
  constructor(rules: readonly unknown[] = []) {
    for (const rule of BUILT_IN_ENGINEERING_RULES) this.rules.set(rule.id, rule);
    for (const rule of rules) this.register(rule);
  }
  register(rule: unknown): EngineeringRule {
    const parsed = parseEngineeringRule(rule);
    if (this.rules.has(parsed.id)) throw new EngineeringRuleError("duplicate_rule", `Engineering rule already exists: ${parsed.id}`);
    if (this.rules.size >= ENGINEERING_RULE_LIMITS.maxRules) throw new EngineeringRuleError("rule_limit_exceeded", `Engineering rule registry is limited to ${ENGINEERING_RULE_LIMITS.maxRules} rules`);
    this.rules.set(parsed.id, parsed); return parsed;
  }
  get(id: string): EngineeringRule { const rule = this.rules.get(id.trim()); if (!rule) throw new EngineeringRuleError("unknown_rule", `Unknown engineering rule: ${id}`); return rule; }
  has(id: string): boolean { return this.rules.has(id.trim()); }
  list(): EngineeringRule[] { return [...this.rules.values()].sort((a, b) => a.id.localeCompare(b.id)); }
}

export const BUILT_IN_ENGINEERING_RULES: readonly EngineeringRule[] = Object.freeze([
  ["avoid-n-plus-one", "Avoid N+1 queries", "Avoid introducing N+1 database access patterns.", "error"],
  ["avoid-duplicate-business-logic", "Avoid duplicate business logic", "Reuse existing business rules and abstractions instead of duplicating them.", "warning"],
  ["respect-module-boundaries", "Respect module boundaries", "Keep changes within established module boundaries and dependency direction.", "error"],
  ["avoid-unnecessary-db-roundtrips", "Avoid unnecessary database round trips", "Prefer efficient data access and avoid avoidable database round trips.", "warning"],
  ["avoid-unnecessary-dependencies", "Avoid unnecessary dependencies", "Prefer existing dependencies unless a new package is necessary.", "warning"],
  ["preserve-backward-compatibility", "Preserve backward compatibility", "Preserve existing public APIs and behavior unless the requirement explicitly changes them.", "warning"],
  ["avoid-secret-exposure", "Avoid secret exposure", "Never expose credentials or secrets in source, logs, diffs, or user-facing output.", "error"],
].map(([id, name, description, severity]) => parseEngineeringRule({ id, name, description, scope: "global", severity, enabled: true, instruction: description })));
