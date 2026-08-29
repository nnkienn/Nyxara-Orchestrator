import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GenerateRequest,
  GenerateResponse,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NyxaraOrchestrator,
  type ExecutionPlan,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("Executor", () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-executor-"));
    outside = await mkdtemp(join(tmpdir(), "nyxara-executor-outside-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "notification.ts"),
      "export const notifications = [];\n",
    );
    await writeFile(join(outside, "secret.ts"), "secret\n");
    await symlink(join(outside, "secret.ts"), join(workspace, "escape.ts"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@nyxara.local"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["config", "user.name", "Nyxara Test"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("executes one ready task through normalized tools and derives Git evidence", async () => {
    const generate = vi.fn(async (request: GenerateRequest) => {
      if (!request.conversation) {
        expect(request.prompt).toContain("Assigned task T1");
        expect(request.prompt).not.toContain("Update notification queries");
        return response({
          toolCalls: [
            {
              id: "write-1",
              name: "write_file",
              arguments: {
                path: "src/pagination.ts",
                content: "export interface Pagination { page: number }\n",
              },
            },
          ],
        });
      }
      expect(request.conversation.at(-1)).toMatchObject({
        role: "tool",
        toolResult: {
          callId: "write-1",
          name: "write_file",
          result: { path: "src/pagination.ts", created: true },
        },
      });
      return response({
        text: JSON.stringify({
          status: "completed",
          summary: "Added the pagination contract",
        }),
      });
    });
    const nyxara = orchestrator(generate);
    const emitted: string[] = [];
    nyxara.events.on("task.execution_started", () => emitted.push("task.started"));
    nyxara.events.on("executor.started", () => emitted.push("executor.started"));
    nyxara.events.on("file.write_started", () => emitted.push("file.started"));
    nyxara.events.on("file.write_completed", () => emitted.push("file.completed"));
    nyxara.events.on("executor.completed", () => emitted.push("executor.completed"));
    nyxara.events.on("task.execution_completed", () => emitted.push("task.completed"));
    const plan = executionPlan();

    const executed = await nyxara.executeTask({
      plan,
      taskId: "T1",
      workspaceRoot: workspace,
    });

    expect(executed.result).toMatchObject({
      taskId: "T1",
      status: "completed",
      summary: "Added the pagination contract",
      changedFiles: ["src/pagination.ts"],
      toolCalls: 1,
      modelTurns: 2,
      diff: { truncated: false },
    });
    expect(executed.result.git.finalStatus.files).toContainEqual(
      expect.objectContaining({ path: "src/pagination.ts", status: "untracked" }),
    );
    expect(executed.state).toMatchObject({
      taskId: "T1",
      status: "completed",
      attempts: 1,
    });
    expect(executed.model).toEqual({
      role: "executor",
      providerId: "fake",
      modelId: "executor-model",
    });
    expect(nyxara.getTaskExecutionStates(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "T2", status: "ready" }),
      ]),
    );
    expect(emitted).toEqual([
      "task.started",
      "executor.started",
      "file.started",
      "file.completed",
      "executor.completed",
      "task.completed",
    ]);
    await expect(readFile(join(workspace, "src/pagination.ts"), "utf8")).resolves.toContain(
      "interface Pagination",
    );
  });

  it("returns a failed structured result after a recoverable tool failure", async () => {
    const generate = vi.fn(async (request: GenerateRequest) => {
      if (!request.conversation) {
        return response({
          toolCalls: [
            {
              id: "patch-1",
              name: "apply_patch",
              arguments: {
                patch: [
                  "--- a/src/notification.ts",
                  "+++ b/src/notification.ts",
                  "@@ -1 +1 @@",
                  "-missing content",
                  "+replacement",
                  "",
                ].join("\n"),
              },
            },
          ],
        });
      }
      expect(request.conversation.at(-1)).toMatchObject({
        role: "tool",
        toolResult: { error: { code: "patch_failed" } },
      });
      return response({
        text: JSON.stringify({
          status: "completed",
          summary: "The model claimed completion",
        }),
      });
    });
    const nyxara = orchestrator(generate);
    const patchFailed = vi.fn();
    const executorFailed = vi.fn();
    nyxara.events.on("patch.failed", patchFailed);
    nyxara.events.on("executor.failed", executorFailed);

    const executed = await nyxara.executeTask({
      plan: executionPlan(),
      taskId: "T1",
      workspaceRoot: workspace,
    });

    expect(executed.result).toMatchObject({
      status: "failed",
      changedFiles: [],
      summary: "Executor stopped with unresolved tool failures",
      unresolvedIssues: ["apply_patch failed with patch_failed"],
    });
    expect(executed.state.status).toBe("failed");
    expect(patchFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: "patch_failed" }),
    );
    expect(executorFailed).toHaveBeenCalledOnce();
    expect(nyxara.getTaskExecutionStates(executionPlan())).toContainEqual(
      expect.objectContaining({ taskId: "T2", status: "blocked" }),
    );
  });

  it("rejects unknown and blocked tasks before calling the model", async () => {
    const generate = vi.fn(async () => response({ text: "{}" }));
    const nyxara = orchestrator(generate);
    const plan = executionPlan();

    await expect(
      nyxara.executeTask({ plan, taskId: "missing", workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: "task_not_found" });
    await expect(
      nyxara.executeTask({ plan, taskId: "T2", workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: "task_blocked" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured Executor and unsupported tool capability", async () => {
    const generate = vi.fn(async () => response({ text: "{}" }));
    const unconfigured = new NyxaraOrchestrator({
      providers: [fakeProvider(generate)],
    });
    await expect(
      unconfigured.executeTask({
        plan: executionPlan(),
        taskId: "T1",
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: "executor_not_configured" });

    const unsupported = orchestrator(generate, false);
    const failed = vi.fn();
    unsupported.events.on("executor.failed", failed);
    await expect(
      unsupported.executeTask({
        plan: executionPlan(),
        taskId: "T1",
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: "unsupported_tool_calling" });
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ code: "unsupported_tool_calling" }),
    );
  });

  it("enforces tool-call and model-turn limits before executing tools", async () => {
    const twoCalls = vi.fn(async () =>
      response({
        toolCalls: [
          { id: "one", name: "git_status", arguments: {} },
          { id: "two", name: "git_status", arguments: {} },
        ],
      }),
    );
    await expect(
      orchestrator(twoCalls).executeTask({
        plan: executionPlan(),
        taskId: "T1",
        workspaceRoot: workspace,
        limits: { maxToolCallsPerTask: 1 },
      }),
    ).rejects.toMatchObject({ code: "tool_call_limit_exceeded" });

    const oneCall = vi.fn(async () =>
      response({
        toolCalls: [{ id: "one", name: "read_file", arguments: { path: "src/notification.ts" } }],
      }),
    );
    await expect(
      orchestrator(oneCall).executeTask({
        plan: { ...executionPlan(), id: "15aef544-8488-4121-a4d7-8477869f44e7" },
        taskId: "T1",
        workspaceRoot: workspace,
        limits: { maxModelTurnsPerTask: 1 },
      }),
    ).rejects.toMatchObject({ code: "model_turn_limit_exceeded" });
  });

  it.each([
    ["unknown tool", "unknown_tool", {}],
    ["sudo", "run_command", { command: "sudo", args: ["ls"] }],
    ["git push", "run_command", { command: "git", args: ["push"] }],
    ["destructive command", "run_command", { command: "rm", args: ["-rf", "/"] }],
  ])("rejects %s requests outside the Executor tool allowlist", async (_label, name, args) => {
    const generate = vi.fn(async () =>
      response({ toolCalls: [{ id: "unsafe", name, arguments: args }] }),
    );
    await expect(
      orchestrator(generate).executeTask({
        plan: executionPlan(),
        taskId: "T1",
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: "executor_error" });
  });

  it.each([
    ["../../outside.ts"],
    ["/etc/nyxara.ts"],
    ["escape.ts"],
    [".env"],
    ["private.key"],
  ])("denies unsafe Executor write path %s", async (path) => {
    const generate = vi.fn(async () =>
      response({
        toolCalls: [
          {
            id: "unsafe-write",
            name: "write_file",
            arguments: { path, content: "secret" },
          },
        ],
      }),
    );
    await expect(
      orchestrator(generate).executeTask({
        plan: executionPlan(),
        taskId: "T1",
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: "write_permission_denied" });
  });

  it("keeps the same permission boundary for automatic repair writes", async () => {
    let turn = 0;
    const generate = vi.fn(async (request: GenerateRequest) => {
      turn += 1;
      if (turn === 1) {
        return response({
          toolCalls: [
            {
              id: "initial-write",
              name: "write_file",
              arguments: {
                path: "src/initial.ts",
                content: "export const initial = true;\n",
              },
            },
          ],
        });
      }
      if (turn === 2) {
        return response({
          text: JSON.stringify({ status: "completed", summary: "Initial task done" }),
        });
      }
      expect(request.prompt).toContain("You are repairing an existing implementation.");
      if (turn === 3) {
        return response({
          toolCalls: [
            {
              id: "repair-unsafe-write",
              name: "write_file",
              arguments: { path: ".env", content: "SECRET=do-not-write\n" },
            },
          ],
        });
      }
      return response({
        text: JSON.stringify({ status: "completed", summary: "Claimed repair" }),
      });
    });
    const nyxara = orchestrator(generate);
    const executed = await nyxara.executeTask({
      plan: executionPlan(),
      taskId: "T1",
      workspaceRoot: workspace,
    });
    const repaired = await nyxara.repairTask({
      requirement: "Add notification pagination",
      objective: "Add pagination contract",
      plan: executionPlan(),
      taskId: "T1",
      workspaceRoot: workspace,
      execution: executed.result,
      validation: {
        status: "failed",
        packageManager: "pnpm",
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:00:01.000Z",
        durationMs: 1000,
        taskId: "T1",
        steps: [
          {
            kind: "typecheck",
            status: "failed",
            required: true,
            source: "discovered",
            durationMs: 100,
            stderr: "src/notification.ts(1,1): error TS2322: broken",
            errorCode: "validation_failed",
          },
        ],
      },
      executorContext: executed.context,
    });

    expect(repaired.status).toBe("failed");
    expect(repaired.finalValidation?.status).toBe("failed");
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("You are repairing") }),
    );
    await expect(readFile(join(workspace, ".env"), "utf8")).rejects.toThrow();
  });

  it("reports obvious concurrent workspace changes", async () => {
    let turn = 0;
    const generate = vi.fn(async () => {
      turn += 1;
      if (turn === 1) {
        return response({
          toolCalls: [
            {
              id: "write-1",
              name: "write_file",
              arguments: { path: "src/planned.ts", content: "planned\n" },
            },
          ],
        });
      }
      await writeFile(join(workspace, "src", "user-change.ts"), "concurrent\n");
      return response({
        text: JSON.stringify({ status: "completed", summary: "Done" }),
      });
    });

    await expect(
      orchestrator(generate).executeTask({
        plan: executionPlan(),
        taskId: "T1",
        workspaceRoot: workspace,
      }),
    ).rejects.toMatchObject({ code: "workspace_modified_unexpectedly" });
  });
});

