import { createHash } from "node:crypto";
import type {
  ModelToolCall,
  ModelToolResult,
} from "@nyxara/provider-sdk";
import { truncateUtf8 } from "../internal/text.js";
import { ApproximateTokenEstimator } from "../context/token-estimator.js";
import type { ContextBundle, ContextFile } from "../context/context.types.js";
import { ExecutorError } from "./executor-error.js";
import type {
  ExecutorContextMetrics,
  ExecutorToolCategory,
} from "./executor.types.js";

export interface ResolvedExecutorLimits {
  readonly maxToolCallsPerTask: number;
  readonly maxReadToolCallsPerTask: number;
  readonly maxMutatingToolCallsPerTask: number;
  readonly maxValidationToolCallsPerTask: number;
  readonly maxProviderCallsPerTask: number;
  readonly maxToolResultBytes: number;
  readonly maxRetainedEvidenceBytes: number;
  readonly maxExecutorContextBytes: number;
  readonly maxEstimatedInputTokens: number;
  readonly maxConsecutiveNoProgressToolCalls: number;
  readonly maxNoProgressModelTurns: number;
}

export interface PreparedExecutorToolCall {
  readonly call: ModelToolCall;
  readonly fingerprint: string;
  readonly category: ExecutorToolCategory;
  readonly duplicateResult?: ModelToolResult;
}

interface EvidenceEntry {
  readonly key: string;
  readonly text: string;
  readonly bytes: number;
}

const TOKEN_ESTIMATOR = new ApproximateTokenEstimator();
const READ_TOOLS = new Set([
  "git_diff",
  "git_status",
  "list_directory",
  "read_file",
  "search_code",
  "search_files",
]);
const VALIDATION_WORDS = new Set([
  "build",
  "check",
  "eslint",
  "jest",
  "lint",
  "pytest",
  "ruff",
  "test",
  "tsc",
  "typecheck",
  "vitest",
]);

/**
 * Attempt-local state only. It is deliberately never persisted into Retry
 * Execute recovery, so a retry cannot replay a previous raw tool trajectory.
 */
export class ExecutorSession {
  private readonly seenCalls = new Map<string, { readonly failed: boolean }>();
  private readonly evidenceIds = new Set<string>();
  private readonly entries: EvidenceEntry[] = [];
  private readonly initialFiles = new Map<string, ContextFile>();
  private readonly contextPaths = new Set<string>();
  private readonly categoryCounts: Record<ExecutorToolCategory, number> = {
    read: 0,
    mutation: 0,
    validation: 0,
  };
  private revision = 0;
  private totalCalls = 0;
  private retainedEvidenceBytes = 0;
  private consecutiveNoProgress = 0;
  private noProgressRounds = 0;
  private duplicateEvidenceRemoved = 0;
  private droppedEvidenceCount = 0;
  private providerCalls = 0;
  private providerReportedInputTokens = 0;
  private readonly contextBytesPerRound: number[] = [];
  private readonly estimatedInputTokensPerRound: number[] = [];

  constructor(
    context: ContextBundle,
    private readonly limits: ResolvedExecutorLimits,
  ) {
    for (const file of context.files) {
      const path = normalizePath(file.path);
      this.initialFiles.set(path, file);
      this.contextPaths.add(path);
      this.evidenceIds.add(`file:${path}:${digest(file.content)}`);
    }
  }

