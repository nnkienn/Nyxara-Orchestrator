import type { ModelToolResult } from "@nyxara/provider-sdk";
import type { GitDiffResult, GitStatusResult, PermissionRequest } from "@nyxara/tools";
import { z } from "zod";
import type { AgentModelConfig } from "../agents/agent.types.js";
import type { ContextBundle } from "../context/context.types.js";
import type { ContextBudget } from "../context/context.types.js";
import type {
  ExecutionPlan,
  PlannedTask,
} from "../planner/planner.types.js";
import type { RepairEvidence, RepairTask } from "../repair/repair.types.js";

export type TaskExecutionStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface ExecutorInput {
  readonly task: PlannedTask;
  readonly objective: string;
  readonly workspaceRoot: string;
  readonly context: ContextBundle;
  readonly attempt: number;
  readonly signal?: AbortSignal;
  readonly resolvePermission?: (request: PermissionRequest) => Promise<"allow" | "deny">;
  readonly checkpoint?: () => Promise<void>;
}

export interface ExecutorLimits {
  readonly maxToolCallsPerTask: number;
  readonly maxModelTurnsPerTask: number;
  readonly maxToolResultBytes: number;
}

export interface ExecutorRunInput {
  readonly input: ExecutorInput;
  readonly model: AgentModelConfig;
  readonly limits?: Partial<ExecutorLimits>;
  readonly workflowId?: string;
}

export interface RepairExecutorInput {
  readonly originalTask: PlannedTask;
  readonly repairTask: RepairTask;
  readonly workspaceRoot: string;
  readonly context: ContextBundle;
  readonly evidence: RepairEvidence;
  readonly attempt: number;
  readonly signal?: AbortSignal;
  readonly resolvePermission?: (request: PermissionRequest) => Promise<"allow" | "deny">;
  readonly checkpoint?: () => Promise<void>;
}

export interface RepairExecutorRunInput {
  readonly input: RepairExecutorInput;
  readonly model: AgentModelConfig;
  readonly limits?: Partial<ExecutorLimits>;
  readonly workflowId?: string;
}

export interface ExecutionGitEvidence {
  readonly initialStatus: GitStatusResult;
  readonly finalStatus: GitStatusResult;
  readonly diff: GitDiffResult;
  readonly initialDiffFiles: readonly string[];
}

export interface ExecutionResult {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly toolCalls: number;
  readonly toolDurationMs?: number;
  /** Model-requested tool calls, with execution outcome semantics. */
  readonly successfulToolCalls?: number;
  readonly failedToolCalls?: number;
  readonly invalidToolCalls?: number;
  readonly toolCallsByName?: Readonly<Record<string, number>>;
  readonly modelTurns: number;
  readonly unresolvedIssues?: readonly string[];
  readonly diff: {
    readonly files: readonly string[];
    readonly truncated: boolean;
  };
  readonly git: ExecutionGitEvidence;
}

/**
 * Compacted evidence retained after a task reaches a terminal result. Git
 * snapshots, raw diff text, and model conversations are intentionally absent.
 */
export interface TaskExecutionSummary {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly diffFiles: readonly string[];
  readonly diffTruncated: boolean;
  readonly toolCalls: number;
  readonly modelTurns: number;
  readonly unresolvedIssues?: readonly string[];
}

export interface TaskExecutionState {
  readonly taskId: string;
  readonly status: TaskExecutionStatus;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** Full result is retained only while the task is the most recent one. */
  readonly result?: ExecutionResult;
  readonly resultSummary?: TaskExecutionSummary;
}

export interface ExecuteTaskInput {
  readonly workflowId?: string;
  readonly plan: ExecutionPlan;
  readonly taskId: string;
  readonly workspaceRoot: string;
  /**
   * Bounded Planner context to reuse. When present the Executor filters it for
   * this task instead of rescanning the repository.
   */
  readonly plannerContext?: ContextBundle;
  readonly contextBudget?: Partial<ContextBudget>;
  readonly limits?: Partial<ExecutorLimits>;
  readonly signal?: AbortSignal;
  readonly resolvePermission?: (request: PermissionRequest) => Promise<"allow" | "deny">;
  readonly checkpoint?: () => Promise<void>;
}

export interface ExecuteTaskResult {
  readonly result: ExecutionResult;
  readonly state: TaskExecutionState;
  readonly context: ContextBundle;
  readonly model: AgentModelConfig;
  /** How the Executor context was obtained, for token-efficiency assertions. */
  readonly contextSource: "planner_reuse" | "targeted_expansion" | "build";
}

export interface ExecutorToolOutcome {
  readonly result: ModelToolResult;
  readonly changedPaths: readonly string[];
}

export const ExecutionDecisionSchema = z.object({
  status: z.enum(["completed", "failed"]),
  summary: z.string().trim().min(1),
  unresolvedIssues: z.array(z.string().trim().min(1)).optional(),
});

export type ExecutionDecision = Readonly<
  z.infer<typeof ExecutionDecisionSchema>
>;
