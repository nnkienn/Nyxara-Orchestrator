import { randomUUID } from "node:crypto";
import type {
  PendingWorkflowPermission,
  WorkflowSnapshot,
  WorkflowState,
  WorkflowStatus,
} from "@nyxara/shared";
import { z } from "zod";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { WorkflowStateStore } from "./workflow-state-store.js";
import { WorkflowStateError } from "./workflow.errors.js";
import {
  DEFAULT_WORKFLOW_LIMITS,
  WORKFLOW_TRANSITIONS,
  type StartWorkflowInput,
  type WorkflowLimits,
  type WorkflowTaskRecord,
  type WorkflowTransitionInput,
} from "./workflow.types.js";

const startInputSchema = z.object({
  workspace: z.string().trim().min(1, "workspace is required"),
  prompt: z.string().trim().min(1, "prompt is required"),
});

/**
 * Core-owned workflow state machine. It is the only component allowed to change
 * workflow status: agents return decisions and clients render snapshots, but
 * neither may mutate state directly.
 */
export class WorkflowEngine {
  private readonly store: WorkflowStateStore;

  constructor(
    private readonly events: EventBus<NyxaraEventMap>,
    limits: Partial<WorkflowLimits> = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.store = new WorkflowStateStore({
      ...DEFAULT_WORKFLOW_LIMITS,
      ...limits,
    });
  }

