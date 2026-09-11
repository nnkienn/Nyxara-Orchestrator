import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExecutionOptionsSupported,
  ProviderError,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateUsage,
  type ExecutionOptions,
  type ModelInfo,
  type ModelProvider,
  type ModelToolCall,
  type ProviderCapabilities,
  type ProviderErrorCode,
  type ProviderProgressEvent,
} from "@nyxara/provider-sdk";

export type CliSubscriptionKind = "codex-cli" | "claude-code-cli" | "gemini-cli";

export interface CliRunInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  /**
   * Called with each complete stdout line while the CLI runs. Only used for
   * CLIs with a documented machine-readable event stream; the caller parses
   * JSON events and ignores anything else, so human-oriented terminal output
   * is never scraped.
   */
  readonly onOutputLine?: (line: string) => void;
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
  readonly codexModelCatalog?: CodexModelCatalog;
  readonly claudeModelCatalog?: ClaudeModelCatalog;
  readonly timeoutMs?: number;
}

export interface CodexCatalogInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly providerId: string;
}

export interface CodexModelCatalog {
  listModels(input: CodexCatalogInput): Promise<readonly ModelInfo[]>;
}

export type ClaudeCatalogInput = CodexCatalogInput;

export interface ClaudeModelCatalog {
  listModels(input: ClaudeCatalogInput): Promise<readonly ModelInfo[]>;
}

export interface CodexAppServerProcess {
  readonly stdin: { write(chunk: string): unknown; on(event: string, listener: (...args: any[]) => void): unknown };
  readonly stdout: { on(event: string, listener: (...args: any[]) => void): unknown };
  readonly stderr: { on(event: string, listener: (...args: any[]) => void): unknown };
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly shell: false; readonly stdio: readonly ["pipe", "pipe", "pipe"] },
) => CodexAppServerProcess;

export type ClaudeAgentSdkProcess = CodexAppServerProcess;
export type ClaudeAgentSdkSpawn = CodexAppServerSpawn;

interface CliSpec {
  readonly command: string;
  readonly displayName: string;
  readonly statusArgs: readonly string[];
  readonly modelDiscovery: boolean;
  validateStatus(result: CliRunResult, providerId: string): void;
  generationArgs(model: string, executionOptions: ExecutionOptions, responseSchema?: string): readonly string[];
  responseText(stdout: string, toolEnvelope: boolean): { readonly text: string; readonly usage?: GenerateUsage };
  /**
   * Maps one line of a documented machine-readable CLI event stream to a safe
   * progress phase. Absent when a CLI has no documented event-stream contract.
   */
  readonly progressPhase?: (line: string) => ProviderProgressEvent | undefined;
}

/**
 * Alias meaning "let the CLI choose its own default model". Claude Code returns
 * this exact value in its supported-model list, so it is a real provider alias
 * rather than a Nyxara invention; omitting --model is how each CLI expresses it.
 */
const DEFAULT_MODEL_ALIAS = "default";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: Readonly<Record<CliSubscriptionKind, number>> = {
  "codex-cli": 180_000,
  "claude-code-cli": 600_000,
  "gemini-cli": 180_000,
};
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_MODEL_PAGES = 32;
const MAX_DISCOVERED_MODELS = 512;
const RESPONSE_ENVELOPE_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          argumentsJson: { type: "string" },
        },
        required: ["id", "name", "argumentsJson"],
        additionalProperties: false,
      },
    },
    finishReason: { type: "string" },
  },
  required: ["text", "toolCalls", "finishReason"],
  additionalProperties: false,
} as const;
const RESPONSE_ENVELOPE_SCHEMA_JSON = JSON.stringify(RESPONSE_ENVELOPE_SCHEMA);

export class CliSubscriptionProvider implements ModelProvider {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  private readonly spec: CliSpec;
  private readonly runner: CliProcessRunner;
  private readonly codexModelCatalog: CodexModelCatalog;
  private readonly claudeModelCatalog: ClaudeModelCatalog;
  private readonly timeoutMs: number;
  private readonly discoveredModelCapabilities = new Map<string, ModelInfo["capabilities"]>();

