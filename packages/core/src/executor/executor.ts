import {
  executionProfileSummary,
  type ModelConversationMessage,
  type ModelInfo,
  type ModelToolCall,
  type ModelToolResult,
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
import { EXECUTION_DIFF_MAX_BYTES } from "../internal/byte-limits.js";
import { errorCodeOr } from "../internal/error-code.js";
import { truncateUtf8 } from "../internal/text.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { ExecutorError } from "./executor-error.js";
import { ExecutorPromptBuilder } from "./executor-prompt-builder.js";
import {
  compactExecutorContext,
  estimateExecutorRequest,
  ExecutorSession,
  taskIsReadOnly,
  type ResolvedExecutorLimits,
} from "./executor-session.js";
import {
  EXECUTOR_TOOL_DEFINITIONS,
  EXECUTOR_TOOL_NAMES,
} from "./executor-tools.js";
import {
  ExecutionDecisionSchema,
  type ExecutionDecision,
  type ExecutionResult,
  type ExecutorContextMetrics,
  type ExecutorLimits,
  type ExecutorRunInput,
  type ExecutorToolOutcome,
  type ExecutorToolCategory,
  type RepairExecutorInput,
  type RepairExecutorRunInput,
} from "./executor.types.js";

const DEFAULT_LIMITS: ResolvedExecutorLimits = {
  maxToolCallsPerTask: 96,
  maxReadToolCallsPerTask: 72,
  maxMutatingToolCallsPerTask: 16,
  maxValidationToolCallsPerTask: 12,
  maxProviderCallsPerTask: 16,
  maxToolResultBytes: 24 * 1024,
  maxRetainedEvidenceBytes: 64 * 1024,
  maxExecutorContextBytes: 192 * 1024,
  maxEstimatedInputTokens: 48 * 1024,
  maxConsecutiveNoProgressToolCalls: 6,
  maxNoProgressModelTurns: 3,
};

export class Executor {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly promptBuilder = new ExecutorPromptBuilder(),
  ) {}

  async run(runInput: ExecutorRunInput): Promise<ExecutionResult> {
    return this.runInternal(runInput);
  }

  /**
   * Bounded repair turn for an already-executed task. The Executor is reused as
   * is: same tools, same permissions, same limits. Only the prompt and the
   * bounded failure evidence change.
   */
  async executeRepair(
    runInput: RepairExecutorRunInput,
  ): Promise<ExecutionResult> {
    return this.runInternal(
      {
        input: {
          task: runInput.input.originalTask,
          objective: runInput.input.repairTask.objective,
          workspaceRoot: runInput.input.workspaceRoot,
          context: runInput.input.context,
          attempt: runInput.input.attempt,
          ...(runInput.input.engineeringRules ? { engineeringRules: runInput.input.engineeringRules } : {}),
          ...(runInput.input.signal ? { signal: runInput.input.signal } : {}),
          ...(runInput.input.resolvePermission ? { resolvePermission: runInput.input.resolvePermission } : {}),
          ...(runInput.input.checkpoint ? { checkpoint: runInput.input.checkpoint } : {}),
        },
        model: runInput.model,
        ...(runInput.limits ? { limits: runInput.limits } : {}),
        ...(runInput.workflowId ? { workflowId: runInput.workflowId } : {}),
      },
      runInput.input,
    );
  }

  private async runInternal(
    runInput: ExecutorRunInput,
    repairInput?: RepairExecutorInput,
  ): Promise<ExecutionResult> {
    const { input, model } = runInput;
    const limits = resolveLimits(runInput.limits);
    this.events.emit("executor.started", {
      taskId: input.task.id,
      providerId: model.providerId,
      modelId: model.modelId,
      attempt: input.attempt,
      contextFileCount: input.context.files.length,
    });

    let phase: "model_resolution" | "generation" | "tools" | "response" = "model_resolution";
    const changedPaths = new Set<string>();
    let toolCallCount = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let invalidToolCalls = 0;
    let toolDurationMs = 0;
    const toolCallsByName: Record<string, number> = {};
    const session = new ExecutorSession(input.context, limits);
    const readOnly = !repairInput && taskIsReadOnly(input.task);
    try {
      const provider = this.providers.get(model.providerId);
      const selectedModel = this.requireModel(
        await this.providers.resolveModel(model.providerId, model.modelId, model.executionOptions),
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

      phase = "tools";
      const context = toolContext(input.workspaceRoot, input.signal, input.resolvePermission);
      const [initialStatus, initialDiff] = await Promise.all([
        this.tools.execute<Record<string, never>, GitStatusResult>(
          "git_status",
          {},
          context,
        ),
        this.tools.execute<{ maxBytes: number }, GitDiffResult>(
          "git_diff",
          { maxBytes: EXECUTION_DIFF_MAX_BYTES },
          context,
        ),
      ]);
      if (!initialStatus.isRepository || !initialDiff.isRepository) {
        throw new ExecutorError(
          "executor_error",
          "Executor requires a Git repository for change evidence",
        );
      }

      let executorContext = input.context;
      let latestExchange: ModelConversationMessage[] | undefined;
      let latestEvidenceKeys = new Set<string>();
      const unresolvedToolErrors = new Map<string, { tool: string; code: string }>();

      for (let modelTurn = 1; modelTurn <= limits.maxProviderCallsPerTask; modelTurn += 1) {
        await input.checkpoint?.();
        if (input.signal?.aborted) {
          throw new ExecutorError("executor_aborted", "Executor run was aborted");
        }
        session.assertProviderCallAvailable();
        let prompt = "";
        let requestSize = { bytes: 0, tokens: 0 };
        while (true) {
          const promptState = {
            executionState: session.stateSummary(changedPaths.size > 0, readOnly),
            retainedEvidence: session.evidence(latestEvidenceKeys),
            readOnly,
          };
          prompt = repairInput
            ? this.promptBuilder.buildRepair(repairInput, EXECUTOR_TOOL_DEFINITIONS, promptState)
            : this.promptBuilder.build({ ...input, context: executorContext }, EXECUTOR_TOOL_DEFINITIONS, promptState);
          requestSize = estimateExecutorRequest({
            model: selectedModel.id,
            prompt,
            tools: EXECUTOR_TOOL_DEFINITIONS,
            ...(latestExchange ? { conversation: compactConversation(latestExchange) } : {}),
            ...(model.executionOptions ? { executionOptions: model.executionOptions } : {}),
            responseFormat: selectedModel.capabilities?.structuredOutput || provider.capabilities().structuredOutput ? "json" : undefined,
          });
          if (
            requestSize.bytes <= limits.maxExecutorContextBytes &&
            requestSize.tokens <= limits.maxEstimatedInputTokens
          ) break;
          if (session.dropOldestEvidence()) continue;
          const nextBytes = Math.max(4 * 1024, executorContext.totalBytes - Math.max(8 * 1024, requestSize.bytes - limits.maxExecutorContextBytes));
          const compacted = compactExecutorContext(executorContext, nextBytes);
          if (compacted.totalBytes >= executorContext.totalBytes) {
            throw new ExecutorError(
              "executor_context_limit_exceeded",
              "Executor request cannot fit the safe input budget after compacting optional evidence",
            );
          }
          executorContext = compacted;
        }
        session.recordProviderRequest(requestSize.bytes, requestSize.tokens);
        const providerStarted = performance.now();
        const streaming = provider.capabilities().progressStreaming === true;
        phase = "generation";
        const response = await provider.generate({
          model: selectedModel.id,
          prompt,
          tools: EXECUTOR_TOOL_DEFINITIONS,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(model.executionOptions ? { executionOptions: model.executionOptions } : {}),
          ...(latestExchange ? { conversation: compactConversation(latestExchange) } : {}),
          ...(streaming && runInput.workflowId ? { onProgress: (event) => this.events.emit("provider.generation.progress", {
            providerId: provider.providerId ?? provider.id,
            providerConfigId: model.providerId,
            modelId: selectedModel.id,
            role: repairInput ? "repair" : "executor",
            workflowId: runInput.workflowId!,
            taskId: input.task.id,
            phase: event.phase,
            ...(event.toolName ? { toolName: event.toolName } : {}),
            timestamp: new Date().toISOString(),
          }) } : {}),
          ...(selectedModel.capabilities?.structuredOutput ||
          provider.capabilities().structuredOutput
            ? { responseFormat: "json" as const }
            : {}),
        });
        phase = "response";
        // Provider wait is measured at the provider boundary and contains no
        // local tool or validation work.
        if (runInput.workflowId) this.events.emit("provider.generation.completed", {
          providerId: provider.providerId ?? provider.id,
          providerConfigId: model.providerId,
          modelId: response.model,
          requestedModelId: selectedModel.id,
          role: repairInput ? "repair" : "executor",
          taskId: input.task.id,
          ...(runInput.workflowId ? { workflowId: runInput.workflowId } : {}),
          providerDurationMs: Math.max(0, performance.now() - providerStarted),
          textLength: response.text.length,
          toolCallCount: response.toolCalls?.length ?? 0,
          executionProfileSummary: executionProfileSummary(model.executionOptions),
          contextFiles: session.metrics().executorContextFiles,
          contextBytes: requestSize.bytes,
          contextTruncated: executorContext.truncated || session.metrics().droppedEvidenceCount > 0,
          estimatedInputTokens: requestSize.tokens,
          droppedEvidenceCount: session.metrics().droppedEvidenceCount,
          duplicateEvidenceRemoved: session.metrics().duplicateEvidenceRemoved,
          ...(response.usage ? { usage: response.usage } : {}),
        });
        session.recordProviderUsage(response.usage?.inputTokens);
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
                    ...[...unresolvedToolErrors.values()].map(
                      ({ tool, code }) => `${tool} failed with ${code}`,
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
            toolDurationMs,
            modelTurns: modelTurn,
            successfulToolCalls,
            failedToolCalls,
            invalidToolCalls,
            toolCallsByName,
            toolCallsByCategory: session.counts(),
            contextMetrics: session.metrics(),
            readOnly,
            allowNoChange: Boolean(
              (!repairInput && input.task.executionMode !== "implementation") ||
              repairInput?.evidence.currentChangedFiles.length ||
              (input.attempt > 1 && hasRelevantInitialChanges(input.task.relevantFiles, initialDiff.files)),
            ),
          });
          if (result.status === "completed") {
            this.events.emit("executor.completed", {
              taskId: input.task.id,
              providerId: model.providerId,
              modelId: model.modelId,
              changedFileCount: result.changedFiles.length,
              toolCalls: result.toolCalls,
              ...(result.toolDurationMs !== undefined ? { toolDurationMs: result.toolDurationMs } : {}),
              modelTurns: result.modelTurns,
              ...(runInput.workflowId ? { workflowId: runInput.workflowId, successfulToolCalls: result.successfulToolCalls, failedToolCalls: result.failedToolCalls, invalidToolCalls: result.invalidToolCalls, toolCallsByName: result.toolCallsByName } : {}),
              toolCallsByCategory: session.counts(),
              contextMetrics: session.metrics(),
            });
          } else {
            this.events.emit("executor.failed", {
              taskId: input.task.id,
              providerId: model.providerId,
              modelId: model.modelId,
              code: "executor_error",
              toolCalls: result.toolCalls,
              ...(result.toolDurationMs !== undefined ? { toolDurationMs: result.toolDurationMs } : {}),
              ...(runInput.workflowId ? { workflowId: runInput.workflowId, successfulToolCalls: result.successfulToolCalls, failedToolCalls: result.failedToolCalls, invalidToolCalls: result.invalidToolCalls, toolCallsByName: result.toolCallsByName } : {}),
              toolCallsByCategory: session.counts(),
              contextMetrics: session.metrics(),
            });
          }
          return result;
        }

        if (modelTurn === limits.maxProviderCallsPerTask) {
          throw new ExecutorError(
            runInput.limits?.maxModelTurnsPerTask !== undefined
              ? "model_turn_limit_exceeded"
              : "provider_call_limit_exceeded",
            "Executor cannot perform another tool round within the provider-call safety ceiling",
          );
        }
        phase = "tools";
        const roundCallIds = new Set<string>();
        for (const call of requestedCalls) {
          if (roundCallIds.has(call.id)) {
            throw new ExecutorError(
              "executor_error",
              `Executor returned a duplicate tool-call ID: ${call.id}`,
            );
          }
          roundCallIds.add(call.id);
        }

        const preparedCalls = session.prepareBatch(requestedCalls);
        if (readOnly && preparedCalls.some((item) => ["apply_patch", "write_file"].includes(item.call.name))) {
          throw new ExecutorError("executor_error", "Read-only Executor task requested a mutating tool");
        }
        const roundConversation: ModelConversationMessage[] = [{
          role: "assistant",
          ...(response.text ? { content: boundAssistantText(response.text) } : {}),
          toolCalls: preparedCalls.map((item) => compactHistoricalToolCall(item.call)),
        }];
        let roundProgress = false;
        const roundEvidenceKeys = new Set<string>();
        for (const prepared of preparedCalls) {
          const call = prepared.call;
          session.acceptRequest(prepared);
          toolCallCount += 1;
          toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
          if (!EXECUTOR_TOOL_NAMES.has(call.name) || !isRecord(call.arguments)) invalidToolCalls += 1;
          if (prepared.duplicateResult) {
            session.recordDuplicate();
            roundConversation.push({ role: "tool", toolResult: prepared.duplicateResult });
            continue;
          }
          const toolStarted = performance.now();
          const outcome = await this.executeToolCall(
            call,
            context,
            limits.maxToolResultBytes,
          );
          toolDurationMs += Math.max(0, performance.now() - toolStarted);
          const errorKey = call.name === "run_command" && isRecord(call.arguments)
            ? JSON.stringify([call.name, call.arguments.command, call.arguments.args ?? []]) : call.name;
          if (outcome.result.error) {
            failedToolCalls += 1;
            unresolvedToolErrors.set(errorKey, { tool: call.name, code: outcome.result.error.code });
          } else {
            successfulToolCalls += 1;
            unresolvedToolErrors.delete(errorKey);
          }
          outcome.changedPaths.forEach((path) => changedPaths.add(path));
          const progress = session.recordOutcome(prepared, outcome.result, outcome.changedPaths);
          roundProgress ||= progress.progress;
          if (progress.evidenceKey) roundEvidenceKeys.add(progress.evidenceKey);
          roundConversation.push({ role: "tool", toolResult: outcome.result });
        }
        latestExchange = roundConversation;
        latestEvidenceKeys = roundEvidenceKeys;
        session.finishToolRound(roundProgress);
      }

      throw new ExecutorError(
        "provider_call_limit_exceeded",
        "Executor reached the provider-call safety ceiling for this task",
      );
    } catch (error: unknown) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      this.events.emit("executor.failed", {
        ...(runInput.workflowId ? { workflowId: runInput.workflowId } : {}),
        taskId: runInput.input.task.id,
        providerId: runInput.model.providerId,
        modelId: runInput.model.modelId,
        code: executorErrorCode(error),
        phase,
        toolCalls: toolCallCount,
        toolDurationMs,
        successfulToolCalls,
        failedToolCalls,
        invalidToolCalls,
        toolCallsByName: { ...toolCallsByName },
        toolCallsByCategory: session.counts(),
        contextMetrics: session.metrics(),
        changedFiles: [...changedPaths],
        ...(typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
      });
      throw error;
    }
  }

  private requireModel(
    model: ModelInfo | undefined,
    modelId: string,
  ): ModelInfo {
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

    let changedPaths: readonly string[] = [];
    try {
      const before = call.name === "run_command" ? await this.commandEvidence(context) : undefined;
      let output: unknown;
      let permissionDenied = false;
      try {
        output = await this.tools.execute<Record<string, unknown>, unknown>(
          call.name,
          call.arguments,
          context,
        );
      } catch (error: unknown) {
        permissionDenied = error instanceof NyxaraToolError && isSecurityError(error.code);
        throw error;
      } finally {
        if (before && !permissionDenied && !context.signal?.aborted) {
          const after = await this.commandEvidence(context);
          changedPaths = [...new Set([
            ...changedStatusPaths(before.status, after.status),
            ...changedDiffPaths(before.diff, after.diff),
          ])];
        }
      }
      if (context.signal?.aborted) throw new ExecutorError("executor_aborted", "Executor run was aborted");
      const commandExitCode = isRecord(output) && typeof output.exitCode === "number" ? output.exitCode : null;
      const commandFailed = call.name === "run_command" && commandExitCode !== 0;
      // Reserve space for the tool response envelope so the complete message
      // returned to the provider remains within the configured result bound.
      const boundedOutput = boundToolResult(output, maxResultBytes - 512);
      return {
        result: {
          callId: call.id,
          name: call.name,
          result: boundedOutput,
          ...(commandFailed ? { error: { code: "command_failed", message: `Command exited unsuccessfully (exit code ${commandExitCode ?? "unavailable"}); inspect the bounded command result attached to this tool response` } } : {}),
        },
        changedPaths: [...changedPaths, ...extractChangedPaths(output)],
      };
    } catch (error: unknown) {
      if (context.signal?.aborted) throw new ExecutorError("executor_aborted", "Executor run was aborted");
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
      return { result, changedPaths };
    }
  }

  private async commandEvidence(context: ToolContext): Promise<{ status: GitStatusResult; diff: GitDiffResult }> {
    const [status, diff] = await Promise.all([
      this.tools.execute<Record<string, never>, GitStatusResult>("git_status", {}, context),
      this.tools.execute<{ maxBytes: number }, GitDiffResult>("git_diff", { maxBytes: EXECUTION_DIFF_MAX_BYTES }, context),
    ]);
    if (!status.isRepository || !diff.isRepository || status.truncated || diff.truncated) {
      throw new NyxaraToolError("tool_error", "Complete bounded Git evidence is required for a command", "run_command");
    }
    return { status, diff };
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
    readonly toolDurationMs: number;
    readonly modelTurns: number;
    readonly successfulToolCalls: number;
    readonly failedToolCalls: number;
    readonly invalidToolCalls: number;
    readonly toolCallsByName: Readonly<Record<string, number>>;
    readonly toolCallsByCategory: Readonly<Record<ExecutorToolCategory, number>>;
    readonly contextMetrics: ExecutorContextMetrics;
    readonly readOnly: boolean;
    readonly allowNoChange: boolean;
  }): Promise<ExecutionResult> {
    const [finalStatus, diff] = await Promise.all([
      this.tools.execute<Record<string, never>, GitStatusResult>(
        "git_status",
        {},
        input.context,
      ),
      this.tools.execute<{ maxBytes: number }, GitDiffResult>(
        "git_diff",
        { maxBytes: EXECUTION_DIFF_MAX_BYTES },
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

    let decision = input.decision;
    if (decision.status === "completed" && input.readOnly && changedFiles.length > 0) {
      decision = {
        status: "failed",
        summary: "Read-only Executor task modified repository files",
        unresolvedIssues: ["A read-only task must not modify repository state"],
      };
    } else if (
      decision.status === "completed" &&
      !input.readOnly &&
      changedFiles.length === 0 &&
      !input.allowNoChange
    ) {
      decision = {
        status: "failed",
        summary: "Executor failed before producing the required implementation",
        unresolvedIssues: ["Implementation task completed with zero files changed"],
      };
    }

    return {
      taskId: input.taskId,
      status: decision.status,
      summary: decision.summary,
      changedFiles,
      toolCalls: input.toolCallCount,
      toolDurationMs: input.toolDurationMs,
      successfulToolCalls: input.successfulToolCalls,
      failedToolCalls: input.failedToolCalls,
      invalidToolCalls: input.invalidToolCalls,
      toolCallsByName: { ...input.toolCallsByName },
      toolCallsByCategory: input.toolCallsByCategory,
      contextMetrics: input.contextMetrics,
      modelTurns: input.modelTurns,
      ...(decision.unresolvedIssues
        ? { unresolvedIssues: decision.unresolvedIssues }
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

function resolveLimits(input: Partial<ExecutorLimits> | undefined): ResolvedExecutorLimits {
  const providerCalls = input?.maxProviderCallsPerTask ?? input?.maxModelTurnsPerTask ?? DEFAULT_LIMITS.maxProviderCallsPerTask;
  const limits: ResolvedExecutorLimits = {
    maxToolCallsPerTask: input?.maxToolCallsPerTask ?? DEFAULT_LIMITS.maxToolCallsPerTask,
    maxReadToolCallsPerTask: input?.maxReadToolCallsPerTask ?? DEFAULT_LIMITS.maxReadToolCallsPerTask,
    maxMutatingToolCallsPerTask: input?.maxMutatingToolCallsPerTask ?? DEFAULT_LIMITS.maxMutatingToolCallsPerTask,
    maxValidationToolCallsPerTask: input?.maxValidationToolCallsPerTask ?? DEFAULT_LIMITS.maxValidationToolCallsPerTask,
    maxProviderCallsPerTask: providerCalls,
    maxToolResultBytes: input?.maxToolResultBytes ?? DEFAULT_LIMITS.maxToolResultBytes,
    maxRetainedEvidenceBytes: input?.maxRetainedEvidenceBytes ?? DEFAULT_LIMITS.maxRetainedEvidenceBytes,
    maxExecutorContextBytes: input?.maxExecutorContextBytes ?? DEFAULT_LIMITS.maxExecutorContextBytes,
    maxEstimatedInputTokens: input?.maxEstimatedInputTokens ?? DEFAULT_LIMITS.maxEstimatedInputTokens,
    maxConsecutiveNoProgressToolCalls: input?.maxConsecutiveNoProgressToolCalls ?? DEFAULT_LIMITS.maxConsecutiveNoProgressToolCalls,
    maxNoProgressModelTurns: input?.maxNoProgressModelTurns ?? DEFAULT_LIMITS.maxNoProgressModelTurns,
  };
  if (Object.values(limits).some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new ExecutorError("executor_error", "Executor limits are invalid");
  }
  if (
    limits.maxToolResultBytes < 1024 ||
    limits.maxRetainedEvidenceBytes < 1024 ||
    limits.maxExecutorContextBytes < 16 * 1024 ||
    limits.maxEstimatedInputTokens < 4096
  ) {
    throw new ExecutorError("executor_error", "Executor byte and token limits are below safe bounded minima");
  }
  if (
    limits.maxToolCallsPerTask > 512 ||
    limits.maxReadToolCallsPerTask > 512 ||
    limits.maxMutatingToolCallsPerTask > 512 ||
    limits.maxValidationToolCallsPerTask > 512 ||
    limits.maxProviderCallsPerTask > 64 ||
    limits.maxToolResultBytes > 64 * 1024 ||
    limits.maxRetainedEvidenceBytes > 256 * 1024 ||
    limits.maxExecutorContextBytes > 512 * 1024 ||
    limits.maxEstimatedInputTokens > 128 * 1024 ||
    limits.maxConsecutiveNoProgressToolCalls > 64 ||
    limits.maxNoProgressModelTurns > 64
  ) {
    throw new ExecutorError("executor_error", "Executor limits exceed provider-neutral safety maxima");
  }
  return limits;
}

function compactConversation(
  conversation: readonly ModelConversationMessage[],
): readonly ModelConversationMessage[] {
  return conversation.map((message) => {
    if (message.role === "tool") return message;
    return {
      role: "assistant" as const,
      ...(message.content ? { content: boundAssistantText(message.content) } : {}),
      ...(message.toolCalls
        ? { toolCalls: message.toolCalls.map(compactHistoricalToolCall) }
        : {}),
    };
  });
}

function compactHistoricalToolCall(call: ModelToolCall): ModelToolCall {
  if (!isRecord(call.arguments)) return call;
  if (call.name === "write_file" && typeof call.arguments.content === "string") {
    return {
      ...call,
      arguments: {
        ...call.arguments,
        content: `<compacted ${Buffer.byteLength(call.arguments.content, "utf8")} byte write>`,
      },
    };
  }
  if (call.name === "apply_patch" && typeof call.arguments.patch === "string") {
    return {
      ...call,
      arguments: {
        patch: `<compacted ${Buffer.byteLength(call.arguments.patch, "utf8")} byte patch>`,
      },
    };
  }
  return call;
}

function boundAssistantText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= 2_048
    ? text
    : `${bytes.subarray(0, 2_048).toString("utf8")}\n[assistant text truncated]`;
}

function hasRelevantInitialChanges(
  relevantFiles: readonly string[] | undefined,
  changedFiles: readonly string[],
): boolean {
  if (changedFiles.length === 0) return false;
  if (!relevantFiles?.length) return true;
  const changed = new Set(changedFiles.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")));
  return relevantFiles.some((path) => changed.has(path.replaceAll("\\", "/").replace(/^\.\//, "")));
}

function toolContext(workspaceRoot: string, signal?: AbortSignal, resolvePermission?: (request: import("@nyxara/tools").PermissionRequest) => Promise<"allow" | "deny">): ToolContext {
  return { workspaceRoot, ...(signal ? { signal } : {}), ...(resolvePermission ? { resolvePermission } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundToolResult(value: unknown, maxBytes: number): unknown {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return value;
  if (isRecord(value) && typeof value.path === "string" && typeof value.content === "string") {
    const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "content"));
    return fitStringFields(
      { ...metadata, content: value.content, truncated: true },
      ["content"],
      maxBytes,
      false,
    );
  }
  if (isRecord(value) && (typeof value.stdout === "string" || typeof value.stderr === "string")) {
    const metadata = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "stdout" && key !== "stderr"),
    );
    return fitStringFields({
      ...metadata,
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr: typeof value.stderr === "string" ? value.stderr : "",
      truncated: true,
    }, ["stderr", "stdout"], maxBytes, true);
  }
  if (isRecord(value)) {
    const arrayKey = Array.isArray(value.matches)
      ? "matches"
      : Array.isArray(value.entries)
        ? "entries"
        : undefined;
    if (arrayKey) {
      const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => key !== arrayKey));
      const items: unknown[] = [];
      for (const item of value[arrayKey] as unknown[]) {
        const candidate = { ...metadata, [arrayKey]: [...items, item], truncated: true };
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) break;
        items.push(item);
      }
      return { ...metadata, [arrayKey]: items, truncated: true };
    }
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    summary: "Tool output exceeded the Executor evidence bound and was omitted",
  };
}

function fitStringFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  maxBytes: number,
  keepTail: boolean,
): Record<string, unknown> {
  const output = { ...input };
  for (const field of fields) {
    if (typeof output[field] !== "string") continue;
    while (Buffer.byteLength(JSON.stringify(output), "utf8") > maxBytes && output[field]) {
      const value = output[field] as string;
      const target = Math.max(0, Math.floor(Buffer.byteLength(value, "utf8") * 0.7));
      output[field] = keepTail
        ? tailUtf8(value, target)
        : truncateUtf8(value, target).value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") <= maxBytes) return output;
  return { truncated: true, summary: "Tool output metadata exceeded the Executor evidence bound" };
}

function tailUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  return `[earlier output truncated]\n${buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")}`;
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

function changedDiffPaths(initial: GitDiffResult, final: GitDiffResult): string[] {
  const sections = (diff: string): Map<string, string> => new Map(
    diff.split(/(?=^diff --git )/m).flatMap((section) => {
      const path = /^diff --git a\/.+ b\/(.+)$/m.exec(section)?.[1];
      return path ? [[path, section] as const] : [];
    }),
  );
  const before = sections(initial.diff);
  const after = sections(final.diff);
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
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
  return errorCodeOr(error, "executor_error");
}
