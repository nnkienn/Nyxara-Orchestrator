import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GenerateRequest, GenerateResponse, ModelProvider } from "@nyxara/provider-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NyxaraOrchestrator } from "../src/index.js";

const execFileAsync = promisify(execFile);
const modelId = "runtime-model";

function reply(text = "", toolCalls?: GenerateResponse["toolCalls"]): GenerateResponse {
  return { provider: "runtime-fake", model: modelId, text, ...(toolCalls ? { toolCalls } : {}) };
}

describe("runtime control integration", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-runtime-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.js"), "export const base = true;\n");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "runtime-fixture", private: true, type: "module", scripts: { typecheck: "node --check src/index.js" } }));
    await writeFile(join(workspace, "package-lock.json"), "{}\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "runtime@nyxara.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Nyxara Runtime"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  });

  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

  it("pauses, resumes, waits for one sensitive action, and completes T1-T3 once", async () => {
    let plannerCalls = 0;
    let executorStarts = 0;
    let contextBuilds = 0;
    let workflowPermissionRequests = 0;
    const startedTasks: string[] = [];
    const provider: ModelProvider = {
      id: "runtime-fake",
      displayName: "Runtime Fake",
      capabilities: () => ({ modelDiscovery: true, textGeneration: true, toolCalling: true, structuredOutput: true }),
      listModels: async () => [{ id: modelId, name: "Runtime", provider: "runtime-fake", capabilities: { text: true, tools: true, structuredOutput: true } }],
      generate: async (request: GenerateRequest) => {
        if (request.prompt.includes("You are the Planner role")) {
          plannerCalls += 1;
          return reply(JSON.stringify({ objective: "Run three tasks", tasks: [
            { id: "T1", title: "Task one", description: "Create T1", dependencies: [], acceptanceCriteria: ["done"], relevantFiles: ["src/index.js"] },
            { id: "T2", title: "Task two", description: "Create environment setting", dependencies: ["T1"], acceptanceCriteria: ["done"], relevantFiles: [".env"] },
            { id: "T3", title: "Task three", description: "Create T3", dependencies: ["T2"], acceptanceCriteria: ["done"], relevantFiles: ["src/index.js"] },
          ] }));
        }
        if (request.prompt.includes("You are the Reviewer role")) return reply(JSON.stringify({ status: "passed", summary: "done", findings: [], criteria: [{ criterion: "done", status: "satisfied", reason: "done" }] }));
        if (request.conversation) return reply(JSON.stringify({ status: "completed", summary: "done" }));
        executorStarts += 1;
        if (request.prompt.includes("Task ID: T1")) return reply("", [{ id: "write-t1", name: "write_file", arguments: { path: "src/t1.js", content: "export const t1 = true;\n" } }]);
        if (request.prompt.includes("Task ID: T2")) return reply("", [{ id: "write-env", name: "write_file", arguments: { path: ".env", content: "RUNTIME_FLAG=1\n" } }]);
        return reply("", [{ id: "write-t3", name: "write_file", arguments: { path: "src/t3.js", content: "export const t3 = true;\n" } }]);
      },
    };
    const nyxara = new NyxaraOrchestrator({
      providers: [provider],
      agents: [
        { role: "planner", providerId: provider.id, modelId },
        { role: "executor", providerId: provider.id, modelId },
        { role: "reviewer", providerId: provider.id, modelId },
      ],
    });
    nyxara.events.on("context.started", () => { contextBuilds += 1; });
    nyxara.events.on("workflow.permission_requested", () => { workflowPermissionRequests += 1; });
    nyxara.events.on("workflow.task_started", ({ taskId }) => startedTasks.push(taskId));
    const workflow = nyxara.startWorkflow({ workspace, prompt: "Run three tasks" });
    const planned = await nyxara.createPlan({ workflowId: workflow.id, workspaceRoot: workspace, prompt: workflow.prompt });
    nyxara.approvePlan(workflow.id, planned.plan.id);
    const unsubscribe = nyxara.events.on("workflow.task_completed", ({ taskId }) => { if (taskId === "T1") nyxara.pauseWorkflow(workflow.id); });

    const paused = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: planned.plan.id });
    expect(paused.status).toBe("paused");
    unsubscribe();
    const waiting = await nyxara.resumeWorkflow(workflow.id);
    expect(waiting.status).toBe("waiting_for_permission");
    if (waiting.status !== "waiting_for_permission") throw new Error("expected permission");
    expect(waiting.permission).toMatchObject({ taskId: "T2", resource: ".env", capability: "create_workspace_file" });
    const completed = await nyxara.resolveWorkflowPermission({ workflowId: workflow.id, permissionRequestId: waiting.permission.id, decision: "allow" });

    expect(completed.status).toBe("completed");
    expect(startedTasks).toEqual(["T1", "T2", "T3"]);
    expect(executorStarts).toBe(3);
    expect(plannerCalls).toBe(1);
    expect(contextBuilds).toBe(1);
    expect(workflowPermissionRequests).toBe(1);
  });
});
