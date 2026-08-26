import type {
  ModelConversationMessage,
  ModelInfo,
  ModelToolCall,
  ModelToolResult,
} from "@nyxara/provider-sdk";
import {
  NyxaraToolError,
  ToolRegistryError,
  type GitDiffResult,
  type GitStatusResult,
  type ToolContext,
  type ToolRegistry,
} from "@nyxara/tools";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { ExecutorError } from "./executor-error.js";
import { ExecutorPromptBuilder } from "./executor-prompt-builder.js";
import {
  EXECUTOR_TOOL_DEFINITIONS,
  EXECUTOR_TOOL_NAMES,
} from "./executor-tools.js";
import {
  ExecutionDecisionSchema,
  type ExecutionDecision,
  type ExecutionResult,
  type ExecutorLimits,
  type ExecutorRunInput,
  type ExecutorToolOutcome,
} from "./executor.types.js";

const DEFAULT_LIMITS: ExecutorLimits = {
  maxToolCallsPerTask: 25,
  maxModelTurnsPerTask: 8,
  maxToolResultBytes: 64 * 1024,
};

export class Executor {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly promptBuilder = new ExecutorPromptBuilder(),
  ) {}

  async run(runInput: ExecutorRunInput): Promise<ExecutionResult> {
    const { input, model } = runInput;
    const limits = resolveLimits(runInput.limits);
    this.events.emit("executor.started", {
      taskId: input.task.id,
      providerId: model.providerId,
      modelId: model.modelId,
      attempt: input.attempt,
      contextFileCount: input.context.files.length,
    });

    try {
      const provider = this.providers.get(model.providerId);
      const selectedModel = this.requireModel(
        await provider.listModels(),
        model.modelId,
      );
      if (
        !selectedModel.capabilities?.tools &&
        !provider.capabilities().toolCalling
      ) {
        throw new ExecutorError(
          "unsupported_tool_calling",
          `Executor model does not support native tool calling: ${model.modelId}`,
        );
      }

      const context = toolContext(input.workspaceRoot, input.signal);
      const [initialStatus, initialDiff] = await Promise.all([
        this.tools.execute<Record<string, never>, GitStatusResult>(
          "git_status",
          {},
          context,
        ),
        this.tools.execute<{ maxBytes: number }, GitDiffResult>(
          "git_diff",
          { maxBytes: 256 * 1024 },
          context,
        ),
      ]);
      if (!initialStatus.isRepository || !initialDiff.isRepository) {
        throw new ExecutorError(
          "executor_error",
          "Executor requires a Git repository for change evidence",
        );
      }

      const prompt = this.promptBuilder.build(
        input,
        EXECUTOR_TOOL_DEFINITIONS,
      );
      const conversation: ModelConversationMessage[] = [];
      const callIds = new Set<string>();
      const changedPaths = new Set<string>();
      const unresolvedToolErrors = new Map<string, string>();
      let toolCallCount = 0;

      for (let modelTurn = 1; modelTurn <= limits.maxModelTurnsPerTask; modelTurn += 1) {
        const response = await provider.generate({
          model: selectedModel.id,
          prompt,
          tools: EXECUTOR_TOOL_DEFINITIONS,
          ...(conversation.length > 0 ? { conversation } : {}),
          ...(selectedModel.capabilities?.structuredOutput ||
          provider.capabilities().structuredOutput
            ? { responseFormat: "json" as const }
            : {}),
        });
        const requestedCalls = response.toolCalls ?? [];

        if (requestedCalls.length === 0) {
          const modelDecision = this.parseDecision(response.text);
          const decision: ExecutionDecision =
            modelDecision.status === "completed" && unresolvedToolErrors.size > 0
              ? {
                  status: "failed",
                  summary: "Executor stopped with unresolved tool failures",
                  unresolvedIssues: [
                    ...(modelDecision.unresolvedIssues ?? []),
                    ...[...unresolvedToolErrors].map(
                      ([tool, code]) => `${tool} failed with ${code}`,
                    ),
                  ],
                }
              : modelDecision;
          const result = await this.buildResult({
            decision,
            taskId: input.task.id,
            context,
            initialStatus,
            initialDiff,
            changedPaths,
            toolCallCount,
            modelTurns: modelTurn,
          });
          if (result.status === "completed") {
            this.events.emit("executor.completed", {
              taskId: input.task.id,
              providerId: model.providerId,
              modelId: model.modelId,
              changedFileCount: result.changedFiles.length,
              toolCalls: result.toolCalls,
              modelTurns: result.modelTurns,
            });
          } else {
            this.events.emit("executor.failed", {
              taskId: input.task.id,
              providerId: model.providerId,
              modelId: model.modelId,
              code: "executor_error",
            });
          }
          return result;
        }

        if (toolCallCount + requestedCalls.length > limits.maxToolCallsPerTask) {
          throw new ExecutorError(
            "tool_call_limit_exceeded",
            "Executor exceeded the tool-call limit for this task",
          );
        }
        if (modelTurn === limits.maxModelTurnsPerTask) {
          throw new ExecutorError(
            "model_turn_limit_exceeded",
            "Executor cannot perform another tool round within the model-turn limit",
          );
        }
        for (const call of requestedCalls) {
          if (callIds.has(call.id)) {
            throw new ExecutorError(
              "executor_error",
              `Executor returned a duplicate tool-call ID: ${call.id}`,
            );
          }
          callIds.add(call.id);
        }

        conversation.push({
          role: "assistant",
          ...(response.text ? { content: response.text } : {}),
          toolCalls: requestedCalls,
        });
        for (const call of requestedCalls) {
          toolCallCount += 1;
          const outcome = await this.executeToolCall(
            call,
            context,
            limits.maxToolResultBytes,
          );
          if (outcome.result.error) {
            unresolvedToolErrors.set(call.name, outcome.result.error.code);
          } else {
            unresolvedToolErrors.delete(call.name);
          }
          outcome.changedPaths.forEach((path) => changedPaths.add(path));
          conversation.push({ role: "tool", toolResult: outcome.result });
        }
      }

      throw new ExecutorError(
        "model_turn_limit_exceeded",
        "Executor exceeded the model-turn limit for this task",
      );
    } catch (error: unknown) {
      this.events.emit("executor.failed", {
        taskId: runInput.input.task.id,
        providerId: runInput.model.providerId,
        modelId: runInput.model.modelId,
        code: executorErrorCode(error),
      });
      throw error;
    }
  }

  private requireModel(
    models: readonly ModelInfo[],
    modelId: string,
  ): ModelInfo {
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new ExecutorError(
        "invalid_model",
        `Executor model is not available: ${modelId}`,
      );
    }
    return model;
  }

  private async executeToolCall(
    call: ModelToolCall,
    context: ToolContext,
    maxResultBytes: number,
  ): Promise<ExecutorToolOutcome> {
    if (!EXECUTOR_TOOL_NAMES.has(call.name)) {
      throw new ExecutorError(
        "executor_error",
        `Executor requested a tool that is not allowed: ${call.name}`,
      );
    }
    if (!isRecord(call.arguments)) {
      throw new ExecutorError(
        "executor_error",
        `Executor tool arguments must be an object: ${call.name}`,
      );
    }

    try {
      const output = await this.tools.execute<Record<string, unknown>, unknown>(
        call.name,
        call.arguments,
        context,
      );
      return {
        result: {
          callId: call.id,
          name: call.name,
          result: boundToolResult(output, maxResultBytes),
        },
        changedPaths: extractChangedPaths(output),
      };
    } catch (error: unknown) {
      if (error instanceof ToolRegistryError) {
        throw new ExecutorError("executor_error", "Executor requested an unknown tool");
      }
      if (error instanceof NyxaraToolError && isSecurityError(error.code)) {
        const isWriteRequest = ["write_file", "apply_patch"].includes(call.name);
        throw new ExecutorError(
          isWriteRequest
            ? "write_permission_denied"
            : "executor_error",
          `Executor tool request was denied: ${call.name}`,
        );
      }

      const code =
        error instanceof NyxaraToolError ? error.code : "tool_error";
      const result: ModelToolResult = {
        callId: call.id,
        name: call.name,
        error: {
          code,
          message:
            error instanceof NyxaraToolError
              ? error.message
              : "Tool execution failed",
        },
      };
      return { result, changedPaths: [] };
    }
  }

  private parseDecision(text: string): ExecutionDecision {
    const normalized = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      const result = ExecutionDecisionSchema.safeParse(JSON.parse(normalized));
      if (result.success) return result.data;
    } catch {
      // Converted to a controlled error below.
    }
    throw new ExecutorError(
      "invalid_execution_result",
      "Executor returned an invalid structured result",
    );
  }

  private async buildResult(input: {
    readonly decision: ExecutionDecision;
    readonly taskId: string;
    readonly context: ToolContext;
    readonly initialStatus: GitStatusResult;
    readonly initialDiff: GitDiffResult;
    readonly changedPaths: ReadonlySet<string>;
    readonly toolCallCount: number;
    readonly modelTurns: number;
  }): Promise<ExecutionResult> {
    const [finalStatus, diff] = await Promise.all([
      this.tools.execute<Record<string, never>, GitStatusResult>(
        "git_status",
        {},
        input.context,
      ),
      this.tools.execute<{ maxBytes: number }, GitDiffResult>(
        "git_diff",
        { maxBytes: 256 * 1024 },
        input.context,
      ),
    ]);
    if (!finalStatus.isRepository || !diff.isRepository) {
      throw new ExecutorError(
        "executor_error",
        "Git evidence became unavailable during execution",
      );
    }

    const evidencePaths = new Set([
      ...finalStatus.files.map((file) => file.path),
      ...diff.files,
    ]);
    const changedFiles = [...input.changedPaths]
      .filter((path) => evidencePaths.has(path))
      .sort();
    const unexpected = changedStatusPaths(input.initialStatus, finalStatus).filter(
      (path) => !input.changedPaths.has(path),
    );
    if (unexpected.length > 0) {
      throw new ExecutorError(
        "workspace_modified_unexpectedly",
        `Workspace changed outside Executor tools: ${unexpected.join(", ")}`,
      );
    }

    return {
      taskId: input.taskId,
      status: input.decision.status,
      summary: input.decision.summary,
      changedFiles,
      toolCalls: input.toolCallCount,
      modelTurns: input.modelTurns,
      ...(input.decision.unresolvedIssues
        ? { unresolvedIssues: input.decision.unresolvedIssues }
        : {}),
      diff: { files: diff.files, truncated: diff.truncated },
      git: {
        initialStatus: input.initialStatus,
        finalStatus,
        diff,
        initialDiffFiles: input.initialDiff.files,
      },
    };
  }
}