  constructor(private readonly config: CliSubscriptionProviderConfig) {
    this.spec = cliSpec(config.kind);
    this.id = config.id ?? config.kind;
    this.providerId = config.kind;
    this.displayName = config.displayName ?? this.spec.displayName;
    this.runner = config.runner ?? new NodeCliProcessRunner();
    this.codexModelCatalog = config.codexModelCatalog ?? new NodeCodexAppServerCatalog();
    this.claudeModelCatalog = config.claudeModelCatalog ?? new NodeClaudeAgentSdkCatalog();
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS[config.kind];
  }

  capabilities(): ProviderCapabilities {
    return {
      modelDiscovery: this.spec.modelDiscovery,
      textGeneration: true,
      structuredOutput: true,
      toolCalling: true,
      progressStreaming: this.spec.progressPhase !== undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const result = await this.run(this.spec.statusArgs);
    this.spec.validateStatus(result, this.id);
    if (this.config.kind === "codex-cli" || this.config.kind === "claude-code-cli") {
      const catalog = this.config.kind === "codex-cli" ? this.codexModelCatalog : this.claudeModelCatalog;
      const cwd = await mkdtemp(join(tmpdir(), this.config.kind === "codex-cli" ? "nyxara-codex-models-" : "nyxara-claude-models-"));
      try {
        const models = await catalog.listModels({ command: this.spec.command, cwd, timeoutMs: Math.min(this.timeoutMs, MODEL_DISCOVERY_TIMEOUT_MS), maxOutputBytes: MAX_OUTPUT_BYTES, providerId: this.id });
        this.discoveredModelCapabilities.clear();
        for (const model of models) if (model.capabilities) this.discoveredModelCapabilities.set(model.id, model.capabilities);
        return [...models];
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
    // This CLI exposes no documented machine-readable model list. Returning an
    // empty catalog keeps the absence honest instead of inventing a "default"
    // pseudo-model; clients fall back to manual model entry.
    return [];
  }

  modelCapabilities(modelId: string): ModelInfo["capabilities"] | undefined {
    return this.discoveredModelCapabilities.get(modelId);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const executionOptions = assertExecutionOptionsSupported(request.executionOptions, this.modelCapabilities(request.model)?.execution);
    const toolEnvelope = (request.tools?.length ?? 0) > 0;
    const prompt = providerPrompt(request, toolEnvelope);
    const progress = this.spec.progressPhase && request.onProgress ? request.onProgress : undefined;
    progress?.({ phase: "request_started" });
    const result = await this.run(
      async (cwd) => {
        let responseSchema: string | undefined;
        if ((toolEnvelope || request.responseSchema) && this.config.kind === "codex-cli") {
          responseSchema = join(cwd, "response-envelope.schema.json");
          await writeFile(responseSchema, JSON.stringify(toolEnvelope ? RESPONSE_ENVELOPE_SCHEMA : request.responseSchema), { encoding: "utf8", flag: "wx" });
        } else if ((toolEnvelope || request.responseSchema) && this.config.kind === "claude-code-cli") {
          responseSchema = JSON.stringify(toolEnvelope ? RESPONSE_ENVELOPE_SCHEMA : request.responseSchema);
        }
        return this.spec.generationArgs(request.model, executionOptions, responseSchema);
      },
      prompt,
      progress && this.spec.progressPhase
        ? (line) => {
            const event = this.spec.progressPhase?.(line);
            if (event) progress(event);
          }
        : undefined,
      request.signal,
    );
    progress?.({ phase: "request_completed" });
    let parsed: { readonly text: string; readonly usage?: GenerateUsage };
    try { parsed = this.spec.responseText(result.stdout, toolEnvelope); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("CLI returned an invalid response", { code: "invalid_response", providerId: this.id });
    }
    if (!toolEnvelope) return {
      provider: this.id,
      model: request.model,
      text: parsed.text,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
    const envelope = parseToolEnvelope(parsed.text, this.id);
    return {
      provider: this.id,
      model: request.model,
      text: envelope.text,
      ...(envelope.toolCalls.length ? { toolCalls: envelope.toolCalls } : {}),
      ...(envelope.finishReason ? { finishReason: envelope.finishReason } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  }

  private async run(args: readonly string[] | ((cwd: string) => Promise<readonly string[]>), stdin?: string, onOutputLine?: (line: string) => void, signal?: AbortSignal): Promise<CliRunResult> {
    const cwd = await mkdtemp(join(tmpdir(), "nyxara-cli-"));
    try {
      let result: CliRunResult;
      try {
        const resolvedArgs = typeof args === "function" ? await args(cwd) : args;
        result = await this.runner.run({ command: this.spec.command, args: resolvedArgs, ...(stdin !== undefined ? { stdin } : {}), cwd, timeoutMs: this.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, ...(onOutputLine ? { onOutputLine } : {}), ...(signal ? { signal } : {}) });
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

/** Official Codex app-server JSONL client. It reads model metadata only and never
 * receives or serializes the CLI's stored account credential. */
export class NodeCodexAppServerCatalog implements CodexModelCatalog {
  constructor(
    private readonly appServerArgs: readonly string[] = ["app-server", "--stdio"],
    private readonly spawnProcess: CodexAppServerSpawn = spawn as unknown as CodexAppServerSpawn,
  ) {}

  listModels(input: CodexCatalogInput): Promise<readonly ModelInfo[]> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(input.command, [...this.appServerArgs], {
        cwd: input.cwd,
        env: subscriptionEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuffer = "";
      let outputBytes = 0;
      let settled = false;
      let nextRequestId = 1;
      let pageCount = 0;
      const cursors = new Set<string>();
      const models: ModelInfo[] = [];
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        callback();
      };
      const fail = (message: string, code: ProviderErrorCode = "provider_error"): void => finish(() => reject(new ProviderError(message, { code, providerId: input.providerId })));
      const send = (message: unknown): void => {
        if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const requestPage = (cursor?: string): void => {
        pageCount += 1;
        if (pageCount > MAX_MODEL_PAGES) { fail("Codex returned too many model pages", "invalid_response"); return; }
        send({ method: "model/list", id: nextRequestId++, params: { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) } });
      };
      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let message: unknown;
        try { message = JSON.parse(line); }
        catch { fail("Codex returned invalid app-server JSON", "invalid_response"); return; }
        if (!isRecord(message) || typeof message.id !== "number") return;
        if (message.id === 0) {
          if (message.error !== undefined) { fail("Codex app-server initialization failed"); return; }
          send({ method: "initialized", params: {} });
          requestPage();
          return;
        }
        if (message.error !== undefined) { fail("Codex model discovery failed"); return; }
        let page: { readonly models: readonly ModelInfo[]; readonly nextCursor?: string };
        try { page = normalizeCodexModelPage(message.result, input.providerId); }
        catch { fail("Codex returned an invalid model catalog", "invalid_response"); return; }
        models.push(...page.models);
        console.log(`[Codex Discovery] Page received: ${page.models.length} models, total so far: ${models.length + page.models.length}`);
        if (models.length > MAX_DISCOVERED_MODELS) { fail("Codex returned too many models", "invalid_response"); return; }
        if (page.nextCursor) {
          if (cursors.has(page.nextCursor)) { fail("Codex returned an invalid model cursor", "invalid_response"); return; }
          cursors.add(page.nextCursor);
          requestPage(page.nextCursor);
          return;
        }
        finish(() => resolve(models));
        console.log(`[Codex Discovery] Complete: ${models.length} total models discovered`);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) { fail("Codex model discovery output exceeded the safe limit", "invalid_response"); return; }
        stdoutBuffer += chunk.toString("utf8");
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          handleLine(line);
          if (settled) break;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) fail("Codex model discovery output exceeded the safe limit", "invalid_response");
      });
      child.stdin.on("error", () => { if (!settled) fail("Codex app-server input failed"); });
      child.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? "Codex CLI is not installed" : "Codex app-server could not start", error.code === "ENOENT" ? "provider_not_installed" : "provider_error"));
      child.on("close", () => { if (!settled) fail("Codex app-server closed before model discovery completed"); });
      const timer = setTimeout(() => fail("Codex model discovery timed out", "timeout_error"), input.timeoutMs);
      (timer as NodeJS.Timeout).unref?.();
      send({ method: "initialize", id: 0, params: { clientInfo: { name: "nyxara_orchestrator", title: "Nyxara Orchestrator", version: "0.1.0" } } });
    });
  }
}

/** Official Claude Agent SDK control-protocol client. It performs only the
 * initialize handshake used by supportedModels(); no prompt or credential is
 * supplied to the child process and no raw provider response is persisted. */
export class NodeClaudeAgentSdkCatalog implements ClaudeModelCatalog {
  constructor(
    private readonly sdkArgs: readonly string[] = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--tools", ""],
    private readonly spawnProcess: ClaudeAgentSdkSpawn = spawn as unknown as ClaudeAgentSdkSpawn,
  ) {}

  listModels(input: ClaudeCatalogInput): Promise<readonly ModelInfo[]> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(input.command, [...this.sdkArgs], {
        cwd: input.cwd,
        env: { ...subscriptionEnvironment(), CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const requestId = "nyxara-supported-models";
      let stdoutBuffer = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        callback();
      };
      const fail = (message: string, code: ProviderErrorCode = "provider_error"): void => finish(() => reject(new ProviderError(message, { code, providerId: input.providerId })));
      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let message: unknown;
        try { message = JSON.parse(line); }
        catch { fail("Claude returned invalid Agent SDK JSON", "invalid_response"); return; }
        if (!isRecord(message) || message.type !== "control_response" || !isRecord(message.response) || message.response.request_id !== requestId) return;
        if (message.response.subtype !== "success") { fail("Claude model discovery failed"); return; }
        try {
          const models = normalizeClaudeModels(isRecord(message.response.response) ? message.response.response.models : undefined, input.providerId);
          console.log(`[Claude Discovery] Complete: ${models.length} total models discovered`);
          finish(() => resolve(models));
        } catch {
          fail("Claude returned an invalid supported-model catalog", "invalid_response");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) { fail("Claude model discovery output exceeded the safe limit", "invalid_response"); return; }
        stdoutBuffer += chunk.toString("utf8");
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          handleLine(line);
          if (settled) break;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) fail("Claude model discovery output exceeded the safe limit", "invalid_response");
      });
      child.stdin.on("error", () => { if (!settled) fail("Claude Agent SDK input failed"); });
      child.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? "Claude CLI is not installed" : "Claude Agent SDK could not start", error.code === "ENOENT" ? "provider_not_installed" : "provider_error"));
      child.on("close", () => { if (!settled) fail("Claude Agent SDK closed before model discovery completed"); });
      const timer = setTimeout(() => fail("Claude model discovery timed out", "timeout_error"), input.timeoutMs);
      (timer as NodeJS.Timeout).unref?.();
      child.stdin.write(`${JSON.stringify({ request_id: requestId, type: "control_request", request: { subtype: "initialize" } })}\n`);
    });
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
      const finish = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort); fn(); } };
      const abort = (): void => {
        child.kill("SIGTERM");
        finish(() => reject(Object.assign(new Error("CLI generation aborted"), { name: "AbortError", code: "ABORT_ERR" })));
      };
      const append = (current: string, chunk: Buffer): string => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) {
          child.kill("SIGKILL");
          finish(() => reject(Object.assign(new Error("CLI output exceeded the safe limit"), { code: "EOUTPUTLIMIT" })));
        }
        return current + chunk.toString("utf8");
      };
      let pendingLine = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
        if (!input.onOutputLine) return;
        pendingLine += chunk.toString("utf8");
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) if (line) input.onOutputLine(line);
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (exitCode) => finish(() => resolve({ exitCode: exitCode ?? 1, stdout, stderr })));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(Object.assign(new Error("CLI timed out"), { code: "ETIMEDOUT" })));
      }, input.timeoutMs);
      if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(input.stdin ?? "");
    });
  }
}

