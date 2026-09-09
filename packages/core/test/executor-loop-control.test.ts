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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NyxaraOrchestrator,
  type ContextBundle,
  type ExecutionPlan,
  type PlannedTask,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("Executor bounded progress loop", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-executor-loop-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "target.ts"), "export const target = 1;\n");
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        join(workspace, "src", `evidence-${index}.ts`),
        `export const evidence${index} = ${index};\n${`// evidence-${index}\n`.repeat(240)}`,
      );
    }
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@nyxara.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Nyxara Test"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("allows more than the old read ceiling while progress continues, then patches", async () => {
    const requests: GenerateRequest[] = [];
    let round = 0;
    const generate = vi.fn(async (request: GenerateRequest) => {
      requests.push(request);
      const current = round++;
      if (current < 6) {
        const indexes = current === 1
          ? [0, 5, 6, 7, 8]
          : Array.from({ length: 5 }, (_, offset) => current * 5 + offset);
        return response({
          toolCalls: indexes.map((index, offset) => ({
            id: `read-${current}-${offset}`,
            name: "read_file",
            arguments: { path: `src/evidence-${index}.ts`, maxBytes: 24 * 1024 },
          })),
          usage: { inputTokens: 100 },
        });
      }
      if (current === 6) {
        return response({
          toolCalls: [{
            id: "patch-target",
            name: "apply_patch",
            arguments: {
              patch: [
                "--- a/src/target.ts",
                "+++ b/src/target.ts",
                "@@ -1 +1 @@",
                "-export const target = 1;",
                "+export const target = 2;",
                "",
              ].join("\n"),
            },
          }],
          usage: { inputTokens: 100 },
        });
      }
      return response({
        text: JSON.stringify({ status: "completed", summary: "Audited dependencies and updated target" }),
        usage: { inputTokens: 100 },
      });
    });
    const core = orchestrator(generate);
    const approvedPlan = plan({
        executionMode: "implementation",
        title: "Audit dependencies and update target",
        description: "Inspect repository evidence before updating src/target.ts.",
        relevantFiles: ["src/target.ts"],
      }, 7);
    const workflow = core.startWorkflow({ workspace, prompt: "Run the approved seven-task repository plan" });
    const internal = core as unknown as {
      planRuntime: { register(plan: ExecutionPlan, workflowId: string): unknown };
      workflowEngine: { transition(workflowId: string, status: string, patch?: object): unknown };
    };
    internal.planRuntime.register(approvedPlan, workflow.id);
    internal.workflowEngine.transition(workflow.id, "planning");
    internal.workflowEngine.transition(workflow.id, "awaiting_plan_approval", { planId: approvedPlan.id });
    core.approvePlan(workflow.id, approvedPlan.id);
    const executed = await core.executeTask({
      workflowId: workflow.id,
      plan: approvedPlan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: await emptyContext(core, workspace),
    });

    expect(executed.result).toMatchObject({
      status: "completed",
      changedFiles: ["src/target.ts"],
      toolCalls: 31,
      modelTurns: 8,
      toolCallsByCategory: { read: 30, mutation: 1, validation: 0 },
      contextMetrics: {
        providerCalls: 8,
        duplicateEvidenceRemoved: 1,
        providerReportedInputTokens: 800,
      },
    });
    const metrics = executed.result.contextMetrics!;
    expect(metrics.contextBytesPerRound).toHaveLength(8);
    expect(Math.max(...metrics.contextBytesPerRound)).toBeLessThanOrEqual(192 * 1024);
    expect(Math.max(...metrics.estimatedInputTokensPerRound)).toBeLessThanOrEqual(48 * 1024);
    expect(metrics.droppedEvidenceCount).toBeGreaterThan(0);
    expect(requests.slice(1).every((request) => (request.conversation?.length ?? 0) <= 6)).toBe(true);

    const legacyRounds = requests.slice(0, 6);
    const accumulated: unknown[] = [];
    const legacyContextBytes = legacyRounds.map((request) => {
      accumulated.push(...(request.conversation ?? []));
      return Buffer.byteLength(JSON.stringify({ prompt: requests[0]!.prompt, conversation: accumulated }), "utf8");
    });
    console.info("EXECUTOR_SCENARIO_METRICS", JSON.stringify({
      before: {
        providerCalls: 6,
        toolCalls: 25,
        contextBytesPerRound: legacyContextBytes,
        estimatedInputTokensPerRound: legacyContextBytes.map((bytes) => Math.ceil(bytes / 4)),
        duplicateEvidenceRemoved: 0,
        filesChanged: 0,
      },
      after: {
        providerCalls: metrics.providerCalls,
        toolCalls: executed.result.toolCalls,
        contextBytesPerRound: metrics.contextBytesPerRound,
        estimatedInputTokensPerRound: metrics.estimatedInputTokensPerRound,
        duplicateEvidenceRemoved: metrics.duplicateEvidenceRemoved,
        filesChanged: executed.result.changedFiles.length,
      },
    }));
  });

  it("keeps a final hard ceiling independent of progress", async () => {
    const generate = vi.fn(async () => response({
      toolCalls: [0, 1, 2].map((index) => ({ id: `read-${index}`, name: "read_file", arguments: { path: `src/evidence-${index}.ts` } })),
    }));
    await expect(orchestrator(generate).executeTask({
      plan: plan(), taskId: "T1", workspaceRoot: workspace,
      limits: { maxToolCallsPerTask: 2 },
    })).rejects.toMatchObject({ code: "tool_call_limit_exceeded" });
  });

  it("accounts provider calls and validation commands independently", async () => {
    let turn = 0;
    const core = orchestrator(async () => {
      if (turn++ === 0) return response({ toolCalls: [{ id: "syntax", name: "run_command", arguments: { command: process.execPath, args: ["--check", "src/target.ts"] } }] });
      if (turn === 2) return response({ toolCalls: [{ id: "write", name: "write_file", arguments: { path: "src/result.ts", content: "export const result = true;\n" } }] });
      return response({ text: JSON.stringify({ status: "completed", summary: "Validated and implemented" }) });
    });
    const executed = await core.executeTask({
      plan: plan(), taskId: "T1", workspaceRoot: workspace,
      resolvePermission: async () => "allow",
    });
    expect(executed.result).toMatchObject({
      toolCallsByCategory: { read: 0, mutation: 1, validation: 1 },
      contextMetrics: { providerCalls: 3 },
    });

    let providerRound = 0;
    const providerBound = orchestrator(async () => response({
      toolCalls: [{ id: `progress-${providerRound}`, name: "read_file", arguments: { path: `src/evidence-${providerRound++}.ts` } }],
    }));
    await expect(providerBound.executeTask({
      plan: plan(), taskId: "T1", workspaceRoot: workspace,
      plannerContext: await emptyContext(providerBound, workspace),
      limits: { maxProviderCallsPerTask: 2 },
    })).rejects.toMatchObject({ code: "provider_call_limit_exceeded" });
    expect(providerRound).toBe(2);
  });

  it("deduplicates an identical search and stops the no-progress loop truthfully", async () => {
    let call = 0;
    const generate = vi.fn(async () => {
      const first = { id: `search-${call++}`, name: "search_code", arguments: { query: "evidence-1", maxResults: 5 } };
      return response({
        toolCalls: call === 1
          ? [first, { ...first, id: `search-${call++}` }]
          : [first],
      });
    });
    const core = orchestrator(generate);
    const plannerContext = await emptyContext(core, workspace);
    const searches = vi.fn();
    const failed = vi.fn();
    core.events.on("tool.started", (event) => { if (event.tool === "search_code") searches(); });
    core.events.on("executor.failed", failed);

    await expect(core.executeTask({
      plan: plan(), taskId: "T1", workspaceRoot: workspace,
      plannerContext,
    })).rejects.toMatchObject({
      code: "executor_stalled",
      message: "Executor stalled: repeated tool activity produced no new evidence.",
    });
    expect(searches).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      contextMetrics: expect.objectContaining({ duplicateEvidenceRemoved: 4 }),
    }));
  });

  it("deduplicates the same file range but lets distinct reads reset progress", async () => {
    let repeatedRound = 0;
    const repeated = orchestrator(async () => response({
      toolCalls: [{ id: `same-${repeatedRound++}`, name: "read_file", arguments: { path: "src/evidence-20.ts", startLine: 1, endLine: 20 } }],
    }));
    const reads = vi.fn();
    repeated.events.on("tool.started", (event) => { if (event.tool === "read_file") reads(); });
    await expect(repeated.executeTask({
      plan: plan(), taskId: "T1", workspaceRoot: workspace,
      plannerContext: await emptyContext(repeated, workspace),
    })).rejects.toMatchObject({ code: "executor_stalled" });
    expect(reads).toHaveBeenCalledOnce();

    let current = 0;
    const progressive = orchestrator(async () => {
      if (current < 7) {
        const index = current++;
        return response({ toolCalls: [{ id: `new-${index}`, name: "read_file", arguments: { path: `src/evidence-${20 + index}.ts` } }] });
      }
      if (current++ === 7) return response({ toolCalls: [{ id: "write", name: "write_file", arguments: { path: "src/new.ts", content: "export const value = true;\n" } }] });
      return response({ text: JSON.stringify({ status: "completed", summary: "Used new evidence" }) });
    });
    const executed = await progressive.executeTask({
      plan: plan({ executionMode: "implementation" }), taskId: "T1", workspaceRoot: workspace,
      plannerContext: await emptyContext(progressive, workspace),
      limits: { maxConsecutiveNoProgressToolCalls: 2, maxNoProgressModelTurns: 2 },
    });
    expect(executed.result).toMatchObject({ status: "completed", toolCalls: 8 });
  });

  it("bounds file evidence and retains only the latest raw tool exchange", async () => {
    await writeFile(join(workspace, "src", "huge.ts"), "x".repeat(100_000));
    const requests: GenerateRequest[] = [];
    let turn = 0;
    const core = orchestrator(async (request) => {
      requests.push(request);
      if (turn++ === 0) return response({ toolCalls: [{ id: "huge", name: "read_file", arguments: { path: "src/huge.ts", maxBytes: 1_000_000 } }] });
      return response({ text: JSON.stringify({ status: "completed", summary: "Read bounded evidence" }) });
    });
    const executed = await core.executeTask({
      plan: plan({ executionMode: "read_only" }), taskId: "T1", workspaceRoot: workspace,
      plannerContext: await emptyContext(core, workspace),
    });
    const toolResult = requests[1]!.conversation?.at(-1);
    expect(Buffer.byteLength(JSON.stringify(toolResult), "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(requests[1]!.conversation).toHaveLength(2);
    expect(requests[1]!.prompt).not.toContain("x".repeat(30_000));
    expect(executed.result.contextMetrics?.executorContextBytes).toBeLessThanOrEqual(192 * 1024);
  });

  it("accepts zero additional changes on retry when a relevant partial change is present", async () => {
    let providerCall = 0;
    const core = orchestrator(async () => {
      providerCall += 1;
      if (providerCall === 1) return response({ toolCalls: [{ id: "partial", name: "write_file", arguments: { path: "src/target.ts", content: "export const target = 2;\n" } }] });
      if (providerCall === 2) throw Object.assign(new Error("provider interrupted"), { code: "provider_error" });
      return response({ text: JSON.stringify({ status: "completed", summary: "Existing partial implementation is complete" }) });
    });
    const executionPlan = plan({ relevantFiles: ["src/target.ts"] });
    await expect(core.executeTask({ plan: executionPlan, taskId: "T1", workspaceRoot: workspace })).rejects.toThrow("provider interrupted");
    const retried = await core.executeTask({ plan: executionPlan, taskId: "T1", workspaceRoot: workspace });
    expect(retried).toMatchObject({
      state: { attempts: 2, status: "completed" },
      result: { status: "completed", changedFiles: [], modelTurns: 1 },
    });
  });
});

