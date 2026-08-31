import type { ExecutionPlan } from "./planner.types.js";
import { PlanValidator } from "./plan-validator.js";
import {
  assertApprovedPlanIntegrity,
  planFingerprint,
  type PlanApprovalRecord,
  type PlanRuntimeState,
  type PlanStatus,
} from "./plan-runtime.js";

export type PlanRuntimeErrorCode =
  | "plan_not_found" | "plan_not_awaiting_approval" | "plan_already_approved"
  | "plan_rejected" | "plan_changed_after_approval" | "invalid_plan_state"
  | "plan_workflow_mismatch" | "workspace_changed_during_pause";

export class PlanRuntimeError extends Error {
  constructor(readonly code: PlanRuntimeErrorCode, message: string = code) {
    super(message);
    this.name = "PlanRuntimeError";
  }
}

interface PlanRecord {
  readonly plan: ExecutionPlan;
  readonly workflowId?: string;
  state: PlanRuntimeState;
}

export class PlanRuntimeStore {
  private readonly records = new Map<string, PlanRecord>();
  private readonly validator = new PlanValidator();

  register(plan: ExecutionPlan, workflowId?: string): PlanRuntimeState {
    this.validator.validate(plan);
    const existing = this.records.get(plan.id);
    if (existing && existing.workflowId !== workflowId) {
      throw new PlanRuntimeError("plan_workflow_mismatch");
    }
    if (existing && existing.state.status !== "draft") {
      throw new PlanRuntimeError("invalid_plan_state");
    }
    const state: PlanRuntimeState = Object.freeze({
      planId: plan.id,
      status: "draft" as const,
      createdAt: plan.createdAt,
    });
    this.records.set(plan.id, { plan, ...(workflowId ? { workflowId } : {}), state });
    return state;
  }

  get(planId: string): PlanRuntimeState {
    const record = this.records.get(planId);
    if (!record) throw new PlanRuntimeError("plan_not_found", `Unknown plan: ${planId}`);
    return record.state;
  }

  has(planId: string): boolean {
    return this.records.has(planId);
  }

  getPlan(planId: string): ExecutionPlan {
    const record = this.records.get(planId);
    if (!record) throw new PlanRuntimeError("plan_not_found", `Unknown plan: ${planId}`);
    return record.plan;
  }

  workflowId(planId: string): string | undefined {
    return this.records.get(planId)?.workflowId;
  }

  replaceDraft(plan: ExecutionPlan, workflowId?: string): PlanRuntimeState {
    const existing = this.records.get(plan.id);
    if (existing && existing.state.status !== "draft") {
      throw new PlanRuntimeError("invalid_plan_state", "Approved or rejected plans cannot be replaced");
    }
    return this.register(plan, workflowId ?? existing?.workflowId);
  }

  approve(planId: string, approvedAt: string): PlanRuntimeState {
    const record = this.records.get(planId);
    if (!record) throw new PlanRuntimeError("plan_not_found", `Unknown plan: ${planId}`);
    if (record.state.status !== "draft") {
      throw new PlanRuntimeError(record.state.status === "approved" ? "plan_already_approved" : "plan_rejected");
    }
    this.validator.validate(record.plan);
    const approval: PlanApprovalRecord = Object.freeze({
      planId,
      approvedBy: "user",
      approvedAt,
      taskCount: record.plan.tasks.length,
      planFingerprint: planFingerprint(record.plan),
    });
    record.state = Object.freeze({ ...record.state, status: "approved", approvedAt, approval });
    return record.state;
  }

  reject(planId: string, rejectedAt: string): PlanRuntimeState {
    const record = this.records.get(planId);
    if (!record) throw new PlanRuntimeError("plan_not_found", `Unknown plan: ${planId}`);
    if (record.state.status === "approved") throw new PlanRuntimeError("plan_already_approved");
    if (record.state.status === "rejected") throw new PlanRuntimeError("plan_rejected");
    record.state = Object.freeze({ ...record.state, status: "rejected", rejectedAt });
    return record.state;
  }

  assertExecutable(plan: ExecutionPlan): void {
    const record = this.records.get(plan.id);
    if (!record) return;
    if (record.state.status === "draft") throw new PlanRuntimeError("plan_not_awaiting_approval");
    if (record.state.status === "rejected") throw new PlanRuntimeError("plan_rejected");
    assertApprovedPlanIntegrity(record.state, plan);
  }

  assertIntegrity(planId: string, plan: ExecutionPlan): void {
    const record = this.records.get(planId);
    if (!record) throw new PlanRuntimeError("plan_not_found");
    assertApprovedPlanIntegrity(record.state, plan);
  }
}

export type { PlanApprovalRecord, PlanRuntimeState, PlanStatus } from "./plan-runtime.js";
export { planFingerprint, assertApprovedPlanIntegrity } from "./plan-runtime.js";
