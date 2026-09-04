import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateUsage,
  type ModelInfo,
  type ModelProvider,
  type ModelToolCall,
  type ProviderCapabilities,
  type ProviderErrorCode,
} from "@nyxara/provider-sdk";

export type CliSubscriptionKind = "codex-cli" | "claude-code-cli" | "gemini-cli";

export interface CliRunInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliProcessRunner {
  run(input: CliRunInput): Promise<CliRunResult>;
}

export interface CliSubscriptionProviderConfig {
  readonly kind: CliSubscriptionKind;
  readonly id?: string;
  readonly displayName?: string;
  readonly runner?: CliProcessRunner;
  readonly timeoutMs?: number;
}

interface CliSpec {
  readonly command: string;
  readonly displayName: string;
  readonly statusArgs: readonly string[];
  readonly models: readonly { readonly id: string; readonly name: string }[];
  validateStatus(result: CliRunResult, providerId: string): void;
  generationArgs(model: string): readonly string[];
  responseText(stdout: string): { readonly text: string; readonly usage?: GenerateUsage };
}

const DEFAULT_MODEL = "default";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

export class CliSubscriptionProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly spec: CliSpec;
  private readonly runner: CliProcessRunner;
  private readonly timeoutMs: number;

  constructor(private readonly config: CliSubscriptionProviderConfig) {
    this.spec = cliSpec(config.kind);
    this.id = config.id ?? config.kind;
    this.displayName = config.displayName ?? this.spec.displayName;
    this.runner = config.runner ?? new NodeCliProcessRunner();
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  capabilities(): ProviderCapabilities {
    return { modelDiscovery: true, textGeneration: true, structuredOutput: true, toolCalling: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const result = await this.run(this.spec.statusArgs);
    this.spec.validateStatus(result, this.id);
    return this.spec.models.map((model) => ({
      ...model,
      provider: this.id,
      capabilities: { text: true, tools: true, structuredOutput: true },
    }));
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const prompt = providerPrompt(request);
    const result = await this.run(this.spec.generationArgs(request.model), prompt);
    let parsed: { readonly text: string; readonly usage?: GenerateUsage };
    try { parsed = this.spec.responseText(result.stdout); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("CLI returned an invalid response", { code: "invalid_response", providerId: this.id });
    }
    const envelope = parseEnvelope(parsed.text, this.id);
    return {
      provider: this.id,
      model: request.model,
      text: envelope.text,
      ...(envelope.toolCalls.length ? { toolCalls: envelope.toolCalls } : {}),
      ...(envelope.finishReason ? { finishReason: envelope.finishReason } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  }

  private async run(args: readonly string[], stdin?: string): Promise<CliRunResult> {
    const cwd = await mkdtemp(join(tmpdir(), "nyxara-cli-"));
    try {
      let result: CliRunResult;
      try {
        result = await this.runner.run({ command: this.spec.command, args, ...(stdin !== undefined ? { stdin } : {}), cwd, timeoutMs: this.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
      } catch (error) {
        const code = isRecord(error) && error.code === "ENOENT" ? "provider_not_installed" : isRecord(error) && error.code === "ETIMEDOUT" ? "timeout_error" : "provider_error";
        throw new ProviderError(code === "provider_not_installed" ? `${this.spec.command} CLI is not installed` : code === "timeout_error" ? `${this.displayName} CLI timed out` : `${this.displayName} CLI could not start`, { code, providerId: this.id });
      }
      if (result.exitCode !== 0) throw cliExitError(result, this.id, this.displayName);
      return result;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

export class NodeCliProcessRunner implements CliProcessRunner {
  run(input: CliRunInput): Promise<CliRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: subscriptionEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const append = (current: string, chunk: Buffer): string => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) {
          child.kill("SIGKILL");
          finish(() => reject(Object.assign(new Error("CLI output exceeded the safe limit"), { code: "EOUTPUTLIMIT" })));
        }
        return current + chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (exitCode) => finish(() => resolve({ exitCode: exitCode ?? 1, stdout, stderr })));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(Object.assign(new Error("CLI timed out"), { code: "ETIMEDOUT" })));
      }, input.timeoutMs);
      child.stdin.end(input.stdin ?? "");
    });
  }
}

