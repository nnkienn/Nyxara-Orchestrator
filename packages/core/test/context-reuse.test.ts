import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GenerateRequest,
  GenerateResponse,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NyxaraOrchestrator,
  selectTaskContext,
  type ContextBundle,
  type ExecutionPlan,
  type PlannedTask,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const plan: ExecutionPlan = {
  id: "3c1f0b2a-1d4e-4c9a-9b3a-2f6d5e8c7a10",
  objective: "Add pagination to the notification API",
  tasks: [
    {
      id: "T1",
      title: "Add pagination metadata",
      description: "Return page, limit, and total metadata.",
      dependencies: [],
      acceptanceCriteria: ["Notification API exposes pagination metadata"],
      relevantFiles: ["src/notification.ts"],
    },
  ],
  createdAt: "2026-08-30T00:00:00.000Z",
};

const executorTurns = (request: GenerateRequest): GenerateResponse => {
  const base = { provider: "fake", model: "executor-model" };
  if (!request.conversation) {
    return {
      ...base,
      text: "",
      toolCalls: [
        {
          id: "write-1",
          name: "write_file",
          arguments: {
            path: "src/notification.ts",
            content:
              "export const notifications = [];\nexport const pagination = { page: 1, limit: 20 };\n",
          },
        },
      ],
    };
  }
  return {
    ...base,
    text: JSON.stringify({ status: "completed", summary: "Added pagination" }),
  };
};

function orchestrator(): NyxaraOrchestrator {
  const provider: ModelProvider = {
    id: "fake",
    displayName: "Fake",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      toolCalling: true,
      structuredOutput: true,
    }),
    listModels: async () => [
      {
        id: "executor-model",
        name: "Executor Model",
        provider: "fake",
        capabilities: { text: true, tools: true, structuredOutput: true },
      },
    ],
    generate: async (request) => executorTurns(request),
  };
  return new NyxaraOrchestrator({
    providers: [provider],
    agents: [
      { role: "executor", providerId: "fake", modelId: "executor-model" },
    ],
  });
}

describe("Executor context reuse", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-reuse-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "notification.ts"),
      "export const notifications = [];\n",
    );
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "t@nyxara.local"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["config", "user.name", "Nyxara"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function plannerContext(nyxara: NyxaraOrchestrator): Promise<ContextBundle> {
    return nyxara.inspectRepository({
      workspaceRoot: workspace,
      prompt: "Add pagination to the notification API",
    });
  }

  it("reuses Planner context and does not rebuild for a task with present files", async () => {
    const nyxara = orchestrator();
    const context = await plannerContext(nyxara);

    let rebuilds = 0;
    nyxara.events.on("context.started", () => (rebuilds += 1));

    const executed = await nyxara.executeTask({
      plan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: context,
    });

    expect(executed.contextSource).toBe("planner_reuse");
    expect(rebuilds).toBe(0);
    expect(executed.result.status).toBe("completed");
  });

  it("falls back to a bounded build when no Planner context exists", async () => {
    const nyxara = orchestrator();

    let rebuilds = 0;
    nyxara.events.on("context.started", () => (rebuilds += 1));

    const executed = await nyxara.executeTask({
      plan,
      taskId: "T1",
      workspaceRoot: workspace,
    });

    expect(executed.contextSource).toBe("build");
    expect(rebuilds).toBe(1);
  });

  it("rebuilds when the Planner context belongs to another workspace", async () => {
    const nyxara = orchestrator();
    const foreign: ContextBundle = {
      ...(await plannerContext(nyxara)),
      workspaceRoot: "/some/other/workspace",
    };

    let rebuilds = 0;
    nyxara.events.on("context.started", () => (rebuilds += 1));

    const executed = await nyxara.executeTask({
      plan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: foreign,
    });

    expect(executed.contextSource).toBe("build");
    expect(rebuilds).toBe(1);
  });

  it("uses targeted expansion when a relevant file is absent from Planner context", async () => {
    const nyxara = orchestrator();
    const context = await plannerContext(nyxara);
    // Drop the file the task needs so selection reports it missing.
    const trimmed: ContextBundle = {
      ...context,
      files: context.files.filter(
        (file) => file.path !== "src/notification.ts",
      ),
    };

    let rebuilds = 0;
    nyxara.events.on("context.started", () => (rebuilds += 1));

    const executed = await nyxara.executeTask({
      plan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: trimmed,
    });

    // Targeted expansion reads the missing path without a full repository scan.
    expect(executed.contextSource).toBe("targeted_expansion");
    expect(rebuilds).toBe(0);
  });
});

describe("Deterministic task context filtering", () => {
  const task: PlannedTask = plan.tasks[0]!;
  const bundle: ContextBundle = {
    workspaceRoot: "/workspace",
    prompt: "planner prompt",
    files: [
      {
        path: "src/notification.ts",
        content: "export const notifications = [];\n",
        reason: "current Git change",
        size: 40,
        truncated: false,
      },
      {
        path: "src/unrelated.ts",
        content: "export const unrelated = true;\n".repeat(200),
        reason: "code matched",
        size: 6000,
        truncated: false,
      },
    ],
    git: {
      status: { files: [] },
      diff: { diff: "", truncated: false },
    } as unknown as ContextBundle["git"],
    totalBytes: 6040,
    estimatedTokens: 1510,
    truncated: false,
  };

  it("prefers the exact relevant file and reports none missing", () => {
    const selection = selectTaskContext({ task, plannerContext: bundle });
    expect(selection.matchedRelevantFiles).toEqual(["src/notification.ts"]);
    expect(selection.missingRelevantFiles).toEqual([]);
    expect(selection.context.files[0]?.path).toBe("src/notification.ts");
  });

  it("respects the byte budget instead of copying the whole context", () => {
    const selection = selectTaskContext({
      task,
      plannerContext: bundle,
      budget: { maxFiles: 1, maxBytes: 2048, maxBytesPerFile: 2048 },
    });
    expect(selection.context.files).toHaveLength(1);
    expect(selection.context.totalBytes).toBeLessThanOrEqual(2048);
  });

  it("flags a relevant file that is absent from Planner context", () => {
    const missingTask: PlannedTask = {
      ...task,
      relevantFiles: ["src/absent.ts"],
    };
    const selection = selectTaskContext({
      task: missingTask,
      plannerContext: bundle,
    });
    expect(selection.missingRelevantFiles).toEqual(["src/absent.ts"]);
  });
});
