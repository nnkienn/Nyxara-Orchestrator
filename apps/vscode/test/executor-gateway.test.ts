import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NyxaraOrchestrator } from "@nyxara/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/provider-config.js";
import { NyxaraSession } from "../src/session.js";

const execFileAsync = promisify(execFile);

function stream(content: object | null, toolCall?: object): Response {
  const event = { model: "resolved-model", choices: [{ delta: content ? { content: JSON.stringify(content) } : { tool_calls: [toolCall] }, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

describe("VS Code gateway Executor recovery", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-gateway-retry-"));
    await writeFile(join(workspace, "README.md"), "Fixture\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(workspace, { recursive: true, force: true }); });

  it.each([404, 502])("keeps approval after HTTP %s, then executes native streamed tools with the corrected exact route", async (statusCode) => {
    const requests: Array<{ model: string; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> }> = [];
    let shouldFail = true;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://gateway.invalid/v1/chat/completions");
      const body = JSON.parse(String(init?.body)); requests.push(body);
      expect(body.stream).toBe(true);
      const prompt = body.messages[0].content as string;
      if (prompt.includes("You are the Planner role")) return stream({ objective: "Create the result", tasks: [{ id: "T1", title: "Write result", description: "Create result.txt", dependencies: [], acceptanceCriteria: ["result.txt exists"] }] });
      if (prompt.includes("You are the Reviewer role")) return stream({ status: "passed", summary: "result exists", findings: [], criteria: [{ criterion: "result.txt exists", status: "satisfied", reason: "present" }] });
      if (shouldFail) { shouldFail = false; return new Response("", { status: statusCode }); }
      if (body.messages.length === 1) return stream(null, { index: 0, id: "write-result", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "result.txt", content: "done\n" }) } });
      return stream({ status: "completed", summary: "Created result.txt" });
    });
    const secrets = { get: vi.fn(async () => "fixture-credential"), store: vi.fn(), delete: vi.fn() };
    const config = { id: "gateway", type: "openai-compatible", displayName: "Gateway", baseUrl: "https://gateway.invalid/v1", authStrategy: "api_key", streaming: true } as const;
    const core = new NyxaraOrchestrator({ providers: [createProvider(config, secrets)], agents: ["planner", "executor", "reviewer"].map((role) => ({ role: role as "planner" | "executor" | "reviewer", providerId: config.id, modelId: `route/${role}` })) });
    const validate = vi.spyOn(core, "validate").mockResolvedValue({ status: "passed", steps: [], packageManager: null, startedAt: "", completedAt: "", durationMs: 1 });
    const approve = vi.spyOn(core, "approvePlan");
    const output = { appendLine: vi.fn() };
    const session = new NyxaraSession({ secrets }, output, [], core);
    const plan = await session.generate("Create result.txt in the repository", workspace, "default");
    expect(requests).toHaveLength(1);
    expect(session.snapshot?.status).toBe("awaiting_plan_approval");
    expect(await session.approveAndRun()).toMatchObject({ status: "failed" });
    expect(output.appendLine).toHaveBeenCalledWith(`Executor failure: {"phase":"generation","statusCode":${statusCode}}`);
    expect(validate).not.toHaveBeenCalled();
    const retry = session.snapshot!.executionRetry!;
    expect(retry).toMatchObject({ planId: plan.plan.id, taskId: "T1", attempt: 2 });
    core.configureAgent({ role: "executor", providerId: config.id, modelId: "another-route/executor" });
    expect(await session.retryExecution({ workflowId: session.workflowId!, planId: retry.planId, taskId: retry.taskId })).toMatchObject({ status: "completed", changedFiles: ["result.txt"] });
    expect(session.plan).toBe(plan);
    expect(approve).toHaveBeenCalledOnce();
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("done\n");
    expect(requests.map((request) => request.model)).toEqual(["route/planner", "route/executor", "another-route/executor", "another-route/executor", "route/reviewer"]);
    expect(requests[2]!.tools?.map((tool) => tool.function.name)).toContain("run_command");
    expect(requests[3]!.messages.at(-1)).toMatchObject({ role: "tool" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(validate).toHaveBeenCalledOnce();
    expect(secrets.store).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  });
});
