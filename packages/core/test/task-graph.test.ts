import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TaskGraph, type ExecutionPlan, type PlannedTask } from "../src/index.js";

function task(id: string, dependencies: string[]): PlannedTask {
  return {
    id,
    title: id,
    description: id,
    dependencies,
    acceptanceCriteria: [`${id} complete`],
  };
}

function graph(tasks: PlannedTask[]): TaskGraph {
  const plan: ExecutionPlan = {
    id: randomUUID(),
    objective: "Graph test",
    tasks,
    createdAt: new Date().toISOString(),
  };
  return new TaskGraph(plan);
}

describe("TaskGraph", () => {
  it("calculates ready and blocked tasks", () => {
    const taskGraph = graph([
      task("T1", []),
      task("T2", ["T1"]),
      task("T3", ["T1"]),
      task("T4", ["T2", "T3"]),
    ]);

    expect(taskGraph.getReadyTasks().map((task) => task.id)).toEqual(["T1"]);
    expect(taskGraph.getBlockedTasks().map((task) => task.id)).toEqual([
      "T2",
      "T3",
      "T4",
    ]);
    expect(
      taskGraph.getReadyTasks(new Set(["T1"])).map((task) => task.id),
    ).toEqual(["T2", "T3"]);
    expect(taskGraph.isReady("T2", new Set(["T1"]))).toBe(true);
    expect(taskGraph.isReady("T4", new Set(["T1"]))).toBe(false);
    expect(taskGraph.getTask("T4").dependencies).toEqual(["T2", "T3"]);
  });

  it("traverses dependencies and dependents", () => {
    const taskGraph = graph([
      task("T1", []),
      task("T2", ["T1"]),
      task("T3", ["T2"]),
    ]);

    expect(taskGraph.getDependents("T1").map((task) => task.id)).toEqual(["T2"]);
    expect(
      taskGraph.getDependencies("T3", true).map((task) => task.id),
    ).toEqual(["T2", "T1"]);
  });

  it("detects cycles", () => {
    expect(
      graph([task("T1", ["T2"]), task("T2", ["T1"])]).hasCycle(),
    ).toBe(true);
  });
});
