import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { CliSubscriptionProvider, NodeClaudeAgentSdkCatalog, NodeCliProcessRunner, NodeCodexAppServerCatalog, type ClaudeModelCatalog, type CliProcessRunner, type CliRunResult, type CodexAppServerProcess, type CodexModelCatalog } from "../src/cli-subscription/cli-subscription-provider.js";

function runner(...results: Array<CliRunResult | Error>): CliProcessRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => {
      const result = results.shift();
      if (result instanceof Error) throw result;
      if (!result) throw new Error("Missing fake CLI result");
      return result;
    }),
  };
}

const ok = (stdout: string): CliRunResult => ({ exitCode: 0, stdout, stderr: "" });
const envelope = JSON.stringify({ text: "{\"status\":\"completed\",\"summary\":\"done\"}", toolCalls: [], finishReason: "stop" });
const codexCatalog = (models = [{ id: "gpt-next/exact", name: "GPT Next", provider: "codex-cli", capabilities: { text: true, reasoning: true, tools: true, structuredOutput: true, execution: { kind: "openai_reasoning" as const, label: "Reasoning" as const, control: "select" as const, values: [{ value: "low", label: "Low" }, { value: "ultra", label: "Ultra" }], provenance: "provider_discovery" as const } } }]): CodexModelCatalog => ({ listModels: vi.fn(async () => models) });
const claudeCatalog = (models = [{ id: "sonnet", name: "Sonnet", provider: "claude-code-cli", capabilities: { text: true, reasoning: true, tools: true, structuredOutput: true, execution: { kind: "anthropic_effort" as const, label: "Effort" as const, control: "select" as const, values: [{ value: "low", label: "Low" }, { value: "max", label: "Max" }], provenance: "provider_discovery" as const } } }]): ClaudeModelCatalog => ({ listModels: vi.fn(async () => models) });