function cliSpec(kind: CliSubscriptionKind): CliSpec {
  if (kind === "codex-cli") return {
    command: "codex",
    displayName: "OpenAI Codex (ChatGPT)",
    statusArgs: ["login", "status"],
    models: [{ id: DEFAULT_MODEL, name: "Codex CLI default" }],
    validateStatus: (result, providerId) => {
      if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) throw new ProviderError("Codex must be signed in with ChatGPT, not an API key", { code: "authentication_error", providerId });
    },
    generationArgs: (model) => ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", ...(model === DEFAULT_MODEL ? [] : ["--model", model]), "-"],
    responseText: parseCodexOutput,
  };
  if (kind === "claude-code-cli") return {
    command: "claude",
    displayName: "Claude Code (Claude account)",
    statusArgs: ["auth", "status"],
    models: [{ id: DEFAULT_MODEL, name: "Claude Code default" }],
    validateStatus: (result, providerId) => {
      let status: unknown;
      try { status = JSON.parse(result.stdout); } catch { status = undefined; }
      if (!isRecord(status) || status.loggedIn !== true || status.authMethod !== "claude.ai") throw new ProviderError("Claude Code must be signed in with a Claude account, not an API key", { code: "authentication_error", providerId });
    },
    generationArgs: (model) => ["--print", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--tools", "", "--permission-mode", "dontAsk", ...(model === DEFAULT_MODEL ? [] : ["--model", model])],
    responseText: parseClaudeOutput,
  };
  return {
    command: "gemini",
    displayName: "Gemini CLI (Google account)",
    statusArgs: ["--version"],
    models: [{ id: DEFAULT_MODEL, name: "Gemini CLI default" }],
    validateStatus: () => {},
    generationArgs: (model) => ["--prompt", "", "--output-format", "json", "--approval-mode", "plan", "--allowed-tools", "", ...(model === DEFAULT_MODEL ? [] : ["--model", model])],
    responseText: parseGeminiOutput,
  };
}

function providerPrompt(request: GenerateRequest): string {
  return [
    "You are the model backend inside Nyxara Orchestrator.",
    "Do not call or execute any CLI built-in tools. Nyxara alone executes tools after explicit policy checks.",
    "Return exactly one JSON object with this shape and no markdown: {\"text\":string,\"toolCalls\":[{\"id\":string,\"name\":string,\"arguments\":object}],\"finishReason\":string}.",
    "When tools are needed, return them in toolCalls and leave execution to Nyxara. Otherwise return an empty toolCalls array.",
    `Requested response format: ${request.responseFormat ?? "text"}`,
    `Available Nyxara tools: ${JSON.stringify(request.tools ?? [])}`,
    `Prior conversation: ${JSON.stringify(request.conversation ?? [])}`,
    `Request: ${request.prompt}`,
  ].join("\n\n");
}

function parseEnvelope(value: string, providerId: string): { text: string; toolCalls: ModelToolCall[]; finishReason?: string } {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); }
  catch { throw new ProviderError("CLI returned invalid structured output", { code: "invalid_response", providerId }); }
  if (!isRecord(parsed) || typeof parsed.text !== "string" || !Array.isArray(parsed.toolCalls)) throw new ProviderError("CLI returned an invalid response envelope", { code: "invalid_response", providerId });
  const toolCalls = parsed.toolCalls.map((value): ModelToolCall => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name || !isRecord(value.arguments)) throw new ProviderError("CLI returned an invalid tool call", { code: "invalid_response", providerId });
    return { id: value.id, name: value.name, arguments: value.arguments };
  });
  return { text: parsed.text, toolCalls, ...(typeof parsed.finishReason === "string" && parsed.finishReason ? { finishReason: parsed.finishReason } : {}) };
}

function parseCodexOutput(stdout: string): { text: string; usage?: GenerateUsage } {
  let text: string | undefined;
  let usage: GenerateUsage | undefined;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    const item = isRecord(event.item) ? event.item : undefined;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") text = item.text;
    if (event.type === "turn.completed" && isRecord(event.usage)) usage = tokenUsage(event.usage, "input_tokens", "output_tokens", "total_tokens");
  }
  if (!text) throw new Error("Codex CLI returned no final message");
  return { text, ...(usage ? { usage } : {}) };
}

function parseClaudeOutput(stdout: string): { text: string; usage?: GenerateUsage } {
  const payload = JSON.parse(stdout) as unknown;
  if (!isRecord(payload) || typeof payload.result !== "string") throw new Error("Claude Code returned no result");
  const usage = isRecord(payload.usage) ? tokenUsage(payload.usage, "input_tokens", "output_tokens") : undefined;
  return { text: payload.result, ...(usage ? { usage } : {}) };
}

function parseGeminiOutput(stdout: string): { text: string; usage?: GenerateUsage } {
  const payload = JSON.parse(stdout) as unknown;
  if (!isRecord(payload) || typeof payload.response !== "string") throw new Error("Gemini CLI returned no response");
  return { text: payload.response };
}

function tokenUsage(record: Record<string, unknown>, inputKey: string, outputKey: string, totalKey?: string): GenerateUsage | undefined {
  const inputTokens = finiteNumber(record[inputKey]);
  const outputTokens = finiteNumber(record[outputKey]);
  const totalTokens = totalKey ? finiteNumber(record[totalKey]) : inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;
  return inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined ? { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) } : undefined;
}

function cliExitError(result: CliRunResult, providerId: string, displayName: string): ProviderError {
  const output = `${result.stdout}\n${result.stderr}`;
  let code: ProviderErrorCode = "provider_error";
  if (/not logged in|login required|authentication|authenticate|unauthorized|sign in/i.test(output)) code = "authentication_error";
  else if (/rate.?limit|usage limit|quota|too many requests/i.test(output)) code = "rate_limit_error";
  return new ProviderError(code === "authentication_error" ? `${displayName} CLI login is required` : code === "rate_limit_error" ? `${displayName} subscription usage limit was reached` : `${displayName} CLI exited with an error`, { code, providerId });
}

function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]) delete env[key];
  return env;
}