function plan(overrides: Partial<PlannedTask> = {}, taskCount = 1): ExecutionPlan {
  const first: PlannedTask = {
    id: "T1",
    title: "Implement target change",
    description: "Use repository evidence and update the target.",
    executionMode: "implementation",
    dependencies: [],
    acceptanceCriteria: ["The target is updated"],
    relevantFiles: [],
    ...overrides,
  };
  return {
    id: "4ce29734-46f7-4af5-8da0-ea2d94ed9b70",
    objective: "Implement a bounded repository update",
    tasks: [
      first,
      ...Array.from({ length: Math.max(0, taskCount - 1) }, (_, offset): PlannedTask => ({
        id: `T${offset + 2}`,
        title: `Audit follow-up ${offset + 2}`,
        description: "Inspect the preceding result without repository mutation.",
        executionMode: "read_only",
        dependencies: [`T${offset + 1}`],
        acceptanceCriteria: ["The audit result is recorded"],
      })),
    ],
    createdAt: "2026-09-09T00:00:00.000Z",
  };
}

function orchestrator(generate: (request: GenerateRequest) => Promise<GenerateResponse>): NyxaraOrchestrator {
  const provider: ModelProvider = {
    id: "fake",
    displayName: "Fake",
    capabilities: () => ({ modelDiscovery: true, textGeneration: true, toolCalling: true, structuredOutput: true }),
    listModels: async () => [{ id: "executor", name: "Executor", provider: "fake", capabilities: { tools: true, structuredOutput: true } }],
    generate,
  };
  return new NyxaraOrchestrator({
    providers: [provider],
    agents: [{ role: "executor", providerId: "fake", modelId: "executor" }],
  });
}

async function emptyContext(core: NyxaraOrchestrator, workspaceRoot: string): Promise<ContextBundle> {
  const context = await core.inspectRepository({ workspaceRoot, prompt: "neutral" });
  return { ...context, files: [], totalBytes: Buffer.byteLength(context.git.diff.diff, "utf8"), estimatedTokens: 0 };
}

function response(overrides: Partial<GenerateResponse>): GenerateResponse {
  return { provider: "fake", model: "executor", text: "", ...overrides };
}