  prepareBatch(calls: readonly ModelToolCall[]): readonly PreparedExecutorToolCall[] {
    const fingerprintsInBatch = new Set<string>();
    const prepared = calls.map((call) => {
      const item = this.prepare(call);
      if (!item.duplicateResult && fingerprintsInBatch.has(item.fingerprint)) {
        return {
          ...item,
          duplicateResult: {
            callId: item.call.id,
            name: item.call.name,
            result: {
              deduplicated: true,
              reason: "equivalent_call_already_requested_in_round",
              evidenceRef: digest(item.fingerprint).slice(0, 12),
            },
          },
        };
      }
      fingerprintsInBatch.add(item.fingerprint);
      return item;
    });
    const pending: Record<ExecutorToolCategory, number> = { read: 0, mutation: 0, validation: 0 };
    for (const item of prepared) pending[item.category] += 1;
    if (this.totalCalls + prepared.length > this.limits.maxToolCallsPerTask) {
      throw new ExecutorError(
        "tool_call_limit_exceeded",
        "Executor reached the final hard safety ceiling for tool requests",
      );
    }
    this.assertCategoryLimit("read", pending.read, this.limits.maxReadToolCallsPerTask, "read_tool_limit_exceeded");
    this.assertCategoryLimit("mutation", pending.mutation, this.limits.maxMutatingToolCallsPerTask, "mutating_tool_limit_exceeded");
    this.assertCategoryLimit("validation", pending.validation, this.limits.maxValidationToolCallsPerTask, "validation_tool_limit_exceeded");
    return prepared;
  }

  acceptRequest(prepared: PreparedExecutorToolCall): void {
    this.totalCalls += 1;
    this.categoryCounts[prepared.category] += 1;
    if (prepared.duplicateResult) this.duplicateEvidenceRemoved += 1;
  }

  recordOutcome(
    prepared: PreparedExecutorToolCall,
    result: ModelToolResult,
    changedPaths: readonly string[],
  ): { readonly progress: boolean; readonly evidenceKey?: string } {
    this.seenCalls.set(prepared.fingerprint, { failed: Boolean(result.error) });
    if (changedPaths.length > 0) this.revision += 1;
    const evidenceIds = progressEvidenceIds(prepared, result, changedPaths, this.revision);
    const novel = evidenceIds.filter((id) => !this.evidenceIds.has(id));
    for (const id of novel) this.evidenceIds.add(id);
    const progress = novel.length > 0;
    if (progress) {
      this.consecutiveNoProgress = 0;
      for (const path of evidencePaths(result, changedPaths)) this.contextPaths.add(path);
      const evidenceKey = evidenceReplacementKey(prepared);
      this.addEvidence(evidenceKey, evidenceText(prepared, result));
      return { progress, evidenceKey };
    }
    this.consecutiveNoProgress += 1;
    return { progress };
  }

  recordDuplicate(): void {
    this.consecutiveNoProgress += 1;
  }

  finishToolRound(progress: boolean): void {
    this.noProgressRounds = progress ? 0 : this.noProgressRounds + 1;
    if (
      this.consecutiveNoProgress >= this.limits.maxConsecutiveNoProgressToolCalls ||
      this.noProgressRounds >= this.limits.maxNoProgressModelTurns
    ) {
      throw new ExecutorError(
        "executor_stalled",
        "Executor stalled: repeated tool activity produced no new evidence.",
      );
    }
  }

  assertProviderCallAvailable(): void {
    if (this.providerCalls >= this.limits.maxProviderCallsPerTask) {
      throw new ExecutorError(
        "provider_call_limit_exceeded",
        "Executor reached the provider-call safety ceiling for this task",
      );
    }
  }

  recordProviderRequest(bytes: number, estimatedTokens: number): void {
    this.providerCalls += 1;
    this.contextBytesPerRound.push(bytes);
    this.estimatedInputTokensPerRound.push(estimatedTokens);
  }

  recordProviderUsage(inputTokens: number | undefined): void {
    if (inputTokens !== undefined) this.providerReportedInputTokens += inputTokens;
  }

  evidence(excluding: ReadonlySet<string> = new Set()): string {
    return this.entries
      .filter((entry) => !excluding.has(entry.key))
      .map((entry) => entry.text)
      .join("\n\n");
  }

  dropOldestEvidence(): boolean {
    const removed = this.entries.shift();
    if (!removed) return false;
    this.retainedEvidenceBytes -= removed.bytes;
    this.droppedEvidenceCount += 1;
    return true;
  }

