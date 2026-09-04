import { describe, expect, it } from "vitest";
import { MAX_HISTORY_CRITERIA, MAX_HISTORY_DEPENDENCIES, MAX_HISTORY_RISKS, MAX_HISTORY_TASKS, MAX_HISTORY_VALIDATION_STEPS, createTaskSession, projectTaskSession, safeWorkspaceIdentity, sanitizeTaskSession, taskSessionStatus } from "../src/task-session.js";
import type { WorkspaceViewState } from "../src/workspace-state.js";

const workspace = safeWorkspaceIdentity("Project", "/private/home/project");
const base = createTaskSession({ id: "session", now: "2026-09-03T00:00:00.000Z", requirement: "Add pagination", workspaceIdentity: workspace, providerSummary: { provider: "Gateway", model: "route/model" } });
const state = (overrides: Partial<WorkspaceViewState> = {}): WorkspaceViewState => ({ version: "test", configured: true, workspace: { available: true, multiple: false }, providerLabel: "Gateway", advancedRouting: false, providers: [], history: { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "current" }, validation: [], repairCycles: null, ...overrides });

describe("TaskSession projection", () => {
  it.each([
    ["planning", "planning"], ["awaiting_plan_approval", "awaiting_approval"], ["executing", "executing"], ["validating", "validating"], ["reviewing", "reviewing"], ["repairing", "repairing"], ["waiting_for_permission", "waiting_for_permission"], ["paused", "paused"], ["completed", "completed"], ["failed", "failed"], ["aborted", "aborted"],
  ])("maps authoritative Core %s to history %s", (core, expected) => expect(taskSessionStatus(core)).toBe(expected));

  it("projects bounded plan, execution, validation, review, repair, and exact authoritative usage", () => {
    const projected = projectTaskSession(base, state({
      plan: { id: "p", objective: "Objective", tasks: [{ id: "one", title: "Task", description: "not persisted", acceptanceCriteria: ["Pass"], dependencies: [], risk: "low" }], risks: [] },
      workflow: { id: "w", status: "completed", stage: "Completed", active: false, approvalStatus: "approved", progress: { completed: 1, total: 1 }, currentTaskId: "one", tasks: [{ id: "one", title: "Task", status: "completed" }] },
      validation: [{ kind: "typecheck", status: "passed", durationMs: 12.25 }], reviewStatus: "passed", reviewFindingCount: 2, repairCycles: 1,
      repairUsage: { durationMs: 40.5, tokens: 6 }, usage: { tokens: 7073, modelCalls: 4, toolCalls: 9, durationMs: 20600.5, repairCycles: 1 },
      completion: { status: "completed", changedFiles: 2, tokens: 7073, modelCalls: 4, durationMs: 20600.5, repairCycles: 1 },
    }), "2026-09-03T00:01:00.000Z");
    expect(projected.status).toBe("completed");
    expect(projected.planSummary?.approvalStatus).toBe("approved");
    expect(projected.executionSummary).toMatchObject({ completed: 1, total: 1, currentTaskTitle: "Task" });
    expect(projected.validationSummary).toEqual({ status: "passed", steps: [{ name: "typecheck", status: "passed", durationMs: 12.25 }] });
    expect(projected.reviewSummary).toEqual({ status: "passed", findingCount: 2, ruleViolationCount: null });
    expect(projected.repairSummary).toEqual({ cycles: 1, outcome: "completed", durationMs: 40.5, tokens: 6 });
    expect(projected.usageSummary).toEqual({ totalTokens: 7073, providerCalls: 4, toolCalls: 9, workflowDurationMs: 20600.5, repairCycles: 1 });
    expect(JSON.stringify(projected)).not.toContain("not persisted");
  });

  it("keeps unavailable authoritative usage null and does not independently calculate it", () => {
    const projected = projectTaskSession(base, state({ workflow: { id: "w", status: "completed", stage: "Completed", active: false, tasks: [] }, completion: { status: "completed", changedFiles: null, tokens: null, modelCalls: null, durationMs: null, repairCycles: null } }));
    expect(projected.usageSummary).toEqual({ totalTokens: null, providerCalls: null, toolCalls: null, workflowDurationMs: null, repairCycles: null });
  });

  it("sanitizes provider/model HTML and rejects invalid task records", () => {
    const sanitized = sanitizeTaskSession({ ...base, providerSummary: { provider: "<provider>", model: "<model>" } });
    expect(sanitized?.providerSummary).toEqual({ provider: "<provider>", model: "<model>" });
    expect(sanitizeTaskSession({ ...base, id: "" })).toBeUndefined();
    expect(sanitizeTaskSession({ ...base, schemaVersion: 2 })).toBeUndefined();
  });

  it("redacts credentials even when they appear inside otherwise allowed persisted text", () => {
    const secret = "sk-fake-secret-123456789";
    const sanitized = sanitizeTaskSession({
      ...base,
      title: `Fix api_key=${secret}`,
      requirement: `Use Authorization: Bearer ${secret} without exposing it`,
      providerSummary: { provider: `Gateway access_token=${secret}`, model: "route/model" },
      planSummary: { objective: `Never print ${secret}`, approvalStatus: "draft", tasks: [], risks: [] },
    });
    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(JSON.stringify(sanitized)).toContain("[redacted]");
  });

  it("bounds nested plan, dependency, risk, execution, and validation arrays", () => {
    const repeated = Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, acceptanceCriteria: Array(100).fill("Pass"), dependencies: Array(100).fill("task-0") }));
    const sanitized = sanitizeTaskSession({
      ...base,
      planSummary: { objective: "Bounded", approvalStatus: "draft", tasks: repeated, risks: Array.from({ length: 100 }, () => ({ description: "Risk", severity: "low" })) },
      executionSummary: { completed: 0, total: 100, tasks: repeated.map((task) => ({ title: task.title, status: "pending" })) },
      validationSummary: { status: "pending", steps: Array.from({ length: 100 }, (_, index) => ({ name: `step-${index}`, status: "pending", durationMs: null })) },
    });
    expect(sanitized?.planSummary?.tasks).toHaveLength(MAX_HISTORY_TASKS);
    expect(sanitized?.planSummary?.tasks[0]?.acceptanceCriteria).toHaveLength(MAX_HISTORY_CRITERIA);
    expect(sanitized?.planSummary?.tasks[0]?.dependencies).toHaveLength(MAX_HISTORY_DEPENDENCIES);
    expect(sanitized?.planSummary?.risks).toHaveLength(MAX_HISTORY_RISKS);
    expect(sanitized?.executionSummary?.tasks).toHaveLength(MAX_HISTORY_TASKS);
    expect(sanitized?.validationSummary?.steps).toHaveLength(MAX_HISTORY_VALIDATION_STEPS);
  });
});
