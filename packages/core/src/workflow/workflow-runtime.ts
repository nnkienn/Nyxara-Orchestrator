import type { ContextBundle } from "../context/context.types.js";
import type { ExecutionPlan } from "../planner/planner.types.js";
import type { TaskGraph } from "../planner/task-graph.js";
import type { AutonomousWorkflowResult, WorkflowRunOutcome } from "../orchestrator/orchestrator.types.js";

export interface WorkflowRuntime {
  readonly workflowId: string;
  readonly planId: string;
  readonly plan: ExecutionPlan;
  readonly graph: TaskGraph;
  readonly plannerContext?: ContextBundle;
  readonly completed: Set<string>;
  readonly failed: string[];
  readonly blocked: string[];
  readonly changed: Set<string>;
  repairCycles: number;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly allowRepair: boolean;
  readonly abortController: AbortController;
  readonly subscribers: Set<(outcome: WorkflowRunOutcome) => void>;
  pauseGate?: { readonly promise: Promise<void>; readonly release: () => void };
  permissionGate?: { readonly requestId: string; readonly resolve: (decision: "allow" | "deny") => void };
  pausedWorkspaceFingerprint?: string;
  terminalResult?: AutonomousWorkflowResult;
  advancing?: Promise<void>;
}

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
