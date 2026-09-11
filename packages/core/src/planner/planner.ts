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
import {
  ExecutionPlanDraftSchema,
  normalizePlannerInput,
  type ExecutionPlan,
  type PlannerRunInput,
} from "./planner.types.js";
import { DEFAULT_PLANNING_PROFILE } from "./planning-profile.js";
import type { PlannerStructureViolation } from "./planner-error.js";

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
        this.plannerResponseSchema(),
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
      try { plan = this.validateDraft(parsed); }
      catch (error: unknown) {
        const violations = error instanceof PlannerError ? error.violations : undefined;
        if (!violations || !this.repairable(violations)) {
          this.events.emit("plan.validation_failed", { providerId: model.providerId, modelId: model.modelId, code: plannerErrorCode(error) });
          throw error;
        }
        const compacted = await this.generate(
          provider,
          this.compactionPrompt(parsed, violations),
          selectedModel,
          model.executionOptions,
          model.providerId,
          runInput.workflowId,
          undefined, undefined, undefined,
          boundPlannerOutputTokens(runInput.maxOutputTokens),
          runInput.signal,
          this.plannerResponseSchema(),
        );
        if (["length", "max_tokens", "MAX_TOKENS"].includes(compacted.finishReason ?? "") || !compacted.text.trim()) {
          throw this.compactionFailure(violations[0]!);
        }
        try { plan = this.validateDraft(parseAndNormalizePlanDraft(compacted.text)); }
        catch (repairError) { throw this.compactionFailure(repairError instanceof PlannerError && repairError.violations?.[0] ? repairError.violations[0] : violations[0]!); }
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
    responseSchema?: Readonly<Record<string, unknown>>,
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
        ...(responseSchema && (model.capabilities?.structuredOutput || provider.capabilities().structuredOutput) ? { responseSchema } : {}),
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

  private validateDraft(parsed: unknown): ExecutionPlan {
    const draftResult = ExecutionPlanDraftSchema.safeParse(parsed);
    if (!draftResult.success) {
      const issue = draftResult.error.issues[0];
      const location = issue?.path.length ? issue.path.join(".") : "plan";
      throw new PlannerError("invalid_plan", `Planner plan field ${location} is invalid${issue?.message ? `: ${issue.message}` : ""}`);
    }
    return this.validator.validate({ ...draftResult.data, id: randomUUID(), createdAt: new Date().toISOString() });
  }

  private repairable(violations: readonly PlannerStructureViolation[]): boolean {
    return violations.length > 0 && violations.every((violation) => violation.kind === "length" || /acceptanceCriteria$|risks$|assumptions$/.test(violation.path));
  }

  private compactionPrompt(plan: unknown, violations: readonly PlannerStructureViolation[]): string {
    return [
      "Compact this Nyxara implementation plan to satisfy the exact structural bounds. Return exactly one complete JSON object and no prose. Preserve objective, task IDs, dependencies, execution modes, relevant files, risks, numeric thresholds, and acceptance intent; rewrite concise wording and merge redundancy only.",
      `Required plan shape and bounds: ${JSON.stringify(this.plannerResponseSchema())}`,
      `Violations: ${JSON.stringify(violations)}`,
      `Generated plan JSON: ${JSON.stringify(plan)}`,
    ].join("\n\n");
  }

  private compactionFailure(violation: PlannerStructureViolation): PlannerError {
    return new PlannerError("plan_bounds_exceeded", `Planner automatic compaction was attempted once, but ${violation.path} remains oversized (${violation.actual} > ${violation.maximum}); no plan was accepted`, [violation]);
  }

  private plannerResponseSchema(): Readonly<Record<string, unknown>> {
    const b = this.validator.structureBounds;
    return { type: "object", additionalProperties: false, required: ["objective", "tasks"], properties: { objective: { type: "string", maxLength: b.maxObjectiveCharacters }, summary: { type: "string", maxLength: b.maxSummaryCharacters }, tasks: { type: "array", minItems: 1, maxItems: b.maxTasks, items: { type: "object", additionalProperties: false, required: ["id", "title", "description", "dependencies", "acceptanceCriteria"], properties: { id: { type: "string" }, title: { type: "string", maxLength: b.maxTitleCharacters }, description: { type: "string", maxLength: b.maxDescriptionCharacters }, executionMode: { enum: ["implementation", "read_only"] }, dependencies: { type: "array", items: { type: "string" } }, acceptanceCriteria: { type: "array", minItems: 1, maxItems: b.maxAcceptanceCriteriaPerTask, items: { type: "string", maxLength: b.maxAcceptanceCriterionCharacters } }, relevantFiles: { type: "array", maxItems: b.maxRelevantFilesPerTask, items: { type: "string" } }, risk: { enum: ["low", "medium", "high"] } } } }, risks: { type: "array", maxItems: b.maxRisks, items: { type: "object", properties: { description: { type: "string", maxLength: b.maxRiskDescriptionCharacters }, severity: { enum: ["low", "medium", "high"] }, mitigation: { type: "string", maxLength: b.maxRiskMitigationCharacters } }, required: ["description", "severity"] } }, assumptions: { type: "array", maxItems: b.maxAssumptions, items: { type: "string", maxLength: b.maxAssumptionCharacters } } } };
  }

}

function plannerErrorCode(error: unknown): string {
  return errorCodeOr(error, "planner_error");
}
