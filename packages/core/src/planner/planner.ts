import { randomUUID } from "node:crypto";
import type { GenerateResponse, ModelInfo } from "@nyxara/provider-sdk";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { errorCodeOr } from "../internal/error-code.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { PlanValidator } from "./plan-validator.js";
import { PlannerError } from "./planner-error.js";
import { PlannerPromptBuilder } from "./planner-prompt-builder.js";
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
      const models = await provider.listModels();
      const selectedModel = this.requireModel(models, model.modelId);
      const prompt = this.promptBuilder.build(input, planningProfile, runInput.engineeringRules);
      const response = await this.generate(
        provider,
        prompt,
        selectedModel,
      );
      const parsed = this.parseResponse(response.text);

      this.events.emit("plan.validation_started", {
        providerId: model.providerId,
        modelId: model.modelId,
      });

      let plan: ExecutionPlan;
      try {
        const draftResult = ExecutionPlanDraftSchema.safeParse(parsed);
        if (!draftResult.success) {
          throw new PlannerError(
            "invalid_plan",
            "Planner returned a plan that does not match the required schema",
          );
        }
        plan = this.validator.validate({
          ...draftResult.data,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        });
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

  private requireModel(models: readonly ModelInfo[], modelId: string): ModelInfo {
    const model = models.find((candidate) => candidate.id === modelId);
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
  ): Promise<GenerateResponse> {
    try {
      const response = await provider.generate({
        model: model.id,
        prompt,
        ...(model.capabilities?.structuredOutput ||
        provider.capabilities().structuredOutput
          ? { responseFormat: "json" as const }
          : {}),
      });
      this.events.emit("provider.generation.completed", {
        providerId: provider.id,
        modelId: response.model,
        ...(response.id ? { responseId: response.id } : {}),
        ...(response.finishReason ? { finishReason: response.finishReason } : {}),
        textLength: response.text.length,
        toolCallCount: response.toolCalls?.length ?? 0,
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

  private parseResponse(text: string): unknown {
    const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      return JSON.parse(normalized);
    } catch {
      throw new PlannerError(
        "plan_parse_error",
        "Planner returned a response that is not valid JSON",
      );
    }
  }
}

function plannerErrorCode(error: unknown): string {
  return errorCodeOr(error, "planner_error");
}
