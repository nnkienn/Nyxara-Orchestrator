import type { GenerateRequest, GenerateResponse, ModelProvider } from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import { EventBus, Planner, ProviderRegistry, PlanValidator, DEFAULT_PLAN_STRUCTURE_BOUNDS, type ContextBundle, type NyxaraEventMap } from "../src/index.js";

const draft = {
  objective: "Fix the dark planet atmosphere",
  tasks: [{
    id: "T1", title: "Adjust the rim", description: "Adjust only the atmosphere falloff.",
    dependencies: [], acceptanceCriteria: ["The dark rim matches the reference"],
  }],
};
const json = JSON.stringify(draft);
const context: ContextBundle = {
  workspaceRoot: "/workspace", prompt: "Fix the dark planet atmosphere", files: [],
  git: {
    status: { isRepository: false, files: [], truncated: false },
    diff: { isRepository: false, diff: "", files: [], truncated: false },
  },
  totalBytes: 0, estimatedTokens: 0, truncated: false,
};

function runResponse(text: string, finishReason?: string, validator = new PlanValidator()) {
  const response: GenerateResponse = {
    provider: "gateway", model: "model", text, ...(finishReason ? { finishReason } : {}),
  };
  const generate = vi.fn(async (_request: GenerateRequest) => response);
  const listModels = vi.fn(async () => [{ id: "model", name: "Model", provider: "gateway" }]);
  const provider: ModelProvider = {
    id: "gateway", displayName: "Gateway", generate, listModels,
    capabilities: () => ({ modelDiscovery: true, textGeneration: true }),
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const events = new EventBus<NyxaraEventMap>();
  const completed = vi.fn();
  const failed = vi.fn();
  const received = vi.fn();
  events.on("planner.completed", completed);
  events.on("planner.failed", failed);
  events.on("provider.generation.completed", received);
  const result = new Planner(providers, events, undefined, validator).run({
    input: { prompt: "Fix the dark planet atmosphere", workspaceRoot: "/workspace", context },
    model: { role: "planner", providerId: "gateway", modelId: "model" },
    workflowId: "workflow-1", maxOutputTokens: 2_560,
  });
  return { result, generate, listModels, completed, failed, received };
}

describe("Planner gateway responses", () => {
  it("uses the actual validator bounds in generation instructions and normalization", async () => {
    const bounds = { ...DEFAULT_PLAN_STRUCTURE_BOUNDS, maxAcceptanceCriteriaPerTask: 2, maxAcceptanceCriterionCharacters: 30, maxObjectiveCharacters: 60, maxRelevantFilesPerTask: 4 };
    const run = runResponse(JSON.stringify({ ...draft, tasks: [{ ...draft.tasks[0], acceptanceCriteria: ["One", "Two", "Three", "Four"] }] }), "stop", new PlanValidator(bounds));
    const plan = await run.result;
    expect(plan.tasks[0]!.acceptanceCriteria).toEqual(["One\nTwo", "Three\nFour"]);
    const prompt = run.generate.mock.calls[0]![0].prompt;
    expect(prompt).toContain("2 acceptance criteria per task");
    expect(prompt).toContain("objective 60");
    expect(prompt).toContain("at most 4 relevant files");
    expect(prompt).toContain("1–2 entries, each at most 30 characters");
  });

  it("still validates dependencies after grouping criteria and emits no successful normalization", async () => {
    const run = runResponse(JSON.stringify({ ...draft, tasks: [{ ...draft.tasks[0], dependencies: ["missing"], acceptanceCriteria: Array.from({ length: 8 }, (_, index) => `Check ${index}`) }] }));
    await expect(run.result).rejects.toMatchObject({ code: "missing_dependency" });
    expect(run.completed).not.toHaveBeenCalled();
    expect(run.generate).toHaveBeenCalledOnce();
  });

  it.each([7, 8, 9, 10, 11, 12])("preserves all %s short criteria while fitting the six-row plan contract", async (count) => {
    const criteria = Array.from({ length: count }, (_, index) => `Điều kiện ${index + 1}: giữ nguyên nội dung và ngưỡng ${index + 1}.0`);
    const source = { ...draft, tasks: [{ ...draft.tasks[0], id: "T7", acceptanceCriteria: criteria }] };
    const snapshot = structuredClone(source);
    const run = runResponse(JSON.stringify(source), "stop");
    const plan = await run.result;
    const rows = plan.tasks[0]!.acceptanceCriteria;
    expect(rows).toHaveLength(6);
    expect(rows.flatMap(row => row.split("\n"))).toEqual(criteria);
    expect(rows.every(row => row.length <= 400 && row.split("\n").length <= 2)).toBe(true);
    expect(source).toEqual(snapshot);
    expect(run.generate).toHaveBeenCalledOnce();
    expect(run.completed).toHaveBeenCalledWith(expect.objectContaining({ acceptanceCriteriaGrouping: { tasks: 1, originalCriteria: count, groupedCriteria: 6 } }));
  });

  it("still rejects criteria that cannot fit without truncation or excessive grouping", async () => {
    for (const criteria of [Array.from({ length: 7 }, () => "x".repeat(200)), Array.from({ length: 13 }, (_, index) => `Criterion ${index}`)]) {
      const run = runResponse(JSON.stringify({ ...draft, tasks: [{ ...draft.tasks[0], acceptanceCriteria: criteria }] }));
      await expect(run.result).rejects.toMatchObject({ code: "plan_bounds_exceeded" });
      expect(run.completed).not.toHaveBeenCalled();
      expect(run.generate).toHaveBeenCalledOnce();
    }
  });

  it("allows an exact 400-character pair while preserving duplicate criteria", async () => {
    const criteria = ["a".repeat(199), "b".repeat(200), ...Array.from({ length: 5 }, () => "c".repeat(400))];
    const run = runResponse(JSON.stringify({ ...draft, tasks: [{ ...draft.tasks[0], acceptanceCriteria: criteria }] }));
    const plan = await run.result;
    expect(plan.tasks[0]!.acceptanceCriteria).toEqual([`${criteria[0]}\n${criteria[1]}`, ...criteria.slice(2)]);
  });

  it("ends the prompt with the plan-only contract without claiming JSON mode support or increasing the budget", async () => {
    const run = runResponse(json);
    await run.result;
    const request = run.generate.mock.calls[0]![0];
    expect(request.prompt).toContain("Final response contract: return exactly one complete JSON object");
    expect(request.prompt.endsWith("do not execute or produce them during planning.")).toBe(true);
    expect(request.responseFormat).toBeUndefined();
    expect(request.maxOutputTokens).toBe(2_560);
    expect(request.tools).toBeUndefined();
  });

  it.each([
    ["a JSON fence after prose containing braces", `Use {Fresnel} only.\n\n\`\`\`json\n${json}\n\`\`\`\nReady for approval.`],
    ["a fence after an unmatched prose brace", `The shape starts with {\n\`\`\`json\n${json}\n\`\`\``],
    ["a CRLF uppercase JSON fence", `Plan:\r\n  \`\`\`JSON\r\n${json}\r\n  \`\`\`\r\nDone.`],
    ["a plain fence around a wrapped plan", `Plan:\n\`\`\`\n${JSON.stringify({ plan: draft })}\n\`\`\``],
    ["metadata followed by a plan", `Metadata: {"format":"json"}\nFinal plan: ${json}`],
    ["non-JSON braces before a plan", `Use {Fresnel}. Final plan: ${json}`],
    ["a closed thinking block containing an unmatched brace", `<think>Consider {Fresnel\n</think>\n${json}`],
    ["a closed thinking block containing a draft", `<thinking>${JSON.stringify({ ...draft, objective: "Discarded draft" })}</thinking>\n${json}`],
    ["multiple closed thinking blocks", `<think>first</think>\n<thinking>second</thinking>\n${json}`],
    ["braces and escaped quotes inside strings", `Final: ${JSON.stringify({ ...draft, summary: 'Use {rim} and "falloff" with \\ escaping' })}`],
  ])("accepts %s without another provider request", async (_label, text) => {
    const run = runResponse(text, "stop");
    await expect(run.result).resolves.toMatchObject(draft);
    expect(run.generate).toHaveBeenCalledOnce();
    expect(run.listModels).toHaveBeenCalledOnce();
    expect(run.completed).toHaveBeenCalledOnce();
    expect(run.failed).not.toHaveBeenCalled();
  });

  it.each([
    ["prose without JSON", "I have fixed the issue."],
    ["an unfinished JSON object", json.slice(0, -1)],
    ["an invalid fenced object", `\`\`\`json\n{broken: ${json}}\n\`\`\``],
    ["two different plans", `${json}\n${JSON.stringify({ ...draft, objective: "Different plan" })}`],
    ["two fenced plans", `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``],
    ["an unclosed thinking block", `<think>Draft: ${json}`],
    ["only a closed thinking block", `<think>${json}</think>`],
  ])("rejects %s without repairing or retrying", async (_label, text) => {
    const run = runResponse(text);
    await expect(run.result).rejects.toMatchObject({ code: "plan_parse_error" });
    expect(run.generate).toHaveBeenCalledOnce();
    expect(run.completed).not.toHaveBeenCalled();
    expect(run.failed).toHaveBeenCalledOnce();
  });

  it.each(["length", "max_tokens", "MAX_TOKENS"])("reports the explicit %s stop as truncation, even for parseable JSON", async (finishReason) => {
    const run = runResponse(json, finishReason);
    await expect(run.result).rejects.toMatchObject({ code: "plan_response_truncated" });
    expect(run.generate).toHaveBeenCalledOnce();
    expect(run.completed).not.toHaveBeenCalled();
    expect(run.received).toHaveBeenCalledWith(expect.objectContaining({ finishReason, textLength: json.length }));
  });

  it.each(["", " \n\t"])("reports empty assistant text separately", async (text) => {
    const run = runResponse(text, "stop");
    await expect(run.result).rejects.toMatchObject({ code: "plan_response_empty" });
    expect(run.generate).toHaveBeenCalledOnce();
  });

  it("does not infer truncation from malformed JSON or expose response contents", async () => {
    const run = runResponse('secret-response-body {"objective":', "stop");
    await expect(run.result).rejects.toMatchObject({ code: "plan_parse_error", message: expect.not.stringContaining("secret-response-body") });
  });

  it.each([
    ["missing task fields", { objective: "Fix rim", tasks: [{ id: "T1" }] }, "invalid_plan"],
    ["missing dependencies", { ...draft, tasks: [{ ...draft.tasks[0], dependencies: ["missing"] }] }, "missing_dependency"],
    ["self dependencies", { ...draft, tasks: [{ ...draft.tasks[0], dependencies: ["T1"] }] }, "self_dependency"],
    ["empty tasks", { ...draft, tasks: [] }, "invalid_plan"],
  ])("still rejects %s after fence extraction", async (_label, invalid, code) => {
    const run = runResponse(`Ignore {prose}.\n\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``);
    await expect(run.result).rejects.toMatchObject({ code });
    expect(run.completed).not.toHaveBeenCalled();
  });
});
