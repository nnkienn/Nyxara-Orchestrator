import type { GenerateResponse, ModelInfo } from "@nyxara/provider-sdk";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { errorCodeOr } from "../internal/error-code.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import {
  ReviewResultDraftSchema,
  type ReviewResultDraft,
} from "./reviewer.schema.js";
import { reviewContextBytes } from "./review-evidence-builder.js";
import { ReviewerError } from "./reviewer.errors.js";
import { ReviewerPromptBuilder } from "./reviewer-prompt-builder.js";
import { ReviewValidator } from "./review-validator.js";
import type {
  ReviewerLimits,
  ReviewerRunInput,
  ReviewerRunResult,
} from "./reviewer.types.js";

const DEFAULT_REVIEWER_LIMITS: ReviewerLimits = {
  maxReviewerTurns: 2,
  maxContextExpansions: 1,
};

export class Reviewer {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly promptBuilder = new ReviewerPromptBuilder(),
    private readonly validator = new ReviewValidator(),
  ) {}

  async run(runInput: ReviewerRunInput): Promise<ReviewerRunResult> {
    const { model } = runInput;
    const limits = resolveReviewerLimits(runInput.limits);
    if (model.role !== "reviewer") {
      throw new ReviewerError("reviewer_error", "Reviewer requires reviewer role configuration");
    }
    let evidence = runInput.input.evidence;
    let contextExpansions = 0;
    const startedAt = Date.now();
    this.events.emit("reviewer.started", {
      taskId: runInput.input.task.id,
      providerId: model.providerId,
      modelId: model.modelId,
      diffBytes: Buffer.byteLength(evidence.diff.content, "utf8"),
      contextBytes: reviewContextBytes(evidence),
    });

    try {
      const provider = this.providers.get(model.providerId);
      const selectedModel = this.requireModel(
        await provider.listModels(),
        model.modelId,
      );

      for (let turn = 1; turn <= limits.maxReviewerTurns; turn += 1) {
        if (runInput.signal?.aborted) {
          throw new ReviewerError("reviewer_aborted", "Review was aborted");
        }
        const input = { ...runInput.input, evidence };
        const response = await this.generate(
          provider,
          selectedModel,
          this.promptBuilder.build(input),
        );
        const result = this.parseAndValidate(response, input);

        if (result.status !== "needs_more_context") {
          this.events.emit("reviewer.completed", {
            taskId: input.task.id,
            providerId: model.providerId,
            modelId: model.modelId,
            status: result.status,
            findingCount: result.findings.length,
            durationMs: Date.now() - startedAt,
            turns: turn,
            contextExpansions,
          });
          return { result, evidence, turns: turn, contextExpansions };
        }

        if (
          !result.contextRequest ||
          !runInput.expandContext ||
          contextExpansions >= limits.maxContextExpansions ||
          turn >= limits.maxReviewerTurns
        ) {
          throw new ReviewerError(
            "review_context_limit_exceeded",
            "Reviewer cannot request another context expansion",
          );
        }
        this.events.emit("review.context_requested", {
          taskId: input.task.id,
          pathCount: result.contextRequest.paths?.length ?? 0,
          symbolCount: result.contextRequest.symbols?.length ?? 0,
          reasonCount: result.contextRequest.reasons.length,
        });
        const expanded = await runInput.expandContext(
          result.contextRequest,
          evidence,
        );
        evidence = expanded.evidence;
        contextExpansions += 1;
        this.events.emit("review.context_expanded", {
          taskId: input.task.id,
          fileCount: expanded.fileCount,
          contextBytes: expanded.contextBytes,
          expansion: contextExpansions,
        });
      }

      throw new ReviewerError(
        "review_context_limit_exceeded",
        "Reviewer exceeded its model-turn limit",
      );
    } catch (error: unknown) {
      this.events.emit("reviewer.failed", {
        taskId: runInput.input.task.id,
        providerId: model.providerId,
        modelId: model.modelId,
        code: reviewerErrorCode(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private parseAndValidate(
    response: GenerateResponse,
    input: ReviewerRunInput["input"],
  ) {
    this.events.emit("review.validation_started", { taskId: input.task.id });
    try {
      const parsed = parseReviewResponse(response.text);
      const schemaResult = ReviewResultDraftSchema.safeParse(parsed);
      if (!schemaResult.success) {
        throw new ReviewerError(
          "invalid_review",
          "Reviewer returned a result that does not match the required schema",
        );
      }
      const result = this.validator.validate(
        schemaResult.data,
        input.task.acceptanceCriteria,
        input.validation,
      );
      this.events.emit("review.validation_passed", {
        taskId: input.task.id,
        status: result.status,
        criterionCount: result.criteria.length,
      });
      return result;
    } catch (error: unknown) {
      this.events.emit("review.validation_failed", {
        taskId: input.task.id,
        code: reviewerErrorCode(error),
      });
      throw error;
    }
  }

  private requireModel(models: readonly ModelInfo[], modelId: string): ModelInfo {
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new ReviewerError(
        "invalid_model",
        `Reviewer model is not available: ${modelId}`,
      );
    }
    return model;
  }

  private async generate(
    provider: ReturnType<ProviderRegistry["get"]>,
    model: ModelInfo,
    prompt: string,
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
}

function resolveReviewerLimits(input?: Partial<ReviewerLimits>): ReviewerLimits {
  const limits = { ...DEFAULT_REVIEWER_LIMITS, ...input };
  if (
    !Number.isInteger(limits.maxReviewerTurns) ||
    limits.maxReviewerTurns <= 0 ||
    limits.maxReviewerTurns > 4 ||
    !Number.isInteger(limits.maxContextExpansions) ||
    limits.maxContextExpansions < 0 ||
    limits.maxContextExpansions >= limits.maxReviewerTurns
  ) {
    throw new ReviewerError("reviewer_error", "Reviewer limits are invalid");
  }
  return limits;
}

function parseReviewResponse(text: string): unknown {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    throw new ReviewerError(
      "review_parse_error",
      "Reviewer returned a response that is not valid JSON",
    );
  }
}

function reviewerErrorCode(error: unknown): string {
  return errorCodeOr(error, "reviewer_error");
}

export type { ReviewResultDraft };
