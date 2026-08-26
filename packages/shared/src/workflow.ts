export type WorkflowStatus =
  | "created"
  | "analyzing"
  | "completed"
  | "failed";

export interface WorkflowFailure {
  readonly message: string;
}

export interface WorkflowState {
  readonly id: string;
  readonly workspace: string;
  readonly prompt: string;
  readonly status: WorkflowStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: WorkflowFailure;
}

