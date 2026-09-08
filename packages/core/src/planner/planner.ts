import { randomUUID } from "node:crypto";
import { executionProfileSummary, type ExecutionOptions, type GenerateResponse, type ModelInfo } from "@nyxara/provider-sdk";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { errorCodeOr } from "../internal/error-code.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { boundPlannerOutputTokens } from "../context/planning-context-policy.js";
import { PlanValidator } from "./plan-validator.js";
import { PlannerError } from "./planner-error.js";
import { PlannerPromptBuilder } from "./planner-prompt-builder.js";
import { parseAndNormalizePlanDraft } from "./plan-draft-normalizer.js";
import { groupPlanAcceptanceCriteria } from "./plan-criteria-normalizer.js";
import {
  ExecutionPlanDraftSchema,
  normalizePlannerInput,
  type ExecutionPlan,
  type PlannerRunInput,
} from "./planner.types.js";
import { DEFAULT_PLANNING_PROFILE } from "./planning-profile.js";

export class Planner {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly promptBuilder = new PlannerPromptBuilder(),
    private readonly validator = new PlanValidator(),
  ) {}

  async run(runInput: PlannerRunInput): Promise<ExecutionPlan> {
    const input = normalizePlannerInput(runInput.input);
    const model = runInput.model;
    const planningProfile = runInput.planningProfile ?? DEFAULT_PLANNING_PROFILE;
    this.events.emit("planner.started", {
      providerId: model.providerId,
      modelId: model.modelId,
      contextFileCount: input.context.files.length,
    });

    try {
      const provider = this.providers.get(model.providerId);
      const selectedModel = this.requireModel(await this.providers.resolveModel(model.providerId, model.modelId, model.executionOptions), model.modelId);
      const prompt = this.promptBuilder.build(input, planningProfile, runInput.engineeringRules, this.validator.structureBounds);
      const response = await this.generate(
        provider,
        prompt,
        selectedModel,
        model.executionOptions,
        model.providerId,
        runInput.workflowId,
        input.context.files.length,
        input.context.totalBytes,
        input.context.truncated,
        boundPlannerOutputTokens(runInput.maxOutputTokens),
        runInput.signal,
      );
      if (["length", "max_tokens", "MAX_TOKENS"].includes(response.finishReason ?? "")) {
        throw new PlannerError("plan_response_truncated", "Planner response reached the provider output limit; no plan was accepted");
      }
      if (!response.text.trim()) {
        throw new PlannerError("plan_response_empty", "Planner received an empty assistant response; no plan was accepted");
      }
      const parsed = parseAndNormalizePlanDraft(response.text);

      this.events.emit("plan.validation_started", {
        providerId: model.providerId,
        modelId: model.modelId,
      });

      let plan: ExecutionPlan;
      let acceptanceCriteriaGrouping: NyxaraEventMap["planner.completed"]["acceptanceCriteriaGrouping"];
      try {
        const draftResult = ExecutionPlanDraftSchema.safeParse(parsed);
        if (!draftResult.success) {
          const issue = draftResult.error.issues[0];
          const location = issue?.path.length ? issue.path.join(".") : "plan";
          throw new PlannerError(
            "invalid_plan",
            `Planner plan field ${location} is invalid${issue?.message ? `: ${issue.message}` : ""}`,
          );
        }
        const normalized = groupPlanAcceptanceCriteria(draftResult.data, this.validator.structureBounds);
        plan = this.validator.validate({
          ...normalized,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        });
        const groupedTasks = normalized.tasks.flatMap((task, index) => {
          const original = draftResult.data.tasks[index]!.acceptanceCriteria.length;
          return original !== task.acceptanceCriteria.length ? [{ original, grouped: task.acceptanceCriteria.length }] : [];
        });
        if (groupedTasks.length > 0) acceptanceCriteriaGrouping = {
          tasks: groupedTasks.length,
          originalCriteria: groupedTasks.reduce((total, task) => total + task.original, 0),
          groupedCriteria: groupedTasks.reduce((total, task) => total + task.grouped, 0),
        };
      } catch (error: unknown) {
        this.events.emit("plan.validation_failed", {
          providerId: model.providerId,
          modelId: model.modelId,
          code: plannerErrorCode(error),
        });
        throw error;
      }

      this.events.emit("plan.validation_passed", {
        planId: plan.id,
        taskCount: plan.tasks.length,
      });
      this.events.emit("planner.completed", {
        planId: plan.id,
        providerId: model.providerId,
        modelId: model.modelId,
        taskCount: plan.tasks.length,
        ...(acceptanceCriteriaGrouping ? { acceptanceCriteriaGrouping } : {}),
      });
      return plan;
    } catch (error: unknown) {
      this.events.emit("planner.failed", {
        providerId: model.providerId,
        modelId: model.modelId,
        code: plannerErrorCode(error),
      });
      throw error;
    }
  }

  private requireModel(model: ModelInfo | undefined, modelId: string): ModelInfo {
    if (!model) {
      throw new PlannerError(
        "invalid_model",
        `Planner model is not available: ${modelId}`,
      );
    }
    return model;
  }

  private async generate(
    provider: ReturnType<ProviderRegistry["get"]>,
    prompt: string,
    model: ModelInfo,
    executionOptions: ExecutionOptions | undefined,
    providerConfigId: string,
    workflowId?: string,
    contextFiles?: number,
    contextBytes?: number | null,
    contextTruncated?: boolean,
    maxOutputTokens?: number,
    signal?: AbortSignal,
  ): Promise<GenerateResponse> {
    try {
      const started = performance.now();
      // Progress is forwarded only when the transport declares real streaming.
      // Non-streaming transports rely on stage plus elapsed time instead.
      const streaming = provider.capabilities().progressStreaming === true;
      const response = await provider.generate({
        model: model.id,
        prompt,
        ...(executionOptions ? { executionOptions } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(signal ? { signal } : {}),
        ...(streaming ? {
          onProgress: (event) => this.events.emit("provider.generation.progress", {
            providerId: provider.providerId ?? provider.id,
            providerConfigId,
            modelId: model.id,
            role: "planner",
            ...(workflowId ? { workflowId } : {}),
            phase: event.phase,
            ...(event.toolName ? { toolName: event.toolName } : {}),
            timestamp: new Date().toISOString(),
          }),
        } : {}),
        ...(model.capabilities?.structuredOutput ||
        provider.capabilities().structuredOutput
          ? { responseFormat: "json" as const }
          : {}),
      });
      this.events.emit("provider.generation.completed", {
        providerId: provider.providerId ?? provider.id,
        providerConfigId,
        modelId: response.model,
        requestedModelId: model.id,
        role: "planner",
        ...(workflowId ? { workflowId } : {}),
        providerDurationMs: performance.now() - started,
        ...(response.id ? { responseId: response.id } : {}),
        ...(response.finishReason ? { finishReason: response.finishReason } : {}),
        textLength: response.text.length,
        toolCallCount: response.toolCalls?.length ?? 0,
        executionProfileSummary: executionProfileSummary(executionOptions),
        ...(contextFiles !== undefined ? { contextFiles } : {}),
        ...(contextBytes !== undefined ? { contextBytes } : {}),
        ...(contextTruncated !== undefined ? { contextTruncated } : {}),
        ...(response.usage ? { usage: response.usage } : {}),
      });
      return response;
    } catch (error: unknown) {
      this.events.emit("provider.operation.failed", {
        providerId: provider.id,
        operation: "generate",
        error: {
          message: error instanceof Error ? error.message : "Unknown provider error",
        },
      });
      throw error;
    }
  }

}

function plannerErrorCode(error: unknown): string {
  return errorCodeOr(error, "planner_error");
}
