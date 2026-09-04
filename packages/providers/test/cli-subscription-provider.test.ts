import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { CliSubscriptionProvider, NodeCliProcessRunner, type CliProcessRunner, type CliRunResult } from "../src/cli-subscription/cli-subscription-provider.js";

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

describe("CliSubscriptionProvider", () => {
  it("uses Codex subscription auth status and JSONL without exposing cached tokens", async () => {
    const process = runner(ok("Logged in using ChatGPT"), ok([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: envelope } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } }),
    ].join("\n")));
    const provider = new CliSubscriptionProvider({ kind: "codex-cli", runner: process });
    await expect(provider.listModels()).resolves.toEqual([{ id: "default", name: "Codex CLI default", provider: "codex-cli", capabilities: { text: true, tools: true, structuredOutput: true } }]);
    await expect(provider.generate({ model: "default", prompt: "work" })).resolves.toMatchObject({ provider: "codex-cli", text: "{\"status\":\"completed\",\"summary\":\"done\"}", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
    expect(process.run.mock.calls[0]?.[0]).toMatchObject({ command: "codex", args: ["login", "status"] });
    expect(process.run.mock.calls[1]?.[0].args).toEqual(expect.arrayContaining(["exec", "-", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--json"]));
    expect(process.run.mock.calls[1]?.[0].stdin).toContain("Do not call or execute any CLI built-in tools");
  });

  it("normalizes Claude Code subscription output and simulates native tool calls", async () => {
    const response = JSON.stringify({ text: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } }], finishReason: "tool_calls" });
    const process = runner(ok(JSON.stringify({ result: response, usage: { input_tokens: 8, output_tokens: 2 } })));
    const provider = new CliSubscriptionProvider({ kind: "claude-code-cli", runner: process });
    await expect(provider.generate({ model: "sonnet", prompt: "work", tools: [{ name: "read_file", description: "read", inputSchema: {} }] })).resolves.toMatchObject({
      provider: "claude-code-cli", model: "sonnet", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } }], usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    expect(process.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(["--safe-mode", "--tools", "", "--permission-mode", "dontAsk", "--model", "sonnet"]));
  });

  it("accepts only account-backed Codex and Claude login status", async () => {
    const codexApiKey = runner(ok("Logged in using an API key"));
    await expect(new CliSubscriptionProvider({ kind: "codex-cli", runner: codexApiKey }).listModels()).rejects.toMatchObject({ code: "authentication_error" });
    const claudeApiKey = runner(ok(JSON.stringify({ loggedIn: true, authMethod: "api_key" })));
    await expect(new CliSubscriptionProvider({ kind: "claude-code-cli", runner: claudeApiKey }).listModels()).rejects.toMatchObject({ code: "authentication_error" });
    const claudeAccount = runner(ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })));
    await expect(new CliSubscriptionProvider({ kind: "claude-code-cli", runner: claudeAccount }).listModels()).resolves.toHaveLength(1);
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
    expect(process.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(["--output-format", "json", "--approval-mode", "plan", "--allowed-tools", ""]));
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
});
