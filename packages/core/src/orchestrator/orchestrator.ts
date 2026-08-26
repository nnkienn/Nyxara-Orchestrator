import type { WorkflowState } from "@nyxara/shared";
import { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { RunInput } from "./orchestrator.types.js";

export class NyxaraOrchestrator {
  readonly events = new EventBus<NyxaraEventMap>();

  private readonly workflowEngine = new WorkflowEngine(this.events);

  async run(input: RunInput): Promise<WorkflowState> {
    return this.workflowEngine.run(input);
  }
}

