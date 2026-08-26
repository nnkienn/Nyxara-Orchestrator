import { randomUUID } from "node:crypto";
import type { WorkflowState, WorkflowStatus } from "@nyxara/shared";
import { z } from "zod";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import type { RunInput } from "../orchestrator/orchestrator.types.js";

const runInputSchema = z.object({
  workspace: z.string().trim().min(1, "workspace is required"),
  prompt: z.string().trim().min(1, "prompt is required"),
});

const allowedTransitions: Readonly<
  Record<WorkflowStatus, readonly WorkflowStatus[]>
> = {
  created: ["analyzing", "failed"],
  analyzing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export class WorkflowEngine {
  constructor(private readonly events: EventBus<NyxaraEventMap>) {}

  async run(input: RunInput): Promise<WorkflowState> {
    let workflow: WorkflowState | null = null;

    try {
      const parsedInput = runInputSchema.parse(input);
      workflow = this.createWorkflow(parsedInput);
      workflow = this.transition(workflow, "analyzing");

      this.events.emit("workflow.started", { workflow });

      workflow = this.transition(workflow, "completed");
      this.events.emit("workflow.completed", { workflow });

      return workflow;
    } catch (error: unknown) {
      const message = this.errorMessage(error);

      if (workflow && workflow.status !== "completed") {
        workflow = this.transition(workflow, "failed", message);
      }

      this.events.emit("workflow.failed", {
        workflow,
        error: { message },
      });

      throw error;
    }
  }

  private createWorkflow(input: RunInput): WorkflowState {
    const now = new Date().toISOString();

    return Object.freeze({
      id: randomUUID(),
      workspace: input.workspace,
      prompt: input.prompt,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });
  }

  private transition(
    workflow: WorkflowState,
    nextStatus: WorkflowStatus,
    failureMessage?: string,
  ): WorkflowState {
    if (!allowedTransitions[workflow.status].includes(nextStatus)) {
      throw new Error(
        `Invalid workflow transition: ${workflow.status} -> ${nextStatus}`,
      );
    }

    return Object.freeze({
      ...workflow,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
      ...(failureMessage ? { failure: { message: failureMessage } } : {}),
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown workflow error";
  }
}