function resolveLimits(input: Partial<ExecutorLimits> | undefined): ExecutorLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (
    !Number.isInteger(limits.maxToolCallsPerTask) ||
    limits.maxToolCallsPerTask <= 0 ||
    !Number.isInteger(limits.maxModelTurnsPerTask) ||
    limits.maxModelTurnsPerTask <= 0 ||
    !Number.isInteger(limits.maxToolResultBytes) ||
    limits.maxToolResultBytes <= 0
  ) {
    throw new ExecutorError("executor_error", "Executor limits are invalid");
  }
  return limits;
}

function toolContext(workspaceRoot: string, signal?: AbortSignal): ToolContext {
  return { workspaceRoot, ...(signal ? { signal } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundToolResult(value: unknown, maxBytes: number): unknown {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return value;
  return {
    truncated: true,
    preview: Buffer.from(serialized, "utf8").subarray(0, maxBytes).toString("utf8"),
  };
}

function extractChangedPaths(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (typeof value.path === "string" && typeof value.bytesWritten === "number") {
    return [value.path];
  }
  if (Array.isArray(value.filesChanged)) {
    return value.filesChanged.filter(
      (path): path is string => typeof path === "string",
    );
  }
  return [];
}

function changedStatusPaths(
  initial: GitStatusResult,
  final: GitStatusResult,
): string[] {
  const initialState = new Map(
    initial.files.map((file) => [
      file.path,
      `${file.status}:${file.indexStatus}:${file.worktreeStatus}`,
    ]),
  );
  const finalState = new Map(
    final.files.map((file) => [
      file.path,
      `${file.status}:${file.indexStatus}:${file.worktreeStatus}`,
    ]),
  );
  return [...new Set([...initialState.keys(), ...finalState.keys()])].filter(
    (path) => initialState.get(path) !== finalState.get(path),
  );
}

function isSecurityError(code: string): boolean {
  return [
    "permission_error",
    "permission_required",
    "write_permission_denied",
    "path_outside_workspace",
    "command_blocked",
  ].includes(code);
}

function executorErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "executor_error";
}
