import { describe, expect, it, vi } from "vitest";
import {
  EventBus,
  NyxaraOrchestrator,
  WorkflowEngine,
  WorkflowStateError,
  type NyxaraEventMap,
  type WorkflowStatus,
} from "../src/index.js";

function engine(): {
  readonly workflow: WorkflowEngine;
  readonly events: EventBus<NyxaraEventMap>;
} {
  const events = new EventBus<NyxaraEventMap>();
  return { workflow: new WorkflowEngine(events), events };
}

describe("Core workflow state", () => {
  it("creates a workflow in the created status", () => {
    const { workflow } = engine();

    const state = workflow.start({ workspace: "/workspace", prompt: "hello" });

    expect(state.status).toBe("created");
    expect(state.workspace).toBe("/workspace");
    expect(state.prompt).toBe("hello");
    expect(workflow.has(state.id)).toBe(true);
  });

  it("rejects invalid workflow input", () => {
    const { workflow } = engine();

    expect(() =>
      workflow.start({ workspace: "/workspace", prompt: "" }),
    ).toThrow(WorkflowStateError);
  });

  it("walks planning, execution, validation, review, repair and completion", () => {
    const { workflow, events } = engine();
    const transitions: string[] = [];
    events.on("workflow.status_changed", ({ from, to }) => {
      transitions.push(from + "->" + to);
    });

    const { id } = workflow.start({ workspace: "/workspace", prompt: "hello" });
    workflow.transition(id, "planning");
    workflow.transition(id, "planned", { planId: "plan-1" });
    workflow.transition(id, "executing", { currentTaskId: "T1" });
    workflow.transition(id, "validating");
    workflow.transition(id, "reviewing");
    workflow.transition(id, "repairing");
    workflow.transition(id, "validating");
    const completed = workflow.complete(id);

    expect(completed.status).toBe("completed");
    expect(completed.planId).toBe("plan-1");
    expect(transitions).toEqual([
      "created->planning",
      "planning->planned",
      "planned->executing",
      "executing->validating",
      "validating->reviewing",
      "reviewing->repairing",
      "repairing->validating",
      "validating->completed",
    ]);
  });

  it("records a failure with its error code", () => {
    const { workflow, events } = engine();
    const onFailed = vi.fn();
    events.on("workflow.failed", onFailed);

    const { id } = workflow.start({ workspace: "/workspace", prompt: "hello" });
    workflow.transition(id, "planning");
    const failed = workflow.fail(id, {
      code: "planner_error",
      message: "Planner failed",
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "planner_error",
      message: "Planner failed",
    });
    expect(onFailed).toHaveBeenCalledWith({
      workflowId: id,
      code: "planner_error",
      message: "Planner failed",
    });
  });

  it("aborts a workflow from a non-terminal status", () => {
    const { workflow, events } = engine();
    const onAborted = vi.fn();
    events.on("workflow.aborted", onAborted);

    const { id } = workflow.start({ workspace: "/workspace", prompt: "hello" });
    workflow.transition(id, "planning");

    expect(workflow.abort(id).status).toBe("aborted");
    expect(onAborted).toHaveBeenCalledWith({ workflowId: id });
  });

  it("rejects illegal transitions and mutation of terminal workflows", () => {
    const { workflow } = engine();
    const { id } = workflow.start({ workspace: "/workspace", prompt: "hello" });

    expect(() => workflow.transition(id, "executing")).toThrow(
      WorkflowStateError,
    );
    workflow.transition(id, "planning");
    expect(() => workflow.transition(id, "reviewing")).toThrow(
      WorkflowStateError,
    );

    workflow.transition(id, "planned");
    workflow.complete(id);
    const illegal: WorkflowStatus[] = [
      "planning",
      "executing",
      "failed",
      "aborted",
    ];
    for (const status of illegal) {
      expect(() => workflow.transition(id, status)).toThrow(WorkflowStateError);
    }
  });

  it("rejects unknown workflows", () => {
    const { workflow } = engine();

    expect(() => workflow.get("missing")).toThrow(WorkflowStateError);
    expect(() => workflow.transition("missing", "planning")).toThrow(
      WorkflowStateError,
    );
  });

  it("bounds retained workflows to the configured limit", () => {
    const events = new EventBus<NyxaraEventMap>();
    const workflow = new WorkflowEngine(events, { maxWorkflows: 2 });

    const first = workflow.start({ workspace: "/w", prompt: "one" });
    workflow.transition(first.id, "planning");
    workflow.fail(first.id, { code: "x", message: "y" });
    workflow.start({ workspace: "/w", prompt: "two" });
    workflow.start({ workspace: "/w", prompt: "three" });

    expect(workflow.list()).toHaveLength(2);
    expect(workflow.has(first.id)).toBe(false);
  });
});

describe("Workflow snapshot", () => {
  it("summarizes the current task and per-stage status", () => {
    const { workflow } = engine();
    const { id } = workflow.start({ workspace: "/workspace", prompt: "hello" });

    workflow.transition(id, "planning");
    workflow.transition(id, "planned", { planId: "plan-1" });
    workflow.transition(id, "executing", { currentTaskId: "T1" });
    workflow.taskStarted(id, "T1", 1);
    workflow.taskCompleted(id, "T1", 1);
    workflow.recordTask(id, {
      taskId: "T1",
      validationStatus: "failed",
      repairStatus: "passed",
    });
    workflow.transition(id, "validating");
    workflow.recordTask(id, { taskId: "T1", reviewStatus: "passed" });

    const snapshot = workflow.snapshot(id);

    expect(snapshot.workflowId).toBe(id);
    expect(snapshot.planId).toBe("plan-1");
    expect(snapshot.currentTaskId).toBe("T1");
    expect(snapshot.status).toBe("validating");
    expect(snapshot.tasks).toEqual([
      {
        taskId: "T1",
        executionStatus: "completed",
        attempts: 1,
        validationStatus: "failed",
        repairStatus: "passed",
        reviewStatus: "passed",
      },
    ]);
    expect(snapshot.startedAt).toBeDefined();
    expect(snapshot.updatedAt).toBeDefined();
  });

  it("reports the terminal error and carries no evidence payloads", () => {
    const { workflow } = engine();
    const { id } = workflow.start({ workspace: "/workspace", prompt: "hello" });

    workflow.transition(id, "planning");
    workflow.transition(id, "planned");
    workflow.transition(id, "executing", { currentTaskId: "T2" });
    workflow.taskFailed(id, "T2", "executor_error", 1);
    workflow.fail(id, { code: "executor_error", message: "Task failed" });

    const snapshot = workflow.snapshot(id);

    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toEqual({
      code: "executor_error",
      message: "Task failed",
    });

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["diff", "stdout", "stderr", "content", "prompt"]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const task of snapshot.tasks) {
      expect(Object.keys(task).sort()).toEqual([
        "attempts",
        "executionStatus",
        "taskId",
      ]);
    }
  });

  it("is reachable from the orchestrator without mutating state", () => {
    const nyxara = new NyxaraOrchestrator();
    const state = nyxara.startWorkflow({
      workspace: "/workspace",
      prompt: "hello",
    });

    expect(nyxara.getWorkflowState(state.id).status).toBe("created");
    expect(nyxara.getWorkflowSnapshot(state.id)).toMatchObject({
      workflowId: state.id,
      status: "created",
      tasks: [],
    });
    expect(nyxara.listWorkflows()).toHaveLength(1);
    expect(nyxara.abortWorkflow(state.id).status).toBe("aborted");
  });
});