  stateSummary(hasChangedFiles: boolean, readOnly: boolean): string {
    const evidenceReady = this.entries.length > 0 || this.initialFiles.size > 0;
    const phase = hasChangedFiles
      ? "validate_or_finish"
      : evidenceReady
        ? readOnly ? "decide_or_finish_audit" : "decide_or_patch"
        : "inspect";
    return [
      `phase=${phase}`,
      `readCalls=${this.categoryCounts.read}`,
      `mutationCalls=${this.categoryCounts.mutation}`,
      `validationCalls=${this.categoryCounts.validation}`,
      `retainedEvidence=${this.entries.length}`,
      `changed=${hasChangedFiles}`,
      `consecutiveNoProgress=${this.consecutiveNoProgress}`,
    ].join(", ");
  }

  metrics(): ExecutorContextMetrics {
    return {
      executorContextFiles: this.contextPaths.size,
      executorContextBytes: Math.max(0, ...this.contextBytesPerRound),
      droppedEvidenceCount: this.droppedEvidenceCount,
      duplicateEvidenceRemoved: this.duplicateEvidenceRemoved,
      estimatedInputTokens: Math.max(0, ...this.estimatedInputTokensPerRound),
      providerReportedInputTokens: this.providerReportedInputTokens,
      providerCalls: this.providerCalls,
      contextBytesPerRound: [...this.contextBytesPerRound],
      estimatedInputTokensPerRound: [...this.estimatedInputTokensPerRound],
    };
  }

  counts(): Readonly<Record<ExecutorToolCategory, number>> {
    return { ...this.categoryCounts };
  }

  private prepare(call: ModelToolCall): PreparedExecutorToolCall {
    const normalized = normalizeCall(call, this.limits.maxToolResultBytes);
    const category = toolCategory(normalized);
    const versioned = category === "read" || category === "validation";
    const fingerprint = `${normalized.name}:${stableStringify(normalized.arguments)}${versioned ? `:r${this.revision}` : ""}`;
    const initial = this.initialDuplicate(normalized);
    if (initial) {
      return { call: normalized, fingerprint, category, duplicateResult: initial };
    }
    const seen = this.seenCalls.get(fingerprint);
    if (!seen) return { call: normalized, fingerprint, category };
    return {
      call: normalized,
      fingerprint,
      category,
      duplicateResult: {
        callId: normalized.id,
        name: normalized.name,
        result: {
          deduplicated: true,
          reason: "equivalent_call_already_processed",
          priorOutcome: seen.failed ? "failed" : "successful",
          evidenceRef: digest(fingerprint).slice(0, 12),
        },
      },
    };
  }

  private initialDuplicate(call: ModelToolCall): ModelToolResult | undefined {
    if (call.name !== "read_file" || !isRecord(call.arguments) || typeof call.arguments.path !== "string") return undefined;
    const file = this.initialFiles.get(normalizePath(call.arguments.path));
    if (!file || file.truncated) return undefined;
    return {
      callId: call.id,
      name: call.name,
      result: {
        deduplicated: true,
        reason: "file_already_present_in_current_context",
        path: file.path,
      },
    };
  }

  private assertCategoryLimit(
    category: ExecutorToolCategory,
    requested: number,
    limit: number,
    code: "read_tool_limit_exceeded" | "mutating_tool_limit_exceeded" | "validation_tool_limit_exceeded",
  ): void {
    if (this.categoryCounts[category] + requested <= limit) return;
    throw new ExecutorError(code, `Executor reached the ${category} tool safety ceiling for this task`);
  }

  private addEvidence(key: string, text: string): void {
    const priorIndex = this.entries.findIndex((entry) => entry.key === key);
    if (priorIndex >= 0) {
      const [prior] = this.entries.splice(priorIndex, 1);
      if (prior) {
        this.retainedEvidenceBytes -= prior.bytes;
        this.droppedEvidenceCount += 1;
      }
    }
    const bounded = truncateUtf8(text, Math.min(this.limits.maxToolResultBytes, this.limits.maxRetainedEvidenceBytes));
    const entry: EvidenceEntry = {
      key,
      text: bounded.value,
      bytes: Buffer.byteLength(bounded.value, "utf8"),
    };
    this.entries.push(entry);
    this.retainedEvidenceBytes += entry.bytes;
    while (this.retainedEvidenceBytes > this.limits.maxRetainedEvidenceBytes) {
      if (!this.dropOldestEvidence()) break;
    }
  }
}