function cliSpec(kind: CliSubscriptionKind): CliSpec {
  if (kind === "codex-cli") return {
    command: "codex",
    displayName: "OpenAI Codex (ChatGPT)",
    statusArgs: ["login", "status"],
    modelDiscovery: true,
    validateStatus: (result, providerId) => {
      if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) throw new ProviderError("Codex must be signed in with ChatGPT, not an API key", { code: "authentication_error", providerId });
    },
    generationArgs: (model, executionOptions, responseSchema) => ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", ...(responseSchema ? ["--output-schema", responseSchema] : []), ...(model === DEFAULT_MODEL_ALIAS ? [] : ["--model", model]), ...(executionOptions.kind === "openai_reasoning" ? ["--config", `model_reasoning_effort=${JSON.stringify(executionOptions.effort)}`] : []), "-"],
    responseText: parseCodexOutput,
    progressPhase: codexProgressPhase,
  };
  if (kind === "claude-code-cli") return {
    command: "claude",
    displayName: "Claude Code (Claude account)",
    statusArgs: ["auth", "status"],
    modelDiscovery: true,
    validateStatus: (result, providerId) => {
      let status: unknown;
      try { status = JSON.parse(result.stdout); } catch { status = undefined; }
      const authMethod = isRecord(status) && typeof status.authMethod === "string" ? status.authMethod : undefined;
      if (!isRecord(status) || status.loggedIn !== true || (authMethod !== "claude.ai" && authMethod !== "oauth_token")) throw new ProviderError("Claude Code must be signed in with a Claude account, not an API key", { code: "authentication_error", providerId });
    },
    generationArgs: (model, executionOptions, responseSchema) => ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--safe-mode", "--tools", "", "--permission-mode", "dontAsk", ...(responseSchema ? ["--json-schema", responseSchema] : []), ...(model === DEFAULT_MODEL_ALIAS ? [] : ["--model", model]), ...(executionOptions.kind === "anthropic_effort" ? ["--effort", executionOptions.effort] : [])],
    responseText: parseClaudeOutput,
    progressPhase: claudeProgressPhase,
  };
  return {
    command: "gemini",
    displayName: "Gemini CLI (Google account)",
    statusArgs: ["--version"],
    modelDiscovery: false,
    validateStatus: () => {},
    generationArgs: (model) => ["--prompt", "", "--output-format", "stream-json", "--approval-mode", "plan", "--allowed-tools", "", ...(model === DEFAULT_MODEL_ALIAS ? [] : ["--model", model])],
    responseText: parseGeminiOutput,
    progressPhase: geminiProgressPhase,
  };
}

