import { describe, expect, it } from "vitest";
import { groupPlanAcceptanceCriteria } from "../src/planner/plan-criteria-normalizer.js";
import { DEFAULT_PLAN_STRUCTURE_BOUNDS, PlanValidator } from "../src/planner/plan-validator.js";
import type { ExecutionPlanDraft } from "../src/planner/planner.types.js";

function draft(criteria: string[]): ExecutionPlanDraft {
  return {
    objective: "Only fix the atmosphere", summary: "Preserve framing",
    tasks: [{ id: "T7", title: "Verify", description: "Capture existing metrics", dependencies: [], acceptanceCriteria: criteria, relevantFiles: ["apps/web/scripts/planet-compare.py"], risk: "low" }],
    risks: [{ description: "Light regression", severity: "low", mitigation: "Check both themes" }], assumptions: ["Existing script is available"],
  };
}

describe("lossless plan criteria grouping", () => {
  it("leaves already-valid drafts and text unchanged", () => {
    const source = draft(["First\nSecond", "First\nSecond"]);
    expect(groupPlanAcceptanceCriteria(source, DEFAULT_PLAN_STRUCTURE_BOUNDS)).toBe(source);
  });

  it("preserves multiline text, Unicode, duplicates, metadata, and ordering without mutating the source", () => {
    const criteria = ["Giữ framing\nFOV 27.214", "directional_ratio >= 5.0", "rim upleft < 70", "Sai lệch < 25", "Không đổi surface", "Không đổi surface", "Kiểm tra dark", "Kiểm tra light"];
    const source = draft(criteria);
    const snapshot = structuredClone(source);
    Object.freeze(criteria);
    Object.freeze(source.tasks[0]);
    Object.freeze(source.tasks);
    Object.freeze(source);
    const result = groupPlanAcceptanceCriteria(source, DEFAULT_PLAN_STRUCTURE_BOUNDS);
    expect(result).toEqual({ ...snapshot, tasks: [{ ...snapshot.tasks[0], acceptanceCriteria: [`${criteria[0]}\n${criteria[1]}`, `${criteria[2]}\n${criteria[3]}`, ...criteria.slice(4)] }] });
    expect(source).toEqual(snapshot);
    expect(groupPlanAcceptanceCriteria(result, DEFAULT_PLAN_STRUCTURE_BOUNDS)).toBe(result);
  });

  it("skips pairs that cannot fit and groups later adjacent pairs within the same bound", () => {
    const criteria = ["a".repeat(400), "b".repeat(199), "c".repeat(200), "d".repeat(400), "e".repeat(199), "f".repeat(200), "g".repeat(400), "h".repeat(400)];
    expect(groupPlanAcceptanceCriteria(draft(criteria), DEFAULT_PLAN_STRUCTURE_BOUNDS).tasks[0]!.acceptanceCriteria).toEqual([criteria[0], `${criteria[1]}\n${criteria[2]}`, criteria[3], `${criteria[4]}\n${criteria[5]}`, criteria[6], criteria[7]]);
  });

  it("does not publish partial grouping when enough bounded pairs cannot be formed", () => {
    const source = draft(["short", "short", ...Array.from({ length: 6 }, () => "x".repeat(400))]);
    expect(groupPlanAcceptanceCriteria(source, DEFAULT_PLAN_STRUCTURE_BOUNDS)).toBe(source);
  });

  it("uses the supplied validator bounds rather than hardcoded defaults", () => {
    const validator = new PlanValidator({ ...DEFAULT_PLAN_STRUCTURE_BOUNDS, maxAcceptanceCriteriaPerTask: 2, maxAcceptanceCriterionCharacters: 10 });
    const source = draft(["one", "two", "three", "four"]);
    const grouped = groupPlanAcceptanceCriteria(source, validator.structureBounds);
    expect(grouped.tasks[0]!.acceptanceCriteria).toEqual(["one\ntwo", "three\nfour"]);
    expect(() => validator.validate({ ...source, id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-09-07T00:00:00.000Z" })).toThrowError(expect.objectContaining({ code: "plan_bounds_exceeded" }));
    expect(validator.validate({ ...grouped, id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-09-07T00:00:00.000Z" }).tasks[0]!.acceptanceCriteria).toHaveLength(2);
  });
});
