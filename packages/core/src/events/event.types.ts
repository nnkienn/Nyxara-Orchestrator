import type { WorkflowState } from "@nyxara/shared";

export interface WorkflowStartedEvent {
  readonly workflow: WorkflowState;
}

export interface WorkflowCompletedEvent {
  readonly workflow: WorkflowState;
}

export interface WorkflowFailedEvent {
  readonly workflow: WorkflowState | null;
  readonly error: {
    readonly message: string;
  };
}

export interface NyxaraEventMap {
  readonly "workflow.started": WorkflowStartedEvent;
  readonly "workflow.completed": WorkflowCompletedEvent;
  readonly "workflow.failed": WorkflowFailedEvent;
}

