import type {
  GenerateRequest,
  GenerateResponse,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  EventBus,
  NyxaraOrchestrator,
  ProviderRegistry,
  Reviewer,
  ReviewEvidenceBuilder,
  ReviewStore,
  ReviewValidator,
  validateReviewContextRequest,
  type NyxaraEventMap,
  type ReviewResultDraft,
} from "../src/index.js";
import {
  context,
  execution,
  passingValidation,
  task,
  validation,
} from "./fixtures/review-fixtures.js";

describe("Reviewer", () => {
  it("uses the configured provider/model and returns normalized structured output", async () => {
    const generate = vi.fn();
    const reviewer = reviewerWith([validDraft()], generate);

    const reviewed = await reviewer.run(runInput());

    expect(reviewed.result).toMatchObject({
      status: "passed",
      summary: "Pagination criteria are satisfied",
      findings: [],
    });
    expect(reviewed.result.reviewedAt).toMatch(/Z$/);
    expect(reviewed.result.criteria).toHaveLength(2);
    expect(reviewed.turns).toBe(1);
    const request = generate.mock.calls[0]?.[0] as GenerateRequest;
    expect(request.model).toBe("reviewer-model");
    expect(request.responseFormat).toBe("json");
    expect(request.tools).toBeUndefined();
    expect(request.conversation).toBeUndefined();
    expect(request.prompt).toContain("Review only the bounded evidence provided");
    expect(request.prompt).toContain("1. User requirement:");
    expect(request.prompt).toContain("5. Git diff");
    expect(JSON.stringify(reviewed.result)).not.toContain("provider-native-id");
  });

  it("emits lifecycle and structured-result validation events", async () => {
    const events = new EventBus<NyxaraEventMap>();
    const lifecycle: string[] = [];
    events.on("reviewer.started", () => lifecycle.push("started"));
    events.on("review.validation_started", () => lifecycle.push("validation_started"));
    events.on("review.validation_passed", () => lifecycle.push("validation_passed"));
    events.on("reviewer.completed", () => lifecycle.push("completed"));
    const reviewer = reviewerWith([validDraft()], undefined, events);

    await reviewer.run(runInput());

    expect(lifecycle).toEqual([
      "started",
      "validation_started",
      "validation_passed",
      "completed",
    ]);
  });

  it("rejects malformed JSON and schema-invalid responses", async () => {
    for (const response of ["not-json", JSON.stringify({ status: "passed" })]) {
      const events = new EventBus<NyxaraEventMap>();
      const validationFailed = vi.fn();
      const reviewerFailed = vi.fn();
      events.on("review.validation_failed", validationFailed);
      events.on("reviewer.failed", reviewerFailed);
      const reviewer = reviewerWithRaw([response], events);

      await expect(reviewer.run(runInput())).rejects.toMatchObject({
        code: response === "not-json" ? "review_parse_error" : "invalid_review",
      });
      expect(validationFailed).toHaveBeenCalledOnce();
      expect(reviewerFailed).toHaveBeenCalledOnce();
    }
  });

  it("rejects unknown providers and unavailable models", async () => {
    const empty = new Reviewer(
      new ProviderRegistry(),
      new EventBus<NyxaraEventMap>(),
    );
    await expect(empty.run(runInput())).rejects.toMatchObject({
      code: "unknown_provider",
    });

    const providers = new ProviderRegistry();
    providers.register(fakeProvider([validDraft()]));
    await expect(
      new Reviewer(providers, new EventBus<NyxaraEventMap>()).run({
        ...runInput(),
        model: {
          role: "reviewer",
          providerId: "fake",
          modelId: "missing",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_model" });
  });

  it("resumes once after a specific context request", async () => {
    const requestDraft = {
      ...validDraft(),
      status: "needs_more_context",
      criteria: task().acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "uncertain",
        reason: "Need mapper evidence",
      })),
      contextRequest: {
        paths: ["src/notification.mapper.ts"],
        reasons: ["Verify pagination metadata mapping"],
      },
    } as const;
    const events = new EventBus<NyxaraEventMap>();
    const requested = vi.fn();
    const expandedEvent = vi.fn();
    events.on("review.context_requested", requested);
    events.on("review.context_expanded", expandedEvent);
    const reviewer = reviewerWith([requestDraft, validDraft()], undefined, events);
    const expandContext = vi.fn(async (_request, evidence) => ({
      evidence: {
        ...evidence,
        context: [
          ...evidence.context,
          {
            id: "src/notification.mapper.ts:1-1",
            path: "src/notification.mapper.ts",
            startLine: 1,
            endLine: 1,
            content: "export const metadata = true;",
            truncated: false,
          },
        ],
      },
      fileCount: 1,
      contextBytes: 128,
    }));

    const reviewed = await reviewer.run({ ...runInput(), expandContext });

    expect(reviewed.result.status).toBe("passed");
    expect(reviewed).toMatchObject({ turns: 2, contextExpansions: 1 });
    expect(expandContext).toHaveBeenCalledWith(
      expect.objectContaining({ paths: ["src/notification.mapper.ts"] }),
      expect.any(Object),
    );
    expect(requested).toHaveBeenCalledOnce();
    expect(expandedEvent).toHaveBeenCalledOnce();
  });

  it("rejects broad context requests and enforces reviewer limits", async () => {
    expect(() =>
      validateReviewContextRequest({
        paths: ["src/**"],
        reasons: ["Read all files"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "review_context_request_invalid" }),
    );
    expect(() =>
      validateReviewContextRequest({
        symbols: ["everything related to notification"],
        reasons: ["Need more evidence"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "review_context_request_invalid" }),
    );
    expect(() =>
      validateReviewContextRequest({
        paths: ["/etc/passwd"],
        reasons: ["Verify an external file"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "review_context_request_invalid" }),
    );

    const needsContext = {
      ...validDraft(),
      status: "needs_more_context",
      criteria: task().acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "uncertain",
        reason: "Need a symbol",
      })),
      contextRequest: {
        symbols: ["NotificationMapper"],
        reasons: ["Verify mapping"],
      },
    } as const;
    await expect(
      reviewerWith([needsContext]).run({
        ...runInput(),
        limits: { maxReviewerTurns: 1, maxContextExpansions: 0 },
        expandContext: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "review_context_limit_exceeded" });
  });
});

describe("Review acceptance and authority", () => {
  const validator = new ReviewValidator();

  it("rejects omitted criteria", () => {
    expect(() =>
      validator.validate(
        { ...validDraft(), criteria: [validDraft().criteria[0]!] },
        task().acceptanceCriteria,
        passingValidation(),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_review" }));
  });

  it("prevents PASS for unsatisfied or uncertain criteria and error findings", () => {
    for (const draft of [
      {
        ...validDraft(),
        criteria: [
          { ...validDraft().criteria[0]!, status: "unsatisfied" as const },
          validDraft().criteria[1]!,
        ],
      },
      {
        ...validDraft(),
        criteria: [
          { ...validDraft().criteria[0]!, status: "uncertain" as const },
          validDraft().criteria[1]!,
        ],
      },
      {
        ...validDraft(),
        findings: [
          {
            severity: "error" as const,
            category: "correctness" as const,
            message: "Visible correctness defect",
          },
        ],
      },
    ]) {
      expect(
        validator.validate(
          draft,
          task().acceptanceCriteria,
          passingValidation(),
        ).status,
      ).toBe("failed");
    }
  });

  it("makes deterministic validation authoritative over AI PASS", () => {
    const result = validator.validate(
      validDraft(),
      task().acceptanceCriteria,
      validation(),
    );
    expect(result.status).toBe("failed");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        category: "testing",
        severity: "error",
        message: expect.stringContaining("cannot override"),
      }),
    );
  });
});

describe("Reviewer configuration", () => {
  it("returns a controlled error when Reviewer is not configured", async () => {
    const nyxara = new NyxaraOrchestrator({ providers: [fakeProvider([validDraft()])] });
    await expect(
      nyxara.reviewTask({
        requirement: "Review pagination",
        objective: "Pagination",
        task: task(),
        execution: execution(),
        validation: passingValidation(),
        executorContext: context("source", "executor"),
      }),
    ).rejects.toMatchObject({ code: "reviewer_not_configured" });
  });

  it("keeps bounded latest review results by task", () => {
    const store = new ReviewStore(1);
    const result = new ReviewValidator().validate(
      validDraft(),
      task().acceptanceCriteria,
      passingValidation(),
    );
    store.set("T1", result);
    store.set("T2", { ...result, summary: "newer" });

    expect(store.get("T1")).toBeUndefined();
    expect(store.get("T2")?.summary).toBe("newer");
  });
});

function validDraft(): ReviewResultDraft {
  return {
    status: "passed",
    summary: "Pagination criteria are satisfied",
    findings: [],
    criteria: task().acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "satisfied",
      reason: "The bounded diff provides evidence",
    })),
  };
}

