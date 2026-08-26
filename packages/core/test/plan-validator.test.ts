import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PlanValidator,
  type ExecutionPlan,
  type PlannedTask,
} from "../src/index.js";

function task(
  id: string,
  dependencies: string[] = [],
  overrides: Partial<PlannedTask> = {},
): PlannedTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Description ${id}`,
    dependencies,
    acceptanceCriteria: [`${id} is verifiably complete`],
    ...overrides,
  };
}

function plan(tasks: PlannedTask[]): ExecutionPlan {
  return {
    id: randomUUID(),
    objective: "Implement the requested change",
    tasks,
    createdAt: new Date().toISOString(),
  };
}

describe("PlanValidator", () => {
  const validator = new PlanValidator();

  it("accepts a valid structured plan", () => {
    const input = plan([task("T1"), task("T2", ["T1"])]);
    expect(validator.validate(input)).toEqual(input);
  });

  it.each([
    ["empty tasks", plan([]), "invalid_plan"],
    [
      "duplicate task IDs",
      plan([task("T1"), task("T1")]),
      "invalid_plan",
    ],
    [
      "missing dependency",
      plan([task("T1", ["missing"])]),
      "missing_dependency",
    ],
    ["self dependency", plan([task("T1", ["T1"])]), "self_dependency"],
    [
      "dependency cycle",
      plan([task("T1", ["T2"]), task("T2", ["T1"])]),
      "plan_cycle_detected",
    ],
    [
      "missing acceptance criteria",
      plan([task("T1", [], { acceptanceCriteria: [] })]),
      "invalid_plan",
    ],
    [
      "empty description",
      plan([task("T1", [], { description: "" })]),
      "invalid_plan",
    ],
  ])("rejects %s", (_name, input, code) => {
    expect(() => validator.validate(input)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