describe("CliSubscriptionProvider", () => {
  it("uses Codex subscription auth status and JSONL without exposing cached tokens", async () => {
    const process = runner(ok("Logged in using ChatGPT"), ok([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: envelope } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } }),
    ].join("\n")));
    const provider = new CliSubscriptionProvider({ kind: "codex-cli", runner: process, codexModelCatalog: codexCatalog() });
    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({ id: "gpt-next/exact", name: "GPT Next", provider: "codex-cli", capabilities: expect.objectContaining({ execution: expect.objectContaining({ provenance: "provider_discovery" }) }) })]);
    await expect(provider.generate({ model: "default", prompt: "work" })).resolves.toMatchObject({ provider: "codex-cli", text: "{\"status\":\"completed\",\"summary\":\"done\"}", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
    expect(process.run.mock.calls[0]?.[0]).toMatchObject({ command: "codex", args: ["login", "status"] });
    expect(process.run.mock.calls[1]?.[0].args).toEqual(expect.arrayContaining(["exec", "-", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--json"]));
    expect(process.run.mock.calls[1]?.[0].stdin).toContain("Do not call or execute any CLI built-in tools");
  });

  it("uses provider-discovered Codex reasoning values without normalizing exact model IDs", async () => {
    const process = runner(ok("Logged in using ChatGPT"), ok([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: envelope } }),
    ].join("\n")));
    const provider = new CliSubscriptionProvider({ kind: "codex-cli", runner: process, codexModelCatalog: codexCatalog() });
    expect(provider.capabilities().modelDiscovery).toBe(true);
    const models = await provider.listModels();
    expect(models[0]?.id).toBe("gpt-next/exact");
    await provider.generate({ model: "gpt-next/exact", prompt: "work", executionOptions: { kind: "openai_reasoning", effort: "ultra" } });
    expect(process.run.mock.calls[1]?.[0].args).toEqual(expect.arrayContaining(["--model", "gpt-next/exact", "--config", "model_reasoning_effort=\"ultra\""]));
  });

  it("speaks the official Codex app-server model/list protocol with pagination", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const lifecycle = new EventEmitter();
    const sent: any[] = [];
    const stdin = new EventEmitter() as EventEmitter & { write(chunk: string): boolean };
    stdin.write = (chunk: string) => {
      const message = JSON.parse(chunk) as any;
      sent.push(message);
      queueMicrotask(() => {
        if (message.method === "initialize") stdout.emit("data", Buffer.from(`${JSON.stringify({ id: message.id, result: { userAgent: "fake" } })}\n`));
        if (message.method === "model/list") {
          const second = message.params.cursor === "page-2";
          const model = second
            ? { id: "gpt-new/exact", displayName: "GPT New", isDefault: false, supportedReasoningEfforts: [] }
            : { id: "gpt-default", displayName: "GPT Default", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }, { reasoningEffort: "xhigh", description: "XHigh" }] };
          stdout.emit("data", Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [model], nextCursor: second ? null : "page-2" } })}\n`));
        }
      });
      return true;
    };
    const child: CodexAppServerProcess = { stdin, stdout, stderr, on: (event, listener) => lifecycle.on(event, listener), kill: vi.fn(() => true) };
    const catalog = new NodeCodexAppServerCatalog(undefined, () => child);
    await expect(catalog.listModels({ command: process.execPath, cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 64_000, providerId: "codex-work" })).resolves.toEqual([
      expect.objectContaining({ id: "gpt-default", provider: "codex-work", capabilities: expect.objectContaining({ execution: expect.objectContaining({ values: [{ value: "low", label: "Low" }, { value: "xhigh", label: "Xhigh" }], provenance: "provider_discovery" }) }) }),
      expect.objectContaining({ id: "gpt-new/exact", provider: "codex-work", capabilities: { text: true, tools: true, structuredOutput: true } }),
    ]);
    expect(sent.map((message) => message.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
    expect(sent.at(-1).params.cursor).toBe("page-2");
  });

  it("uses Claude Agent SDK supportedModels and preserves exact selector values", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const lifecycle = new EventEmitter();
    const sent: any[] = [];
    let spawned: { args?: readonly string[]; env?: NodeJS.ProcessEnv } = {};
    const stdin = new EventEmitter() as EventEmitter & { write(chunk: string): boolean };
    stdin.write = (chunk: string) => {
      const message = JSON.parse(chunk) as any;
      sent.push(message);
      queueMicrotask(() => stdout.emit("data", Buffer.from(`${JSON.stringify({
        type: "control_response",
        response: {
          request_id: message.request_id,
          subtype: "success",
          response: { models: [
            { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-sonnet-5", supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ["low", "medium", "max"] },
            { value: "claude-fable-5[1m]", displayName: "Fable", resolvedModel: "claude-fable-5", supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ["high"] },
            { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5-20251001", supportsAdaptiveThinking: false, supportsEffort: false },
          ] },
        },
      })}\n`)));
      return true;
    };
    const child: CodexAppServerProcess = { stdin, stdout, stderr, on: (event, listener) => lifecycle.on(event, listener), kill: vi.fn(() => true) };
    const catalog = new NodeClaudeAgentSdkCatalog(undefined, (_command, args, options) => { spawned = { args, env: options.env }; return child; });
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "must-not-propagate";
    try {
      await expect(catalog.listModels({ command: "claude", cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 64_000, providerId: "claude-work" })).resolves.toEqual([
        expect.objectContaining({
          id: "default",
          name: "Default (recommended)",
          provider: "claude-work",
          capabilities: expect.objectContaining({
            execution: {
              kind: "anthropic_effort",
              label: "Effort",
              control: "select",
              values: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "max", label: "Max" }],
              provenance: "provider_discovery",
            },
          }),
        }),
        expect.objectContaining({ id: "claude-fable-5[1m]", name: "Fable" }),
        expect.objectContaining({ id: "haiku", capabilities: { text: true, tools: true, structuredOutput: true } }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    }
    expect(sent).toEqual([{ request_id: "nyxara-supported-models", type: "control_request", request: { subtype: "initialize" } }]);
    expect(spawned.args).toEqual(["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--tools", ""]);
    expect(spawned.env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
    expect(spawned.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("normalizes Claude Code subscription output and simulates native tool calls", async () => {
    const response = JSON.stringify({ text: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } }], finishReason: "tool_calls" });
    const process = runner(ok(JSON.stringify({ result: response, usage: { input_tokens: 8, output_tokens: 2 } })));
    const provider = new CliSubscriptionProvider({ kind: "claude-code-cli", runner: process, claudeModelCatalog: claudeCatalog() });
    await expect(provider.generate({ model: "sonnet", prompt: "work", tools: [{ name: "read_file", description: "read", inputSchema: {} }] })).resolves.toMatchObject({
      provider: "claude-code-cli", model: "sonnet", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } }], usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    expect(process.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(["--safe-mode", "--tools", "", "--permission-mode", "dontAsk", "--model", "sonnet"]));
  });

  it("projects Claude-discovered effort values and passes only a selected supported value", async () => {
    const process = runner(ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })), ok(JSON.stringify({ result: envelope, usage: {} })));
    const provider = new CliSubscriptionProvider({ kind: "claude-code-cli", runner: process, claudeModelCatalog: claudeCatalog() });
    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({ id: "sonnet", capabilities: expect.objectContaining({ execution: expect.objectContaining({ kind: "anthropic_effort", provenance: "provider_discovery" }) }) })]);
    await provider.generate({ model: "sonnet", prompt: "work", executionOptions: { kind: "anthropic_effort", effort: "max" } });
    expect(process.run.mock.calls[1]?.[0].args).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "max"]));
  });

  it("accepts only account-backed Codex and Claude login status", async () => {
    const codexApiKey = runner(ok("Logged in using an API key"));
    await expect(new CliSubscriptionProvider({ kind: "codex-cli", runner: codexApiKey, codexModelCatalog: codexCatalog() }).listModels()).rejects.toMatchObject({ code: "authentication_error" });
    const claudeApiKey = runner(ok(JSON.stringify({ loggedIn: true, authMethod: "api_key" })));
    await expect(new CliSubscriptionProvider({ kind: "claude-code-cli", runner: claudeApiKey }).listModels()).rejects.toMatchObject({ code: "authentication_error" });
    const claudeAccount = runner(ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })));
    await expect(new CliSubscriptionProvider({ kind: "claude-code-cli", runner: claudeAccount, claudeModelCatalog: claudeCatalog() }).listModels()).resolves.toHaveLength(1);
  });

  it("removes API-billing environment variables from subscription subprocesses", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fake-api-key-that-must-not-propagate";
    try {
      const result = await new NodeCliProcessRunner().run({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"], cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 1024 });
      expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("normalizes Gemini CLI JSON and keeps its tools in non-executing plan mode", async () => {
    const process = runner(ok(JSON.stringify({ response: envelope, stats: {} })));
    const provider = new CliSubscriptionProvider({ kind: "gemini-cli", runner: process });
    await expect(provider.generate({ model: "default", prompt: "work" })).resolves.toMatchObject({ provider: "gemini-cli", finishReason: "stop" });
    expect(process.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--approval-mode", "plan", "--allowed-tools", ""]));
  });

  it("maps missing binaries, login failures, and subscription limits without leaking CLI output", async () => {
    const missing = runner(Object.assign(new Error("spawn gemini ENOENT /secret"), { code: "ENOENT" }));
    await expect(new CliSubscriptionProvider({ kind: "gemini-cli", runner: missing }).listModels()).rejects.toMatchObject({ code: "provider_not_installed" });
    const login = runner({ exitCode: 1, stdout: "", stderr: "Not logged in: hidden-token" });
    await expect(new CliSubscriptionProvider({ kind: "codex-cli", runner: login }).listModels()).rejects.toMatchObject({ code: "authentication_error", message: expect.not.stringContaining("hidden-token") });
    const limited = runner({ exitCode: 1, stdout: "", stderr: "Usage limit reached for private-account" });
    await expect(new CliSubscriptionProvider({ kind: "claude-code-cli", runner: limited }).generate({ model: "default", prompt: "work" })).rejects.toMatchObject({ code: "rate_limit_error", message: expect.not.stringContaining("private-account") });
  });

  it("rejects malformed envelopes instead of treating them as executable output", async () => {
    const process = runner(ok(JSON.stringify({ result: "not-json", usage: {} })));
    await expect(new CliSubscriptionProvider({ kind: "claude-code-cli", runner: process }).generate({ model: "default", prompt: "work" })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("consumes documented Codex JSONL events as safe progress and never scrapes human output", async () => {
    const lines = [
      "\u001b[36mThinking…\u001b[0m spinner frame",
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "rm -rf /" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rm -rf /" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: envelope } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }),
    ];
    const streaming: CliProcessRunner = {
      run: async (input) => {
        if (input.args[0] === "login") return ok("Logged in using ChatGPT");
        for (const line of lines) input.onOutputLine?.(line);
        return ok(lines.join("\n"));
      },
    };
    const provider = new CliSubscriptionProvider({ kind: "codex-cli", runner: streaming, codexModelCatalog: codexCatalog() });
    expect(provider.capabilities().progressStreaming).toBe(true);
    const events: any[] = [];
    await provider.generate({ model: "default", prompt: "work", onProgress: (event) => events.push(event) });
    expect(events.map((event) => event.phase)).toEqual(["request_started", "response_started", "tool_execution_started", "tool_execution_completed", "output_receiving", "request_completed"]);
    // Progress carries phases only: no model text, no command arguments, no spinner text.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("summary");
    expect(serialized).not.toContain("Thinking");
  });

  it("declares documented JSONL progress for Claude Code and Gemini CLI", async () => {
    const claude = new CliSubscriptionProvider({ kind: "claude-code-cli", runner: runner(), claudeModelCatalog: claudeCatalog() });
    const gemini = new CliSubscriptionProvider({ kind: "gemini-cli", runner: runner() });
    expect(claude.capabilities().progressStreaming).toBe(true);
    expect(gemini.capabilities().progressStreaming).toBe(true);
  });

  it("uses only structured Claude JSONL phases and ignores human spinner output", async () => {
    const process = runner(ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })), ok(JSON.stringify({ result: envelope, usage: { input_tokens: 5, output_tokens: 1 } })));
    const provider = new CliSubscriptionProvider({ kind: "claude-code-cli", runner: process, claudeModelCatalog: claudeCatalog() });
    await provider.listModels();
    const onProgress = vi.fn();
    await provider.generate({ model: "default", prompt: "work", onProgress });
    expect(onProgress.mock.calls.map(([event]) => event.phase)).toEqual(["request_started", "request_completed"]);
  });

  it("consumes documented Claude and Gemini JSONL without exposing raw events", async () => {
    const claudeLines = [
      "\u001b[2Kspinner private-account",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }] } }),
      JSON.stringify({ type: "result", result: envelope, usage: { input_tokens: 2, cache_read_input_tokens: 126000, cache_creation_input_tokens: 1000, output_tokens: 2048 } }),
    ];
    const claudeRunner: CliProcessRunner = { run: async (input) => { for (const line of claudeLines) input.onOutputLine?.(line); return ok(claudeLines.join("\n")); } };
    const claude = new CliSubscriptionProvider({ kind: "claude-code-cli", runner: claudeRunner, claudeModelCatalog: claudeCatalog() });
    const claudeProgress: any[] = [];
    const claudeResponse = await claude.generate({ model: "sonnet", prompt: "x", onProgress: (event) => claudeProgress.push(event) });
    expect(claudeResponse.usage).toEqual({ inputTokens: 2, outputTokens: 2048, cacheReadTokens: 126000, cacheWriteTokens: 1000, totalTokens: 129050 });
    expect(claudeProgress.map((event) => event.phase)).toEqual(["request_started", "response_started", "request_completed"]);
    expect(JSON.stringify(claudeProgress)).not.toMatch(/hidden|private-account|assistant/);

    const geminiLines = [JSON.stringify({ type: "init" }), JSON.stringify({ type: "message", role: "assistant", content: "raw private result" }), JSON.stringify({ type: "result", response: envelope, stats: {} })];
    const geminiRunner: CliProcessRunner = { run: async (input) => { for (const line of geminiLines) input.onOutputLine?.(line); return ok(geminiLines.join("\n")); } };
    const gemini = new CliSubscriptionProvider({ kind: "gemini-cli", runner: geminiRunner });
    const geminiProgress: any[] = [];
    await gemini.generate({ model: "default", prompt: "x", onProgress: (event) => geminiProgress.push(event) });
    expect(geminiProgress.map((event) => event.phase)).toEqual(["request_started", "output_receiving", "request_completed"]);
    expect(JSON.stringify(geminiProgress)).not.toContain("raw private result");
  });

  it("cancels a running CLI process through the existing AbortSignal", async () => {
    const controller = new AbortController();
    const pending = new NodeCliProcessRunner().run({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: tmpdir(), timeoutMs: 5_000, maxOutputBytes: 1024, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  });
});