function reviewerWith(
  responses: readonly object[],
  generate = vi.fn(),
  events = new EventBus<NyxaraEventMap>(),
): Reviewer {
  const providers = new ProviderRegistry();
  providers.register(fakeProvider(responses, generate));
  return new Reviewer(providers, events);
}

function reviewerWithRaw(
  responses: readonly string[],
  events: EventBus<NyxaraEventMap>,
): Reviewer {
  const providers = new ProviderRegistry();
  providers.register(fakeProviderRaw(responses));
  return new Reviewer(providers, events);
}

function fakeProvider(
  responses: readonly object[],
  generate = vi.fn(),
): ModelProvider {
  let index = 0;
  generate.mockImplementation(async (request: GenerateRequest): Promise<GenerateResponse> => ({
    id: "provider-native-id",
    provider: "fake",
    model: request.model,
    text: JSON.stringify(responses[index++] ?? responses.at(-1)),
  }));
  return providerBase(generate);
}

function fakeProviderRaw(responses: readonly string[]): ModelProvider {
  let index = 0;
  return providerBase(async (request) => ({
    provider: "fake",
    model: request.model,
    text: responses[index++] ?? responses.at(-1) ?? "",
  }));
}

function providerBase(
  generate: ModelProvider["generate"],
): ModelProvider {
  return {
    id: "fake",
    displayName: "Fake Reviewer",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      structuredOutput: true,
    }),
    listModels: async () => [
      {
        id: "reviewer-model",
        name: "Reviewer Model",
        provider: "fake",
        capabilities: { text: true, structuredOutput: true, tools: true },
      },
    ],
    generate,
  };
}

function runInput() {
  const reviewEvidence = new ReviewEvidenceBuilder().build({
    requirement: "Add pagination",
    objective: "Paginate notifications",
    task: task(),
    execution: execution(),
    validation: passingValidation(),
    contexts: [context("export const page = 1;", "executor")],
  });
  return {
    input: {
      requirement: "Add pagination",
      objective: "Paginate notifications",
      task: task(),
      execution: execution(),
      validation: passingValidation(),
      evidence: reviewEvidence,
    },
    model: {
      role: "reviewer" as const,
      providerId: "fake",
      modelId: "reviewer-model",
    },
  };
}