export function compactExecutorContext(context: ContextBundle, maxBytes: number): ContextBundle {
  if (context.totalBytes <= maxBytes) return context;
  const boundedDiff = truncateUtf8(context.git.diff.diff, Math.max(1, Math.floor(maxBytes / 5)));
  let used = Buffer.byteLength(boundedDiff.value, "utf8");
  const files: ContextFile[] = [];
  for (const file of context.files) {
    if (used >= maxBytes) break;
    const bounded = truncateUtf8(file.content, Math.min(24 * 1024, maxBytes - used));
    if (!bounded.value) break;
    files.push({ ...file, content: bounded.value, truncated: file.truncated || bounded.truncated });
    used += Buffer.byteLength(bounded.value, "utf8");
  }
  return {
    ...context,
    files,
    git: { ...context.git, diff: { ...context.git.diff, diff: boundedDiff.value, truncated: context.git.diff.truncated || boundedDiff.truncated } },
    totalBytes: used,
    estimatedTokens: TOKEN_ESTIMATOR.estimate([context.prompt, boundedDiff.value, ...files.map((file) => file.content)].join("\n")),
    truncated: true,
  };
}

export function estimateExecutorRequest(input: unknown): { readonly bytes: number; readonly tokens: number } {
  const serialized = JSON.stringify(input);
  return { bytes: Buffer.byteLength(serialized, "utf8"), tokens: TOKEN_ESTIMATOR.estimate(serialized) };
}

export function taskIsReadOnly(task: { readonly executionMode?: "implementation" | "read_only" | undefined; readonly title: string; readonly description: string; readonly acceptanceCriteria: readonly string[] }): boolean {
  return task.executionMode === "read_only";
}

function normalizeCall(call: ModelToolCall, maxToolResultBytes: number): ModelToolCall {
  if (!isRecord(call.arguments)) return call;
  const args = { ...call.arguments };
  if (call.name === "search_code") {
    args.maxResults = boundedInteger(args.maxResults, 20, 20);
    args.maxFileBytes = boundedInteger(args.maxFileBytes, 256 * 1024, 256 * 1024);
  } else if (call.name === "search_files") {
    args.maxResults = boundedInteger(args.maxResults, 20, 20);
  } else if (call.name === "read_file") {
    args.maxBytes = boundedInteger(args.maxBytes, 24 * 1024, Math.min(24 * 1024, maxToolResultBytes));
  } else if (call.name === "run_command") {
    args.maxOutputBytes = boundedInteger(args.maxOutputBytes, maxToolResultBytes, maxToolResultBytes);
  } else if (call.name === "git_diff") {
    args.maxBytes = boundedInteger(args.maxBytes, maxToolResultBytes, maxToolResultBytes);
  }
  return { ...call, arguments: args };
}

