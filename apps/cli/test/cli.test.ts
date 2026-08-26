import {
  EventBus,
  NyxaraOrchestrator,
  TaskGraph,
  type NyxaraEventMap,
} from "@nyxara/core";
import type { ModelProvider } from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  runCli,
  runExecuteCli,
  runInspectCli,
  runPlanCli,
  type CliIO,
} from "../src/cli.js";

describe("Nyxara CLI", () => {
  it("selects and consumes providers without provider-specific workflow logic", async () => {
    const generate = vi.fn(async () => ({
      provider: "fake",
      model: "model-1",
      text: "Normalized response",
    }));
    const provider: ModelProvider = {
      id: "fake",
      displayName: "Fake Provider",
      capabilities: () => ({ modelDiscovery: true, textGeneration: true }),
      listModels: async () => [
        { id: "model-1", name: "Model One", provider: "fake" },
      ],
      generate,
    };
    const nyxara = new NyxaraOrchestrator({ providers: [provider] });
    const answers = ["1", "model-1", "hello"];
    const output: string[] = [];
    const io: CliIO = {
      write(message) {
        output.push(message);
      },
      async question() {
        return answers.shift() ?? "";
      },
    };

    await runCli(io, nyxara);

    expect(generate).toHaveBeenCalledWith({
      model: "model-1",
      prompt: "hello",
    });
    expect(output.join("")).toContain("Fake Provider (fake)");
    expect(output.join("")).toContain("Model One (model-1)");
    expect(output.join("")).toContain("Response:\nNormalized response");
  });
});

describe("Nyxara inspect CLI", () => {
  it("renders a Core-produced ContextBundle without repository logic", async () => {
    const output: string[] = [];
    const inspectRepository = vi.fn(async () => ({
      workspaceRoot: "/workspace",
      prompt: "notification API",
      files: [
        {
          path: "src/notification.service.ts",
          content: "hidden source",
          reason: 'path matched "notification"',
          size: 13,
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
      totalBytes: 13,
      estimatedTokens: 4,
      truncated: false,
    }));
    const nyxara = { inspectRepository } as unknown as NyxaraOrchestrator;
    const io: CliIO = {
      write(message) {
        output.push(message);
      },
      async question() {
        return "";
      },
    };

    await runInspectCli(io, nyxara, "/workspace", "notification API");

    expect(inspectRepository).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      prompt: "notification API",
    });
    expect(output.join("")).toContain("NYXARA REPOSITORY INSPECT");
    expect(output.join("")).toContain("src/notification.service.ts");
    expect(output.join("")).not.toContain("hidden source");
  });
});

describe("Nyxara plan CLI", () => {
  it("requests and renders a Core-produced plan without owning planning logic", async () => {
    const events = new EventBus<NyxaraEventMap>();
    const configureAgent = vi.fn();
    const createPlan = vi.fn(async () => {
      events.emit("context.completed", {
        workspaceRoot: "/workspace",
        fileCount: 2,
        estimatedTokens: 120,
        truncated: false,
      });
      events.emit("planner.started", {
        providerId: "fake",
        modelId: "model-1",
        contextFileCount: 2,
      });
      events.emit("planner.completed", {
        providerId: "fake",
        modelId: "model-1",
        planId: "18d64629-e102-4b50-9a7d-23ea14e99891",
        taskCount: 2,
      });

      const plan = {
        id: "18d64629-e102-4b50-9a7d-23ea14e99891",
        objective: "Add pagination",
        tasks: [
          {
            id: "T1",
            title: "Analyze notification flow",
            description: "Understand the existing behavior.",
            dependencies: [],
            acceptanceCriteria: ["Current flow is documented"],
          },
          {
            id: "T2",
            title: "Plan pagination changes",
            description: "Define the bounded implementation work.",
            dependencies: ["T1"],
            acceptanceCriteria: ["Affected modules are identified"],
          },
        ],
        createdAt: "2026-08-26T00:00:00.000Z",
      } as const;

      return {
        plan,
        context: {
          workspaceRoot: "/workspace",
          prompt: "Add pagination",
          files: [],
          git: {
            status: {
              isRepository: false,
              files: [],
              truncated: false,
            },
            diff: {
              isRepository: false,
              diff: "",
              files: [],
              truncated: false,
            },
          },
          totalBytes: 0,
          estimatedTokens: 0,
          truncated: false,
        },
        model: {
          role: "planner",
          providerId: "fake",
          modelId: "model-1",
        },
        graph: new TaskGraph(plan),
      };
    });
    const nyxara = {
      events,
      listProviders: () => [
        { id: "fake", displayName: "Fake Provider", capabilities: {} },
      ],
      listModels: async () => [
        { id: "model-1", name: "Model One", provider: "fake" },
      ],
      configureAgent,
      createPlan,
    } as unknown as NyxaraOrchestrator;
    const answers = ["1", "1"];
    const output: string[] = [];
    const io: CliIO = {
      write(message) {
        output.push(message);
      },
      async question() {
        return answers.shift() ?? "";
      },
    };

    await runPlanCli(io, nyxara, "/workspace", "Add pagination");

    expect(configureAgent).toHaveBeenCalledWith({
      role: "planner",
      providerId: "fake",
      modelId: "model-1",
    });
    expect(createPlan).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      prompt: "Add pagination",
    });
    expect(output.join("")).toContain("✓ Repository context built");
    expect(output.join("")).toContain("✓ Plan created");
    expect(output.join("")).toContain("Objective\nAdd pagination");
    expect(output.join("")).toContain("T2\nPlan pagination changes");
    expect(output.join("")).toContain("Depends on: T1");
  });
});

