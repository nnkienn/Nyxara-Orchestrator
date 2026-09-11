import type {
  GenerateRequest,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  EventBus,
  DEFAULT_PLAN_STRUCTURE_BOUNDS,
  PlanValidator,
  Planner,
  ProviderRegistry,
  type ContextBundle,
  type NyxaraEventMap,
} from "../src/index.js";

function context(): ContextBundle {
  return {
    workspaceRoot: "/workspace",
    prompt: "Add pagination",
    files: [
      {
        path: "src/notification.service.ts",
        content: "export function listNotifications() {}",
        reason: 'path matched "notification"',
        size: 42,
        truncated: false,
      },
    ],
    git: {
      status: {
        isRepository: true,
        branch: "main",
        files: [],
        truncated: false,
      },
      diff: { isRepository: true, diff: "", files: [], truncated: false },
    },
    totalBytes: 42,
    estimatedTokens: 11,
    truncated: false,
  };
}

function validDraft(): object {
  return {
    objective: "Add pagination to notifications",
    summary: "Introduce bounded pagination without unrelated changes",
    tasks: [
      {
        id: "T1",
        title: "Analyze notification flow",
        description: "Identify current query and response boundaries",
        dependencies: [],
        acceptanceCriteria: ["Current flow is documented in task evidence"],
        relevantFiles: ["src/notification.service.ts"],
        risk: "low",
      },
      {
        id: "T2",
        title: "Implement pagination",
        description: "Add request handling and paginated query behavior",
        dependencies: ["T1"],
        acceptanceCriteria: ["Pagination behavior has explicit coverage"],
        risk: "medium",
      },
    ],
  };
}

function provider(response: object, generate = vi.fn()): ModelProvider {
  generate.mockImplementation(async (request: GenerateRequest) => ({
    provider: "fake",
    model: request.model,
    text: JSON.stringify(response),
  }));
  return {
    id: "fake",
    displayName: "Fake",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      structuredOutput: true,
    }),
    listModels: async () => [
      {
        id: "planner-model",
        name: "Planner Model",
        provider: "fake",
        capabilities: { text: true, structuredOutput: true },
      },
    ],
    generate,
  };
}

function providerText(text: string): ModelProvider {
  const value = provider(validDraft());
  return { ...value, generate: async (request) => ({ provider: "fake", model: request.model, text }) };
}