function providerPrompt(request: GenerateRequest, toolEnvelope: boolean): string {
  if (!toolEnvelope) {
    if (!request.conversation?.length) return request.prompt;
    return [
      `Prior conversation: ${JSON.stringify(request.conversation)}`,
      `Request: ${request.prompt}`,
    ].join("\n\n");
  }
  return [
    "You are the model backend inside Nyxara Orchestrator.",
    "Do not call or execute any CLI built-in tools. Nyxara alone executes tools after explicit policy checks.",
    "Return exactly one JSON object with this shape and no markdown: {\"text\":string,\"toolCalls\":[{\"id\":string,\"name\":string,\"argumentsJson\":string}],\"finishReason\":string}.",
    "When tools are needed, encode each arguments object as JSON in argumentsJson and leave execution to Nyxara. Nyxara also accepts an object-valued arguments field from CLIs that cannot enforce this schema. Otherwise return an empty toolCalls array.",
    `Requested response format: ${request.responseFormat ?? "text"}`,
    `Available Nyxara tools: ${JSON.stringify(request.tools ?? [])}`,
    `Prior conversation: ${JSON.stringify(request.conversation ?? [])}`,
    `Request: ${request.prompt}`,
  ].join("\n\n");
}

function parseToolEnvelope(value: string, providerId: string): { text: string; toolCalls: ModelToolCall[]; finishReason?: string } {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); }
  catch { throw new ProviderError("CLI returned invalid structured output", { code: "invalid_response", providerId }); }
  if (!isRecord(parsed) || typeof parsed.text !== "string" || !Array.isArray(parsed.toolCalls)) throw new ProviderError("CLI returned an invalid response envelope", { code: "invalid_response", providerId });
  const toolCalls = parsed.toolCalls.map((value): ModelToolCall => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name) throw new ProviderError("CLI returned an invalid tool call", { code: "invalid_response", providerId });
    let args: unknown;
    if (typeof value.argumentsJson === "string" && value.arguments === undefined) {
      try { args = JSON.parse(value.argumentsJson); }
      catch { args = value.argumentsJson; }
    } else if (value.argumentsJson === undefined && value.arguments !== undefined) {
      args = value.arguments;
    } else {
      throw new ProviderError("CLI returned invalid tool call arguments", { code: "invalid_response", providerId });
    }
    return { id: value.id, name: value.name, arguments: args };
  });
  return { text: parsed.text, toolCalls, ...(typeof parsed.finishReason === "string" && parsed.finishReason ? { finishReason: parsed.finishReason } : {}) };
}

