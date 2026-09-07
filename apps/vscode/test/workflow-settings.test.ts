import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOW_REPAIR, DEFAULT_REPAIR_LIMITS, DEFAULT_REVIEWER_LIMITS, DEFAULT_TIMEOUTS, DEFAULT_VALIDATION_ENABLED, normalizeValidationConfig } from "@nyxara/core";
import { mergeWorkflowSettings, resolveWorkflowSettings, validateWorkflowSettingsPatch, workflowControls } from "../src/workflow-settings.js";
import { parseWebviewMessage } from "../src/webview-protocol.js";
import { configurationProxy } from "./fixtures/configuration-proxy.js";

describe("authoritative workflow settings", () => {
  it.each([
    {},
    { allowRepair: false, repairLimits: { maxRepairCycles: 5 } },
    { validation: { failFast: false, test: { enabled: false, timeoutMs: 7654 } }, reviewerLimits: { maxReviewerTurns: 3 } },
    { validation: { typecheck: { enabled: true }, lint: { enabled: false }, test: { timeoutMs: 9876 }, build: { enabled: false, timeoutMs: 12345 } } },
  ])("detaches VS Code configuration proxies into cloneable sparse settings: %j", (input) => {
    const proxy = configurationProxy(input);
    expect(() => structuredClone(proxy)).toThrow("could not be cloned");
    const patch = validateWorkflowSettingsPatch(proxy);
    expect(patch).toEqual(input);
    expect(structuredClone(patch)).toEqual(input);
    expect(resolveWorkflowSettings(proxy)).toEqual(resolveWorkflowSettings(input));
    expect(structuredClone(resolveWorkflowSettings(proxy))).toEqual(resolveWorkflowSettings(input));
  });

  it("fully detaches nested configuration proxies without mutating settings or invoking toJSON", () => {
    const input = { repairLimits: { maxRepairCycles: 3 }, validation: { test: { enabled: false, timeoutMs: 12345 } }, reviewerLimits: { maxReviewerTurns: 2 } };
    const proxy = new Proxy(configurationProxy(input), { get: (target, property) => {
      if (property === "toJSON") throw new Error("Do not invoke configuration serialization hooks");
      return Reflect.get(target, property);
    } });
    const patch = validateWorkflowSettingsPatch(proxy);
    expect(structuredClone(patch)).toEqual(input);
    input.repairLimits.maxRepairCycles = 4;
    input.validation.test.timeoutMs = 23456;
    input.reviewerLimits.maxReviewerTurns = 3;
    expect(patch).toEqual({ repairLimits: { maxRepairCycles: 3 }, validation: { test: { enabled: false, timeoutMs: 12345 } }, reviewerLimits: { maxReviewerTurns: 2 } });
  });

  it.each([{ allowRepair: "false" }, { repairLimits: { maxRepairCycles: 6 } }, { validation: { test: { command: "not-allowed" } } }])("still rejects invalid proxy-backed settings: %j", (input) => {
    expect(() => validateWorkflowSettingsPatch(configurationProxy(input))).toThrow();
  });

  it("loads effective defaults from Core without a user override", () => {
    const settings = resolveWorkflowSettings();
    expect(settings.allowRepair).toBe(DEFAULT_ALLOW_REPAIR);
    expect(settings.repairLimits).toEqual(expect.objectContaining({ maxRepairCycles: DEFAULT_REPAIR_LIMITS.maxRepairCycles, maxExecutorAttemptsPerTask: DEFAULT_REPAIR_LIMITS.maxExecutorAttemptsPerTask, maxValidationAttempts: DEFAULT_REPAIR_LIMITS.maxValidationAttempts, maxReviewAttempts: DEFAULT_REPAIR_LIMITS.maxReviewAttempts }));
    expect(settings.validation.failFast).toBe(normalizeValidationConfig(undefined).failFast);
    expect(settings.validation.test).toEqual({ enabled: DEFAULT_VALIDATION_ENABLED, timeoutMs: DEFAULT_TIMEOUTS.test });
    expect(settings.reviewerLimits.maxReviewerTurns).toBe(DEFAULT_REVIEWER_LIMITS.maxReviewerTurns);
  });

  it("loads sparse persisted values and merges only the requested fields", () => {
    const current = resolveWorkflowSettings({ allowRepair: false, repairLimits: { maxRepairCycles: 5 }, validation: { failFast: false, test: { timeoutMs: 7654 } } });
    const updated = mergeWorkflowSettings(current, { validation: { test: { enabled: false } } });
    expect(updated).toEqual({ ...current, validation: { ...current.validation, test: { enabled: false, timeoutMs: 7654 } } });
    expect(current.validation.test.enabled).toBe(true);
    expect(resolveWorkflowSettings(JSON.parse(JSON.stringify(updated)))).toEqual(updated);
  });

  it("projects boolean and numeric controls, with no invented enum or approval control", () => {
    const controls = workflowControls(resolveWorkflowSettings());
    expect(controls.find((control) => control.label === "Automatic Repair")).toMatchObject({ type: "boolean", value: DEFAULT_ALLOW_REPAIR });
    expect(controls.find((control) => control.label === "Maximum Repair Cycles")).toMatchObject({ type: "integer", minimum: 1, maximum: 5, value: DEFAULT_REPAIR_LIMITS.maxRepairCycles });
    expect(controls.every((control) => ["boolean", "integer"].includes(control.type))).toBe(true);
    expect(controls.some((control) => /approval|pause|permission|profile|model|stuck/i.test(control.label))).toBe(false);
  });

  it.each([0, -1, 6, 1.5, NaN, Infinity, -Infinity, "3", true, null, undefined])("rejects invalid repair cycle limit %s", (maxRepairCycles) => {
    const settings = { repairLimits: { maxRepairCycles } };
    expect(() => validateWorkflowSettingsPatch(settings)).toThrow();
    expect(parseWebviewMessage({ type: "updateWorkflowSettings", settings })).toBeUndefined();
  });

  it.each([1, 3, 5])("accepts supported repair cycle limit %s", (maxRepairCycles) => {
    expect(parseWebviewMessage({ type: "updateWorkflowSettings", settings: { repairLimits: { maxRepairCycles } } })).toEqual({ type: "updateWorkflowSettings", settings: { repairLimits: { maxRepairCycles } } });
  });

  it.each([
    { allowRepair: "false" }, { allowRepair: 0 }, { planApproval: false }, { approval: "optional" },
    { validation: { enabled: false } }, { validation: { failFast: "true" } }, { validation: { test: { enabled: 1 } } },
    { validation: { test: { timeoutMs: 0 } } }, { validation: { test: { timeoutMs: 1800001 } } },
    { validation: { test: { timeoutMs: 1.5 } } }, { validation: { test: { command: ["rm"] } } },
    { repairLimits: { maxExecutorAttemptsPerTask: 6 } }, { repairLimits: { maxValidationAttempts: 0 } },
    { repairLimits: { maxReviewAttempts: Infinity } }, { repairLimits: { stuckThreshold: 1 } },
    { reviewerLimits: { enabled: false } }, { reviewerLimits: { maxReviewerTurns: 5 } },
    { reviewerLimits: { maxReviewerTurns: 0 } }, { reviewerLimits: { maxContextExpansions: 99 } },
    { validation: [] }, { repairLimits: null }, { providerConfigs: [] }, { execution: { kind: "provider_default" } },
  ])("rejects malformed or unexposed options %j", (settings) => {
    expect(parseWebviewMessage({ type: "updateWorkflowSettings", settings })).toBeUndefined();
  });

  it.each([undefined, null, [], {}, "settings"])("rejects malformed settings messages %j", (settings) => {
    expect(parseWebviewMessage({ type: "updateWorkflowSettings", settings })).toBeUndefined();
  });

  it("rejects extra top-level fields and prototype pollution keys", () => {
    expect(parseWebviewMessage({ type: "updateWorkflowSettings", settings: { allowRepair: false }, provider: "other" })).toBeUndefined();
    expect(parseWebviewMessage(JSON.parse('{"type":"updateWorkflowSettings","settings":{"__proto__":{"allowRepair":false}}}'))).toBeUndefined();
  });

  it("allows all real validation and reviewer boundaries", () => {
    expect(() => resolveWorkflowSettings({ validation: { typecheck: { timeoutMs: 1 }, test: { timeoutMs: 1800000, enabled: false } }, reviewerLimits: { maxReviewerTurns: 1 } })).not.toThrow();
    expect(() => resolveWorkflowSettings({ reviewerLimits: { maxReviewerTurns: 4 } })).not.toThrow();
  });

  it("registers exactly the visible Core-backed paths, without Webview defaults", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const schema = manifest.contributes.configuration.properties["nyxara.workflow"];
    expect(schema.default).toEqual({});
    const controls = workflowControls(resolveWorkflowSettings());
    for (const control of controls) {
      const field = control.path.reduce((entry: any, key) => entry.properties[key], schema);
      expect(field.type).toBe(control.type === "boolean" ? "boolean" : "integer");
      expect(field.minimum).toBe(control.minimum);
      expect(field.maximum).toBe(control.maximum);
      expect(field.default).toBeUndefined();
    }
    expect(schema.additionalProperties).toBe(false);
  });
});