describe("Nyxara execute CLI", () => {
  it("selects roles and delegates one ready task to Core", async () => {
    const events = new EventBus<NyxaraEventMap>();
    const plan = {
      id: "18d64629-e102-4b50-9a7d-23ea14e99891",
      objective: "Add pagination",
      tasks: [
        {
          id: "T1",
          title: "Add pagination DTO",
          description: "Add page and limit fields.",
          dependencies: [],
          acceptanceCriteria: ["DTO exposes page and limit"],
        },
      ],
      createdAt: "2026-08-26T00:00:00.000Z",
    } as const;
    const configureAgent = vi.fn();
    const createPlan = vi.fn(async () => {
      events.emit("planner.completed", {
        planId: plan.id,
        providerId: "fake",
        modelId: "model-1",
        taskCount: 1,
      });
      return {
        plan,
        context: {} as never,
        model: { role: "planner", providerId: "fake", modelId: "model-1" },
        graph: new TaskGraph(plan),
      };
    });
    const executeTask = vi.fn(async () => {
      events.emit("executor.started", {
        taskId: "T1",
        providerId: "fake",
        modelId: "model-1",
        attempt: 1,
        contextFileCount: 1,
      });
      events.emit("tool.started", { tool: "apply_patch" });
      events.emit("executor.completed", {
        taskId: "T1",
        providerId: "fake",
        modelId: "model-1",
        changedFileCount: 1,
        toolCalls: 1,
        modelTurns: 2,
      });
      return {
        result: {
          taskId: "T1",
          status: "completed",
          summary: "Added pagination DTO",
          changedFiles: ["src/pagination.dto.ts"],
          toolCalls: 1,
          modelTurns: 2,
          diff: { files: ["src/pagination.dto.ts"], truncated: false },
          git: {} as never,
        },
        state: { taskId: "T1", status: "completed", attempts: 1 },
        context: {} as never,
        model: { role: "executor", providerId: "fake", modelId: "model-1" },
      } as const;
    });
    const nyxara = {
      events,
      listProviders: () => [
        { id: "fake", displayName: "Fake Provider", capabilities: {} },
      ],
      listModels: async () => [
        { id: "model-1", name: "Model One", provider: "fake" },
      ],
      configureAgent,
      createPlan,
      executeTask,
    } as unknown as NyxaraOrchestrator;
    const answers = ["1", "1", "1", "1"];
    const output: string[] = [];
    const io: CliIO = {
      write(message) {
        output.push(message);
      },
      async question() {
        return answers.shift() ?? "";
      },
    };

    await runExecuteCli(io, nyxara, "/workspace", "Add pagination");

    expect(configureAgent).toHaveBeenNthCalledWith(1, {
      role: "planner",
      providerId: "fake",
      modelId: "model-1",
    });
    expect(configureAgent).toHaveBeenNthCalledWith(2, {
      role: "executor",
      providerId: "fake",
      modelId: "model-1",
    });
    expect(executeTask).toHaveBeenCalledWith({
      plan,
      taskId: "T1",
      workspaceRoot: "/workspace",
    });
    expect(output.join("")).toContain("Executing T1");
    expect(output.join("")).toContain("  apply_patch");
    expect(output.join("")).toContain("- src/pagination.dto.ts");
  });
});