  start(input: StartWorkflowInput): WorkflowState {
    const parsed = startInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkflowStateError(
        "invalid_workflow_input",
        parsed.error.issues[0]?.message ?? "Workflow input is invalid",
      );
    }
    const timestamp = this.now();
    const state: WorkflowState = Object.freeze({
      id: randomUUID(),
      workspace: parsed.data.workspace,
      prompt: parsed.data.prompt,
      status: "created" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.store.create(state);
    this.events.emit("workflow.started", {
      workflowId: state.id,
      startedAt: timestamp,
    });
    return state;
  }

  has(workflowId: string): boolean {
    return this.store.has(workflowId);
  }

  get(workflowId: string): WorkflowState {
    return this.store.require(workflowId);
  }

  list(): WorkflowState[] {
    return this.store.list();
  }

  transition(
    workflowId: string,
    next: WorkflowStatus,
    patch: WorkflowTransitionInput = {},
  ): WorkflowState {
    const current = this.store.require(workflowId);
    if (!WORKFLOW_TRANSITIONS[current.status].includes(next)) {
      throw new WorkflowStateError(
        "invalid_workflow_transition",
        "Invalid workflow transition: " + current.status + " -> " + next,
      );
    }

    const planId = patch.planId ?? current.planId;
    const currentTaskId = patch.currentTaskId === null ? undefined : (patch.currentTaskId ?? current.currentTaskId);
    const error = patch.error ?? current.error;
    const state: WorkflowState = Object.freeze({
      id: current.id,
      workspace: current.workspace,
      prompt: current.prompt,
      status: next,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      ...(planId ? { planId } : {}),
      ...(currentTaskId ? { currentTaskId } : {}),
      ...(error ? { error } : {}),
      ...(patch.progress ? { progress: patch.progress } : ("progress" in current ? { progress: current.progress } : {})),
      ...(patch.failedTaskId ? { failedTaskId: patch.failedTaskId } : ("failedTaskId" in current ? { failedTaskId: current.failedTaskId } : {})),
      ...(patch.blockedTaskIds ? { blockedTaskIds: [...patch.blockedTaskIds] } : ("blockedTaskIds" in current ? { blockedTaskIds: current.blockedTaskIds } : {})),
      ...(patch.pauseRequested !== undefined ? (patch.pauseRequested ? { pauseRequested: true } : {}) : (current.pauseRequested ? { pauseRequested: true } : {})),
      ...(patch.pendingPermission !== undefined ? (patch.pendingPermission ? { pendingPermission: patch.pendingPermission } : {}) : (current.pendingPermission ? { pendingPermission: current.pendingPermission } : {})),
    });
    this.store.replace(state);

    this.events.emit("workflow.status_changed", {
      workflowId,
      from: current.status,
      to: next,
      ...(planId ? { planId } : {}),
      ...(currentTaskId ? { currentTaskId } : {}),
    });
    this.emitTerminal(state);
    return state;
  }

  setPlan(workflowId: string, planId: string): WorkflowState {
    const current = this.store.require(workflowId);
    const state: WorkflowState = Object.freeze({
      ...current,
      planId,
      updatedAt: this.now(),
    });
    this.store.replace(state);
    return state;
  }

  complete(workflowId: string): WorkflowState {
    return this.transition(workflowId, "completed");
  }

  fail(
    workflowId: string,
    error: { readonly code: string; readonly message: string },
  ): WorkflowState {
    return this.transition(workflowId, "failed", { error });
  }

  abort(workflowId: string): WorkflowState {
    const state = this.transition(workflowId, "aborted", { pendingPermission: null, pauseRequested: false });
    return state;
  }

  requestPause(workflowId: string): WorkflowState {
    const current = this.store.require(workflowId);
    if (!["running", "executing", "validating", "reviewing", "repairing"].includes(current.status)) {
      throw new WorkflowStateError("invalid_workflow_transition", `Cannot pause workflow in ${current.status}`);
    }
    const state = Object.freeze({ ...current, pauseRequested: true, updatedAt: this.now() });
    this.store.replace(state);
    this.events.emit("workflow.pause_requested", { workflowId });
    return state;
  }

  pause(workflowId: string): WorkflowState {
    const current = this.store.require(workflowId);
    const state = this.transition(workflowId, "paused", { pauseRequested: false });
    this.events.emit("workflow.paused", { workflowId });
    return state;
  }

  resume(workflowId: string): WorkflowState {
    const current = this.store.require(workflowId);
    const state = this.transition(workflowId, "running", { pauseRequested: false });
    this.events.emit("workflow.resumed", { workflowId });
    return state;
  }

  setPendingPermission(workflowId: string, permission: PendingWorkflowPermission): WorkflowState {
    const current = this.store.require(workflowId);
    const state = Object.freeze({ ...current, pendingPermission: permission, updatedAt: this.now() });
    this.store.replace(state);
    return state;
  }

  clearPendingPermission(workflowId: string): WorkflowState {
    const current = this.store.require(workflowId);
    const { pendingPermission: _pending, ...rest } = current;
    const state = Object.freeze({ ...rest, updatedAt: this.now() });
    this.store.replace(state);
    return state;
  }

  emitPermissionRequested(permission: PendingWorkflowPermission): void {
    this.events.emit("workflow.permission_requested", {
      workflowId: permission.workflowId,
      taskId: permission.taskId,
      permissionRequestId: permission.id,
      capability: permission.capability,
      ...(permission.resource ? { resource: permission.resource } : {}),
    });
  }

  taskStarted(workflowId: string, taskId: string, attempt: number): void {
    this.recordTask(workflowId, {
      taskId,
      executionStatus: "running",
      attempts: attempt,
    });
    this.events.emit("workflow.task_started", { workflowId, taskId, attempt });
  }

  taskCompleted(workflowId: string, taskId: string, attempt: number): void {
    this.recordTask(workflowId, {
      taskId,
      executionStatus: "completed",
      attempts: attempt,
    });
    this.events.emit("workflow.task_completed", { workflowId, taskId, attempt });
  }

  taskFailed(
    workflowId: string,
    taskId: string,
    code: string,
    attempt: number,
  ): void {
    this.recordTask(workflowId, {
      taskId,
      executionStatus: "failed",
      attempts: attempt,
    });
    this.events.emit("workflow.task_failed", {
      workflowId,
      taskId,
      attempt,
      code,
    });
  }

  /** Summary-only task rollup; evidence payloads never enter workflow state. */
  recordTask(workflowId: string, patch: WorkflowTaskRecord): void {
    this.store.recordTask(workflowId, patch);
  }

  snapshot(workflowId: string): WorkflowSnapshot {
    const state = this.store.require(workflowId);
    return Object.freeze({
      workflowId: state.id,
      status: state.status,
      tasks: this.store
        .tasks(workflowId)
        .map((task) => Object.freeze({ ...task })),
      startedAt: state.createdAt,
      updatedAt: state.updatedAt,
      ...(state.planId ? { planId: state.planId } : {}),
      ...(state.currentTaskId ? { currentTaskId: state.currentTaskId } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(state.progress ? { progress: state.progress } : {}),
      ...(state.failedTaskId ? { failedTaskId: state.failedTaskId } : {}),
      ...(state.blockedTaskIds ? { blockedTaskIds: state.blockedTaskIds } : {}),
      ...(state.pauseRequested ? { pauseRequested: true } : {}),
      ...(state.pendingPermission ? { pendingPermission: state.pendingPermission } : {}),
    });
  }

  private emitTerminal(state: WorkflowState): void {
    if (state.status === "completed") {
      this.events.emit("workflow.completed", {
        workflowId: state.id,
        taskCount: this.store.tasks(state.id).length,
      });
    } else if (state.status === "failed") {
      this.events.emit("workflow.failed", {
        workflowId: state.id,
        code: state.error?.code ?? "workflow_error",
        message: state.error?.message ?? "Workflow failed",
      });
    } else if (state.status === "aborted") {
      this.events.emit("workflow.aborted", { workflowId: state.id });
    }
  }
}