/**
 * Maps Codex CLI JSONL events to safe progress phases. Only the event type and
 * an allowed tool name are used; message text, reasoning, and tool arguments are
 * never read, and non-JSON lines are ignored rather than scraped.
 */
function codexProgressPhase(line: string): ProviderProgressEvent | undefined {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  const item = isRecord(event.item) ? event.item : undefined;
  const itemType = typeof item?.type === "string" ? item.type : undefined;
  if (event.type === "turn.started") return { phase: "response_started" };
  if (event.type === "item.started" && itemType === "command_execution") {
    return { phase: "tool_execution_started" };
  }
  if (event.type === "item.completed" && itemType === "command_execution") {
    return { phase: "tool_execution_completed" };
  }
  if (event.type === "item.started" && itemType === "agent_message") {
    return { phase: "output_receiving" };
  }
  if (event.type === "item.completed" && itemType === "agent_message") {
    return { phase: "output_receiving" };
  }
  // `turn.completed` is intentionally unmapped: the adapter emits the single
  // authoritative `request_completed` once the CLI process exits.
  return undefined;
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

function parseClaudeOutput(stdout: string, toolEnvelope: boolean): { text: string; usage?: GenerateUsage } {
  const payload = finalJsonLine(stdout, "result");
  if (!isRecord(payload)) throw new Error("Claude Code returned no result");
  const usage = isRecord(payload.usage) ? anthropicTokenUsage(payload.usage) : undefined;
  if (toolEnvelope) {
    if (!isRecord(payload.structured_output)) throw new Error("Claude Code returned no structured output");
    return { text: JSON.stringify(payload.structured_output), ...(usage ? { usage } : {}) };
  }
  if (typeof payload.result !== "string") throw new Error("Claude Code returned no result");
  return { text: payload.result, ...(usage ? { usage } : {}) };
}

function parseGeminiOutput(stdout: string): { text: string; usage?: GenerateUsage } {
  const payload = finalJsonLine(stdout, "result");
  if (!isRecord(payload) || typeof payload.response !== "string") throw new Error("Gemini CLI returned no response");
  return { text: payload.response };
}

function finalJsonLine(stdout: string, eventType: string): unknown {
  let fallback: unknown;
  let final: unknown;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    fallback = value;
    if (isRecord(value) && value.type === eventType) final = value;
  }
  return final ?? fallback;
}