describe("Planner", () => {
  it("uses normalized ContextBundle and the selected provider/model", async () => {
    const generate = vi.fn();
    const providers = new ProviderRegistry();
    providers.register(provider(validDraft(), generate));
    const planner = new Planner(providers, new EventBus<NyxaraEventMap>());

    const plan = await planner.run({
      input: {
        prompt: "  Add pagination  ",
        workspaceRoot: "/workspace",
        context: context(),
        constraints: [" Preserve compatibility ", "Preserve compatibility"],
      },
      model: {
        role: "planner",
        providerId: "fake",
        modelId: "planner-model",
      },
    });

    expect(plan.objective).toBe("Add pagination to notifications");
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.tasks).toHaveLength(2);
    expect(generate).toHaveBeenCalledOnce();
    const request = generate.mock.calls[0]?.[0] as GenerateRequest;
    expect(request.model).toBe("planner-model");
    expect(request.responseFormat).toBe("json");
    // Planner content is business JSON. Native schemas are reserved for the
    // Executor tool bridge; passing one here changes CLI output semantics.
    expect(request.responseSchema).toBeUndefined();
    expect(request.prompt).toContain("src/notification.service.ts");
    expect(request.prompt).toContain("export function listNotifications");
    expect(request.prompt.match(/Preserve compatibility/g)).toHaveLength(1);
  });

  it("emits started, validation, and completed events", async () => {
    const providers = new ProviderRegistry();
    providers.register(provider(validDraft()));
    const events = new EventBus<NyxaraEventMap>();
    const lifecycle: string[] = [];
    events.on("planner.started", () => lifecycle.push("started"));
    events.on("plan.validation_started", () => lifecycle.push("validation_started"));
    events.on("plan.validation_passed", () => lifecycle.push("validation_passed"));
    events.on("planner.completed", () => lifecycle.push("completed"));

    await new Planner(providers, events).run({
      input: { prompt: "Add pagination", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "planner-model" },
    });

    expect(lifecycle).toEqual([
      "started",
      "validation_started",
      "validation_passed",
      "completed",
    ]);
  });

  it("emits failed events for invalid plans", async () => {
    const providers = new ProviderRegistry();
    providers.register(provider({ objective: "Invalid", tasks: [] }));
    const events = new EventBus<NyxaraEventMap>();
    const validationFailed = vi.fn();
    const plannerFailed = vi.fn();
    events.on("plan.validation_failed", validationFailed);
    events.on("planner.failed", plannerFailed);

    await expect(
      new Planner(providers, events).run({
        input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
        model: { role: "planner", providerId: "fake", modelId: "planner-model" },
      }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
    expect(validationFailed).toHaveBeenCalledOnce();
    expect(plannerFailed).toHaveBeenCalledOnce();
  });

  it.each([
    ["prose around JSON", `Here is the plan:\n${JSON.stringify(validDraft())}\nReady for approval.`],
    ["a plan wrapper", JSON.stringify({ plan: validDraft() })],
    ["a single result array", JSON.stringify([validDraft()])],
    ["a JSON string", JSON.stringify(JSON.stringify(validDraft()))],
    ["common snake_case fields", JSON.stringify({
      goal: "Add pagination",
      overview: "Keep the change bounded",
      steps: [{ task_id: "T1", title: "Implement", details: "Add pagination", acceptance_criteria: "Pagination is covered", relevant_files: "src/a.ts", risk: "LOW" }],
    })],
  ])("normalizes %s without weakening plan validation", async (_name, response) => {
    const providers = new ProviderRegistry();
    providers.register(providerText(response));
    const result = await new Planner(providers, new EventBus<NyxaraEventMap>()).run({
      input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "planner-model" },
    });
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.tasks[0]?.dependencies).toEqual([]);
  });

  it("reports the first safe invalid field while retaining semantic validation", async () => {
    const providers = new ProviderRegistry();
    providers.register(provider({ objective: "Invalid", tasks: [{ id: "T1", title: "Missing fields" }] }));
    await expect(new Planner(providers, new EventBus<NyxaraEventMap>()).run({
      input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "planner-model" },
    })).rejects.toMatchObject({ code: "invalid_plan", message: expect.stringContaining("tasks.0.description") });
  });

  it("handles unknown providers and models with controlled errors", async () => {
    const providers = new ProviderRegistry();
    const planner = new Planner(providers, new EventBus<NyxaraEventMap>());
    const input = { prompt: "Plan", workspaceRoot: "/workspace", context: context() };

    await expect(
      planner.run({
        input,
        model: { role: "planner", providerId: "missing", modelId: "model" },
      }),
    ).rejects.toMatchObject({ code: "unknown_provider" });

    providers.register(provider(validDraft()));
    await expect(
      planner.run({
        input,
        model: { role: "planner", providerId: "fake", modelId: "missing" },
      }),
    ).rejects.toMatchObject({ code: "invalid_model" });
  });
  it("passes a bounded role-specific output limit and never truncates plan JSON", async () => {
    const generate = vi.fn();
    const providers = new ProviderRegistry();
    providers.register(provider(validDraft(), generate));
    const planner = new Planner(providers, new EventBus<NyxaraEventMap>());
    const input = { prompt: "Plan", workspaceRoot: "/workspace", context: context() };
    const model = { role: "planner" as const, providerId: "fake", modelId: "planner-model" };
    await planner.run({ input, model, maxOutputTokens: 1_536 });
    // An unusably small configured bound is corrected to a safe minimum.
    await planner.run({ input, model, maxOutputTokens: 8 });
    await planner.run({ input, model });
    expect(generate.mock.calls[0]![0].maxOutputTokens).toBe(1_536);
    expect(generate.mock.calls[1]![0].maxOutputTokens).toBe(1_024);
    expect(generate.mock.calls[2]![0].maxOutputTokens).toBe(4_096);
  });

  it("rejects an oversized plan rather than accepting a truncated one", async () => {
    const oversized = {
      objective: "Add pagination",
      tasks: Array.from({ length: 40 }, (_, index) => ({
        id: `T${index + 1}`,
        title: `Task ${index + 1}`,
        description: "Bounded description",
        dependencies: [],
        acceptanceCriteria: ["Covered"],
      })),
    };
    const providers = new ProviderRegistry();
    providers.register(provider(oversized));
    const planner = new Planner(providers, new EventBus<NyxaraEventMap>());
    await expect(planner.run({
      input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "planner-model" },
    })).rejects.toMatchObject({ code: "plan_bounds_exceeded" });
  });

  it("bounds acceptance criteria per task", async () => {
    const oversized = {
      objective: "Add pagination",
      tasks: [{
        id: "T1", title: "Task", description: "Bounded description", dependencies: [],
        acceptanceCriteria: Array.from({ length: 20 }, (_, index) => `Criterion ${index}`),
      }],
    };
    const providers = new ProviderRegistry();
    providers.register(provider(oversized));
    const planner = new Planner(providers, new EventBus<NyxaraEventMap>());
    await expect(planner.run({
      input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "planner-model" },
    })).rejects.toMatchObject({ code: "plan_bounds_exceeded" });
  });

  it.each([
    ["task title", (draft: any) => { draft.tasks[0].title = "x".repeat(DEFAULT_PLAN_STRUCTURE_BOUNDS.maxTitleCharacters + 1); }],
    ["task description", (draft: any) => { draft.tasks[0].description = "x".repeat(DEFAULT_PLAN_STRUCTURE_BOUNDS.maxDescriptionCharacters + 1); }],
    ["criterion length", (draft: any) => { draft.tasks[0].acceptanceCriteria[0] = "x".repeat(DEFAULT_PLAN_STRUCTURE_BOUNDS.maxAcceptanceCriterionCharacters + 1); }],
    ["risk count", (draft: any) => { draft.risks = Array.from({ length: DEFAULT_PLAN_STRUCTURE_BOUNDS.maxRisks + 1 }, () => ({ description: "Risk", severity: "low" })); }],
    ["mitigation length", (draft: any) => { draft.risks = [{ description: "Risk", severity: "low", mitigation: "x".repeat(DEFAULT_PLAN_STRUCTURE_BOUNDS.maxRiskMitigationCharacters + 1) }]; }],
  ])("rejects plans beyond the %s structural bound", (_name, mutate) => {
    const draft: any = {
      ...validDraft(),
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-09-06T00:00:00.000Z",
    };
    mutate(draft);
    expect(() => new PlanValidator().validate(draft)).toThrowError(
      expect.objectContaining({ code: "plan_bounds_exceeded" }),
    );
  });

  it("keeps a normal structured plan valid within bounds", async () => {
    const providers = new ProviderRegistry();
    providers.register(provider(validDraft()));
    const planner = new Planner(providers, new EventBus<NyxaraEventMap>());
    const plan = await planner.run({
      input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "planner-model" },
      maxOutputTokens: 1_536,
    });
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]!.dependencies).toEqual(["T1"]);
  });
});
