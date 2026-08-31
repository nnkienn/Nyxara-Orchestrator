import { createHash } from "node:crypto";
import type { ExecutionPlan } from "./planner.types.js";

export type PlanStatus = "draft" | "approved" | "rejected";

export interface PlanApprovalRecord {
  readonly planId: string;
  readonly approvedBy: "user";
  readonly approvedAt: string;
  readonly taskCount: number;
  readonly planFingerprint: string;
}

export interface PlanRuntimeState {
  readonly planId: string;
  readonly status: PlanStatus;
  readonly createdAt: string;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly approval?: PlanApprovalRecord;
}

export function planFingerprint(plan: ExecutionPlan): string {
  const relevant = {
    objective: plan.objective,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      dependencies: [...task.dependencies],
      acceptanceCriteria: [...task.acceptanceCriteria],
      ...(task.relevantFiles ? { relevantFiles: [...task.relevantFiles] } : {}),
    })),
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

export function assertApprovedPlanIntegrity(
  runtime: PlanRuntimeState,
  plan: ExecutionPlan,
): void {
  if (runtime.status !== "approved") return;
  if (runtime.approval?.planFingerprint !== planFingerprint(plan)) {
    throw Object.assign(new Error("plan_changed_after_approval"), {
      code: "plan_changed_after_approval" as const,
    });
  }
}