function executionPlan(): ExecutionPlan {
  return {
    id: "c19bf1cb-9b2c-46d3-b72b-e5062927ed85",
    objective: "Add notification pagination",
    tasks: [
      {
        id: "T1",
        title: "Add pagination contract",
        description: "Create the bounded pagination types.",
        dependencies: [],
        acceptanceCriteria: ["Pagination has page and limit fields"],
        relevantFiles: ["src/notification.ts"],
      },
      {
        id: "T2",
        title: "Use pagination",
        description: "Update notification queries.",
        dependencies: ["T1"],
        acceptanceCriteria: ["Queries use pagination"],
      },
    ],
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function orchestrator(
  generate: (request: GenerateRequest) => Promise<GenerateResponse>,
  supportsTools = true,
): NyxaraOrchestrator {
  return new NyxaraOrchestrator({
    providers: [fakeProvider(generate, supportsTools)],
    agents: [
      { role: "executor", providerId: "fake", modelId: "executor-model" },
    ],
  });
}

function fakeProvider(
  generate: (request: GenerateRequest) => Promise<GenerateResponse>,
  supportsTools = true,
): ModelProvider {
  return {
    id: "fake",
    displayName: "Fake",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      toolCalling: supportsTools,
      structuredOutput: true,
    }),
    listModels: async () => [
      {
        id: "executor-model",
        name: "Executor Model",
        provider: "fake",
        capabilities: { text: true, tools: supportsTools, structuredOutput: true },
      },
    ],
    generate,
  };
}

function response(
  overrides: Partial<GenerateResponse>,
): GenerateResponse {
  return {
    provider: "fake",
    model: "executor-model",
    text: "",
    ...overrides,
  };
}
