import { describe, expect, it } from "vitest";
import {
  ENGINEERING_RULE_LIMITS,
  EngineeringRuleError,
  EngineeringRuleRegistry,
  ReviewValidator,
  compileEngineeringRules,
  parseEngineeringRule,
  resolveEngineeringRules,
  ruleSetFingerprint,
} from "../src/index.js";

function rule(id: string, scope: "global" | "workspace" | "task" = "global", severity: "info" | "warning" | "error" = "warning", enabled = true) {
  return parseEngineeringRule({ id, name: id, description: `${id} description`, scope, severity, enabled, instruction: `${id} instruction` });
}

const validation = { id: "V1", taskId: "T1", status: "passed", steps: [], startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", durationMs: 1 } as const;
const baseReview = { status: "passed", summary: "ok", findings: [], criteria: [{ criterion: "works", status: "satisfied", reason: "evidence" }] } as const;

describe("engineering rules", () => {
  it("registers immutable rules and makes duplicate behavior explicit", () => {
    const input = { id: "local-rule", name: "Local", description: "description", scope: "workspace", severity: "warning", enabled: true, instruction: "instruction", tags: ["one"] };
    const registry = new EngineeringRuleRegistry();
    const registered = registry.register(input);
    input.tags[0] = "changed";
    expect(registry.has("local-rule")).toBe(true);
    expect(registry.get("local-rule").tags).toEqual(["one"]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(() => registry.register(input)).toThrowError(EngineeringRuleError);
  });

  it("resolves task over workspace over global, including disable overrides", () => {
    const resolved = resolveEngineeringRules([rule("r1")], [rule("r1", "workspace", "error")], [rule("r1", "task", "error", false)]);
    expect(resolved.rules).toEqual([]);
    expect(resolved.sourceCount).toEqual({ global: 1, workspace: 1, task: 1 });
  });

  it("compiles deterministically within its budget and fingerprints semantics", () => {
    const resolved = resolveEngineeringRules([rule("b"), rule("a")]);
    expect(compileEngineeringRules(resolved)).toBe(compileEngineeringRules(resolved));
    expect(compileEngineeringRules(resolved).length).toBeLessThanOrEqual(ENGINEERING_RULE_LIMITS.maxCompiledChars);
    expect(ruleSetFingerprint(resolved.rules)).not.toBe(ruleSetFingerprint([rule("a", "global", "error"), rule("b")]));
  });

  it("forces error violations and uncertainty to fail but retains warning violations", () => {
    const validator = new ReviewValidator();
    const errorRules = resolveEngineeringRules([rule("error-rule", "global", "error")]);
    for (const status of ["violated", "uncertain"] as const) {
      const result = validator.validate({ ...baseReview, ruleEvaluations: [{ ruleId: "error-rule", status }] }, ["works"], validation, errorRules);
      expect(result.status).toBe("failed");
      expect(result.findings[0]?.ruleId).toBe("error-rule");
    }
    const warningRules = resolveEngineeringRules([rule("warning-rule")]);
    const warning = validator.validate({ ...baseReview, ruleEvaluations: [{ ruleId: "warning-rule", status: "violated" }] }, ["works"], validation, warningRules);
    expect(warning.status).toBe("passed");
    expect(warning.findings[0]?.severity).toBe("warning");
  });

  it("rejects unknown and duplicate structured rule evaluations", () => {
    const validator = new ReviewValidator();
    const rules = resolveEngineeringRules([rule("expected")]);
    expect(() => validator.validate({ ...baseReview, ruleEvaluations: [{ ruleId: "unknown", status: "satisfied" }] }, ["works"], validation, rules)).toThrowError(/Unknown/);
    expect(() => validator.validate({ ...baseReview, ruleEvaluations: [{ ruleId: "expected", status: "satisfied" }, { ruleId: "expected", status: "satisfied" }] }, ["works"], validation, rules)).toThrowError(/only once/);
  });
});