function claudeProgressPhase(line: string): ProviderProgressEvent | undefined {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(event)) return undefined;
  if (event.type === "assistant") return { phase: "response_started" };
  if (event.type === "stream_event" && isRecord(event.event) && event.event.type === "message_start") return { phase: "response_started" };
  if (event.type === "stream_event" && isRecord(event.event) && event.event.type === "content_block_delta") return { phase: "output_receiving" };
  return undefined;
}

function geminiProgressPhase(line: string): ProviderProgressEvent | undefined {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(event)) return undefined;
  if (event.type === "message") return event.role === "assistant" ? { phase: "output_receiving" } : undefined;
  if (event.type === "tool_use") return { phase: "tool_call_requested", ...(typeof event.tool_name === "string" ? { toolName: safeToolName(event.tool_name) } : {}) };
  if (event.type === "tool_result") return { phase: "tool_execution_completed" };
  return undefined;
}

function anthropicTokenUsage(value: Record<string, unknown>): GenerateUsage | undefined {
  const inputTokens = finiteNumber(value.input_tokens);
  const outputTokens = finiteNumber(value.output_tokens);
  const cacheReadTokens = finiteNumber(value.cache_read_input_tokens);
  const cacheWriteTokens = finiteNumber(value.cache_creation_input_tokens);
  const parts = [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens];
  if (parts.every((part) => part === undefined)) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}), ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}), totalTokens: parts.reduce<number>((sum, part) => sum + (part ?? 0), 0) };
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
function safeToolName(value: string): string { return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "tool"; }