function boundedInteger(value: unknown, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function toolCategory(call: ModelToolCall): ExecutorToolCategory {
  if (READ_TOOLS.has(call.name)) return "read";
  if (call.name !== "run_command" || !isRecord(call.arguments)) return "mutation";
  const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
  const args = Array.isArray(call.arguments.args)
    ? call.arguments.args.filter((value): value is string => typeof value === "string")
    : [];
  const words = [command.split(/[\\/]/).at(-1) ?? command, ...args]
    .flatMap((value) => value.toLocaleLowerCase().split(/[^a-z0-9_-]+/))
    .map((word) => word.replace(/^-+/, ""))
    .filter(Boolean);
  return words.some((word) => VALIDATION_WORDS.has(word)) ? "validation" : "mutation";
}

function progressEvidenceIds(
  prepared: PreparedExecutorToolCall,
  result: ModelToolResult,
  changedPaths: readonly string[],
  revision: number,
): string[] {
  if (prepared.category === "mutation") {
    return changedPaths.map((path) => `changed:${normalizePath(path)}:r${revision}`);
  }
  if (prepared.category === "validation") {
    return [`validation:${prepared.fingerprint}:${digest(stableStringify(result))}`];
  }
  if (result.error || !isRecord(result.result)) return [];
  const value = result.result;
  if (prepared.call.name === "search_code" && Array.isArray(value.matches)) {
    return value.matches.flatMap((match) => isRecord(match) && typeof match.path === "string" && typeof match.line === "number"
      ? [`match:${normalizePath(match.path)}:${match.line}:${digest(stableStringify(match))}`]
      : []);
  }
  if (prepared.call.name === "search_files" && Array.isArray(value.matches)) {
    return value.matches.filter((path): path is string => typeof path === "string").map((path) => `path:${normalizePath(path)}`);
  }
  if (prepared.call.name === "read_file" && typeof value.path === "string" && typeof value.content === "string" && value.content.length > 0) {
    return [`file:${normalizePath(value.path)}:${digest(value.content)}`];
  }
  if (prepared.call.name === "list_directory" && Array.isArray(value.entries)) {
    return value.entries.flatMap((entry) => isRecord(entry) && typeof entry.path === "string" ? [`path:${normalizePath(entry.path)}`] : []);
  }
  if (prepared.call.name === "git_diff" || prepared.call.name === "git_status") {
    return [`git:${prepared.call.name}:${digest(stableStringify(value))}`];
  }
  return [];
}

function evidenceReplacementKey(prepared: PreparedExecutorToolCall): string {
  if (!isRecord(prepared.call.arguments)) return prepared.call.name;
  const args = prepared.call.arguments;
  if (prepared.call.name === "read_file") return `read:${String(args.path ?? "")}:${String(args.startLine ?? 1)}:${String(args.endLine ?? "end")}`;
  if (prepared.call.name === "search_code" || prepared.call.name === "search_files") return `${prepared.call.name}:${String(args.query ?? "")}`;
  if (prepared.call.name === "git_diff" || prepared.call.name === "git_status") return prepared.call.name;
  return prepared.fingerprint;
}

function evidenceText(prepared: PreparedExecutorToolCall, result: ModelToolResult): string {
  return [
    `[${prepared.category}/${prepared.call.name}] ${safeCallLabel(prepared.call)}`,
    JSON.stringify(result.error ? { error: result.error } : result.result ?? null),
  ].join("\n");
}

function safeCallLabel(call: ModelToolCall): string {
  if (!isRecord(call.arguments)) return "invalid arguments";
  if (call.name === "read_file") return `${String(call.arguments.path ?? "")} lines ${String(call.arguments.startLine ?? 1)}-${String(call.arguments.endLine ?? "end")}`;
  if (call.name === "search_code" || call.name === "search_files") return `query=${JSON.stringify(String(call.arguments.query ?? "").slice(0, 256))}`;
  if (call.name === "write_file") return `path=${String(call.arguments.path ?? "")}`;
  if (call.name === "apply_patch") {
    const patch = typeof call.arguments.patch === "string" ? call.arguments.patch : "";
    const paths = [...patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((match) => match[1]).filter(Boolean);
    return `paths=${paths.join(",") || "unknown"}`;
  }
  if (call.name === "run_command") {
    return JSON.stringify([call.arguments.command, ...(Array.isArray(call.arguments.args) ? call.arguments.args : [])]).slice(0, 512);
  }
  return stableStringify(call.arguments).slice(0, 512);
}

function evidencePaths(result: ModelToolResult, changedPaths: readonly string[]): string[] {
  const paths = new Set(changedPaths.map(normalizePath));
  if (!isRecord(result.result)) return [...paths];
  const value = result.result;
  if (typeof value.path === "string") paths.add(normalizePath(value.path));
  for (const key of ["matches", "entries"] as const) {
    if (!Array.isArray(value[key])) continue;
    for (const item of value[key]) {
      if (typeof item === "string") paths.add(normalizePath(item));
      else if (isRecord(item) && typeof item.path === "string") paths.add(normalizePath(item.path));
    }
  }
  return [...paths];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
