import { ContextEngine, NyxaraOrchestrator, type ContextBundle } from "@nyxara/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/provider-config.js";
import { NyxaraSession } from "../src/session.js";

const draft = {
  objective: "Fix the dark planet atmosphere",
  tasks: [{ id: "T1", title: "Adjust atmosphere", description: "Match the reference rim.", dependencies: [], acceptanceCriteria: ["The comparison passes"] }],
};

function gatewaySession(text: string, finishReason = "stop", streaming?: boolean) {
  vi.useFakeTimers();
  const config = Object.freeze({ id: "gateway", type: "openai-compatible" as const, displayName: "Gateway", baseUrl: "https://router.invalid/v1", authStrategy: "api_key" as const, ...(streaming !== undefined ? { streaming } : {}) });
  const secrets = { get: vi.fn(async () => "test-only-key"), store: vi.fn(), delete: vi.fn() };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "route/model" }] }));
    if (JSON.parse(String(init?.body)).stream === true) {
      const events = [
        { model: "resolved-model", choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { choices: [{ delta: { content: text }, finish_reason: finishReason }] },
        { choices: [], usage: { prompt_tokens: 43, completion_tokens: 25, total_tokens: 68 } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ model: "resolved-model", choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason }] }));
  });
  const context: ContextBundle = {
    workspaceRoot: "/workspace", prompt: "Fix the dark planet atmosphere", files: [],
    git: { status: { isRepository: false, files: [], truncated: false }, diff: { isRepository: false, diff: "", files: [], truncated: false } },
    totalBytes: 0, estimatedTokens: 0, truncated: false,
  };
  vi.spyOn(ContextEngine.prototype, "build").mockResolvedValue(context);
  const core = new NyxaraOrchestrator({
    providers: [createProvider(config, secrets)],
    agents: ["planner", "executor", "reviewer"].map((role) => ({ role: role as "planner" | "executor" | "reviewer", providerId: config.id, modelId: "route/model" })),
  });
  const approve = vi.spyOn(core, "approvePlan");
  const execute = vi.spyOn(core, "runApprovedPlan");
  const output = { appendLine: vi.fn() };
  const session = new NyxaraSession({ secrets }, output, [], core);
  return { session, core, fetch, secrets, approve, execute, output };
}

describe("Planner gateway to VS Code workflow", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

  it("uses declared gateway streaming through Core and still waits for approval", async () => {
    const run = gatewaySession(JSON.stringify(draft), "stop", true);
    const progress = vi.fn();
    const received = vi.fn();
    run.core.events.on("provider.generation.progress", progress);
    run.core.events.on("provider.generation.completed", received);
    await run.session.generate("Fix the dark planet atmosphere", "/workspace", "default");
    expect(run.session.currentPlan).toMatchObject(draft);
    expect(run.session.snapshot?.status).toBe("awaiting_plan_approval");
    expect(run.approve).not.toHaveBeenCalled();
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(run.fetch.mock.calls[0]![1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: "route/model", max_tokens: 4096 });
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(["request_started", "response_started", "output_receiving", "request_completed"]);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ role: "planner", usage: { inputTokens: 43, outputTokens: 25, totalTokens: 68 } }));
    expect(run.secrets.store).not.toHaveBeenCalled();
    expect(run.secrets.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a streamed plan when the provider reports an output limit", async () => {
    const run = gatewaySession(JSON.stringify(draft), "length", true);
    await expect(run.session.generate("Fix the dark planet atmosphere", "/workspace", "default")).rejects.toMatchObject({ code: "plan_response_truncated" });
    expect(run.session.snapshot?.status).toBe("failed");
    expect(run.session.currentPlan).toBeUndefined();
    expect(run.approve).not.toHaveBeenCalled();
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.fetch).toHaveBeenCalledTimes(1);
  });

  it("groups eight short streamed criteria losslessly and still requires explicit approval", async () => {
    const criteria = Array.from({ length: 8 }, (_, index) => `Keep requirement ${index + 1} unchanged`);
    const response = { ...draft, tasks: [{ ...draft.tasks[0], acceptanceCriteria: criteria }] };
    const run = gatewaySession(JSON.stringify(response), "stop", true);
    await run.session.generate("Fix the dark planet atmosphere", "/workspace", "default");
    expect(run.session.currentPlan?.tasks[0]?.acceptanceCriteria).toHaveLength(6);
    expect(run.session.currentPlan?.tasks[0]?.acceptanceCriteria.flatMap(row => row.split("\n"))).toEqual(criteria);
    expect(run.session.snapshot?.status).toBe("awaiting_plan_approval");
    expect(run.approve).not.toHaveBeenCalled();
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.fetch).toHaveBeenCalledTimes(1);
    expect(run.output.appendLine).toHaveBeenCalledWith('Planner acceptance criteria grouped without dropping text: {"tasks":1,"originalCriteria":8,"groupedCriteria":6}');
    expect(run.secrets.store).not.toHaveBeenCalled();
    expect(run.secrets.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a wrapped gateway answer but still waits for explicit plan approval", async () => {
    const run = gatewaySession(`Use {Fresnel}.\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``);
    await run.session.generate("Fix the dark planet atmosphere", "/workspace", "default");
    expect(run.session.currentPlan).toMatchObject(draft);
    expect(run.session.snapshot?.status).toBe("awaiting_plan_approval");
    expect(run.approve).not.toHaveBeenCalled();
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.fetch).toHaveBeenCalledTimes(1);
    expect(String(run.fetch.mock.calls[0]![0])).toBe("https://router.invalid/v1/chat/completions");
    const body = JSON.parse(String(run.fetch.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ model: "route/model", stream: false, max_tokens: 4_096 });
    expect(body.response_format).toBeUndefined();
    expect(run.secrets.store).not.toHaveBeenCalled();
    expect(run.secrets.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(run.output.appendLine.mock.calls)).not.toContain("Fresnel");
  });

  it.each([
    ["not JSON", "stop", "plan_parse_error"],
    ["", "stop", "plan_response_empty"],
    [JSON.stringify(draft).slice(0, -1), "length", "plan_response_truncated"],
  ])("fails safely on %s without a retry, execution, or credential change", async (text, finishReason, code) => {
    const run = gatewaySession(text, finishReason);
    await expect(run.session.generate("Fix the dark planet atmosphere", "/workspace", "default")).rejects.toMatchObject({ code });
    expect(run.session.snapshot?.status).toBe("failed");
    expect(run.session.currentPlan).toBeUndefined();
    expect(run.fetch).toHaveBeenCalledTimes(1);
    expect(run.approve).not.toHaveBeenCalled();
    expect(run.execute).not.toHaveBeenCalled();
    expect(run.secrets.store).not.toHaveBeenCalled();
    expect(run.secrets.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
