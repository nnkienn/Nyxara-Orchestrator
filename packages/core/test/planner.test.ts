import type {
  GenerateRequest,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  EventBus,
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
});