function normalizeCodexModelPage(value: unknown, providerId: string): { readonly models: readonly ModelInfo[]; readonly nextCursor?: string } {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("invalid model page");
  const data = value.data;
  const models = data.map((entry): ModelInfo => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) throw new Error("invalid model");
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((option): string[] => isRecord(option) && typeof option.reasoningEffort === "string" && option.reasoningEffort ? [option.reasoningEffort] : [])
      : [];
    const uniqueEfforts = [...new Set(efforts)];
    const execution = uniqueEfforts.length ? {
      kind: "openai_reasoning" as const,
      label: "Reasoning" as const,
      control: "select" as const,
      values: uniqueEfforts.map((effort) => ({ value: effort, label: effort[0]!.toLocaleUpperCase() + effort.slice(1) })),
      provenance: "provider_discovery" as const,
    } : undefined;
    return {
      id: entry.id,
      name: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.id,
      provider: providerId,
      capabilities: { text: true, tools: true, structuredOutput: true, ...(execution ? { reasoning: true, execution } : {}) },
    };
  });
  const ordered = models.map((model, index) => ({ model, index, isDefault: isRecord(data[index]) && data[index].isDefault === true }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.index - b.index)
    .map((entry) => entry.model);
  return { models: ordered, ...(typeof value.nextCursor === "string" && value.nextCursor ? { nextCursor: value.nextCursor } : {}) };
}

function normalizeClaudeModels(value: unknown, providerId: string): readonly ModelInfo[] {
  if (!Array.isArray(value)) throw new Error("invalid supported models");
  if (value.length > MAX_DISCOVERED_MODELS) throw new Error("too many supported models");
  const seen = new Set<string>();
  return value.map((entry): ModelInfo => {
    if (!isRecord(entry) || typeof entry.value !== "string" || !entry.value || entry.value.length > 2_048 || seen.has(entry.value)) throw new Error("invalid supported model");
    seen.add(entry.value);
    const efforts = Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.flatMap((option): string[] => typeof option === "string" && option ? [option] : isRecord(option) && typeof option.value === "string" && option.value ? [option.value] : [])
      : [];
    const uniqueEfforts = [...new Set(efforts)];
    const execution = entry.supportsEffort === true && uniqueEfforts.length ? {
      kind: "anthropic_effort" as const,
      label: "Effort" as const,
      control: "select" as const,
      values: uniqueEfforts.map((effort) => ({ value: effort, label: effort[0]!.toLocaleUpperCase() + effort.slice(1) })),
      provenance: "provider_discovery" as const,
    } : undefined;
    return {
      id: entry.value,
      name: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : entry.value,
      provider: providerId,
      capabilities: { text: true, tools: true, structuredOutput: true, ...((entry.supportsAdaptiveThinking === true || entry.supportsEffort === true) ? { reasoning: true } : {}), ...(execution ? { execution } : {}) },
    };
  });
}

function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]) delete env[key];
  return env;
}
