import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "@nyxara/core";
import { projectWorkflowProgress, type WorkflowStep } from "../src/workflow-progress.js";

function progress(overrides: Partial<WorkflowSnapshot>, owner?: WorkflowStep) {
  return Object.fromEntries(projectWorkflowProgress({ workflowId: "workflow", updatedAt: "now", status: "created", tasks: [], ...overrides }, owner).map((step) => [step.label, step.status]));
}

describe("authoritative workflow rail projection", () => {
  it.each(["created", "planning"] as const)("keeps Plan active during %s even with a draft plan ID", (status) => {
    expect(progress({ status, planId: "draft" })).toEqual({ Plan: "active", Execute: "pending", Validate: "pending", Review: "pending", Repair: "pending" });
  });

  it("completes Plan only when awaiting approval", () => {
    expect(progress({ status: "awaiting_plan_approval", planId: "plan" })).toEqual({ Plan: "completed", Execute: "pending", Validate: "pending", Review: "pending", Repair: "pending" });
  });

  it.each([
    ["executing", "Execute", {}],
    ["validating", "Validate", { executionStatus: "completed" }],
    ["reviewing", "Review", { executionStatus: "completed", validationStatus: "passed" }],
    ["repairing", "Repair", { executionStatus: "completed", validationStatus: "passed", reviewStatus: "failed" }],
  ] as const)("projects %s without replacing prior results", (status, active, evidence) => {
    const result = progress({ status, planId: "plan", tasks: [{ taskId: "task", ...evidence }] });
    expect(result.Plan).toBe("completed");
    expect(result[active]).toBe("active");
    if (status === "repairing") expect(result).toEqual({ Plan: "completed", Execute: "completed", Validate: "completed", Review: "failed", Repair: "active" });
  });

  it.each(["Execute", "Validate", "Review", "Repair"] as const)("preserves %s ownership while waiting for permission", (owner) => {
    expect(progress({ status: "waiting_for_permission", planId: "plan" }, owner)[owner]).toBe("active");
  });

  it("marks the actual failure rather than a stale running owner", () => {
    expect(progress({ status: "failed", planId: "plan", tasks: [{ taskId: "task", executionStatus: "completed", validationStatus: "failed" }] }, "Execute")).toMatchObject({ Execute: "completed", Validate: "failed" });
  });

  it("stops a rejected plan before execution", () => {
    expect(progress({ status: "failed", outcome: "rejected", planId: "plan" }, "Plan")).toEqual({ Plan: "completed", Execute: "pending", Validate: "pending", Review: "pending", Repair: "pending" });
  });

  it("preserves completed stages and aborts the owner", () => {
    expect(progress({ status: "aborted", planId: "plan", tasks: [{ taskId: "task", executionStatus: "completed", validationStatus: "passed" }] }, "Review")).toEqual({ Plan: "completed", Execute: "completed", Validate: "completed", Review: "aborted", Repair: "pending" });
  });

  it("does not invent validation or review for completed read-only work", () => {
    expect(progress({ status: "completed", planId: "plan", tasks: [{ taskId: "task", executionStatus: "completed" }] })).toEqual({ Plan: "completed", Execute: "completed", Validate: "pending", Review: "pending", Repair: "pending" });
  });

  it("uses all task evidence at completion, not just the final read-only task", () => {
    expect(progress({ status: "completed", planId: "plan", currentTaskId: "last", tasks: [{ taskId: "first", executionStatus: "completed", validationStatus: "passed", reviewStatus: "passed" }, { taskId: "last", executionStatus: "completed" }] })).toMatchObject({ Execute: "completed", Validate: "completed", Review: "completed" });
  });
});
