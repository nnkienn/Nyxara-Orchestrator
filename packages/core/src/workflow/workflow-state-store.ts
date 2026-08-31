import { isTerminalWorkflowStatus, type WorkflowState } from "@nyxara/shared";
import { WorkflowStateError } from "./workflow.errors.js";
import type { WorkflowLimits, WorkflowTaskRecord } from "./workflow.types.js";

interface WorkflowRecord {
  state: WorkflowState;
  readonly tasks: Map<string, WorkflowTaskRecord>;
}

/**
 * Bounded in-memory home for workflow summaries. Terminal workflows are evicted
 * before active ones so a long session cannot drop the workflow currently being
 * executed.
 */
export class WorkflowStateStore {
  private readonly records = new Map<string, WorkflowRecord>();

  constructor(private readonly limits: WorkflowLimits) {}

  create(state: WorkflowState): void {
    this.records.set(state.id, { state, tasks: new Map() });
    this.evictWorkflows();
  }

  has(workflowId: string): boolean {
    return this.records.has(workflowId);
  }

  get(workflowId: string): WorkflowState | undefined {
    return this.records.get(workflowId)?.state;
  }

  require(workflowId: string): WorkflowState {
    return this.requireRecord(workflowId).state;
  }

  replace(state: WorkflowState): void {
    this.requireRecord(state.id).state = state;
  }

  recordTask(workflowId: string, patch: WorkflowTaskRecord): WorkflowTaskRecord {
    const record = this.requireRecord(workflowId);
    const current = record.tasks.get(patch.taskId);
    const merged: WorkflowTaskRecord = { ...current, ...patch };
    record.tasks.delete(patch.taskId);
    record.tasks.set(patch.taskId, merged);
    while (record.tasks.size > this.limits.maxTasksPerWorkflow) {
      const oldest = record.tasks.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === patch.taskId) break;
      record.tasks.delete(oldest);
    }
    return merged;
  }

  tasks(workflowId: string): WorkflowTaskRecord[] {
    return [...this.requireRecord(workflowId).tasks.values()];
  }

  list(): WorkflowState[] {
    return [...this.records.values()].map((record) => record.state);
  }

  get size(): number {
    return this.records.size;
  }

  private requireRecord(workflowId: string): WorkflowRecord {
    const record = this.records.get(workflowId);
    if (!record) {
      throw new WorkflowStateError(
        "workflow_not_found",
        `Unknown workflow: ${workflowId}`,
      );
    }
    return record;
  }

  private evictWorkflows(): void {
    while (this.records.size > this.limits.maxWorkflows) {
      const victim = this.nextEvictionCandidate();
      if (victim === undefined) break;
      this.records.delete(victim);
    }
  }

  private nextEvictionCandidate(): string | undefined {
    let fallback: string | undefined;
    for (const [id, record] of this.records) {
      if (isTerminalWorkflowStatus(record.state.status)) return id;
      fallback ??= id;
    }
    return fallback;
  }
}
