import { NyxaraToolError, type ToolRegistry } from "@nyxara/tools";
import type { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { Repository } from "../repository/repository.js";
import type {
  BuildContextInput,
  ContextBudget,
  ContextBundle,
  ContextFile,
} from "./context.types.js";
import {
  ApproximateTokenEstimator,
  type TokenEstimator,
} from "./token-estimator.js";

const DEFAULT_BUDGET: ContextBudget = {
  maxFiles: 8,
  maxBytes: 128 * 1024,
  maxBytesPerFile: 24 * 1024,
};
const STOP_WORDS = new Set([
  "add",
  "and",
  "api",
  "build",
  "for",
  "from",
  "into",
  "the",
  "this",
  "with",
]);

interface Candidate {
  readonly path: string;
  score: number;
  reasons: Set<string>;
}

export class ContextEngine {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly events: EventBus<NyxaraEventMap>,
    private readonly tokenEstimator: TokenEstimator = new ApproximateTokenEstimator(),
  ) {}

  async build(input: BuildContextInput): Promise<ContextBundle> {
    const budget = this.resolveBudget(input.budget);
    this.events.emit("context.started", {
      workspaceRoot: input.workspaceRoot,
      promptLength: input.prompt.length,
    });

    try {
      const repository = new Repository(
        input.workspaceRoot,
        this.tools,
        input.signal,
      );
      const gitDiffBudget = Math.max(
        1,
        Math.min(64 * 1024, Math.floor(budget.maxBytes / 4)),
      );
      const [gitStatus, gitDiff] = await Promise.all([
        repository.gitStatus(),
        repository.gitDiff(gitDiffBudget),
      ]);
      const candidates = await this.findCandidates(
        repository,
        input.prompt,
        gitStatus.files.map((file) => file.path),
      );
      const files: ContextFile[] = [];
      let totalBytes = Buffer.byteLength(gitDiff.diff, "utf8");
      let truncated = gitDiff.truncated;

      for (const candidate of candidates) {
        if (files.length >= budget.maxFiles || totalBytes >= budget.maxBytes) {
          truncated = true;
          break;
        }

        const remainingBytes = budget.maxBytes - totalBytes;
        const readLimit = Math.min(budget.maxBytesPerFile, remainingBytes);
        if (readLimit <= 0) {
          truncated = true;
          break;
        }

        try {
          const result = await repository.readFile(candidate.path, readLimit);
          const contentBytes = Buffer.byteLength(result.content, "utf8");
          files.push({
            path: result.path,
            content: result.content,
            reason: [...candidate.reasons].join("; "),
            size: result.size,
            truncated: result.truncated,
          });
          totalBytes += contentBytes;
          truncated ||= result.truncated;
        } catch (error: unknown) {
          if (
            error instanceof NyxaraToolError &&
            ["file_not_found", "path_outside_workspace"].includes(error.code)
          ) {
            continue;
          }
          throw error;
        }
      }

      const estimatedTokens = this.tokenEstimator.estimate(
        [input.prompt, gitDiff.diff, ...files.map((file) => file.content)].join("\n"),
      );
      const bundle: ContextBundle = {
        workspaceRoot: input.workspaceRoot,
        prompt: input.prompt,
        files,
        git: { status: gitStatus, diff: gitDiff },
        totalBytes,
        estimatedTokens,
        truncated,
      };

      if (truncated) {
        this.events.emit("context.truncated", {
          workspaceRoot: input.workspaceRoot,
          fileCount: files.length,
          totalBytes,
        });
      }
      this.events.emit("context.completed", {
        workspaceRoot: input.workspaceRoot,
        fileCount: files.length,
        totalBytes,
        estimatedTokens,
        truncated,
      });
      return bundle;
    } catch (error: unknown) {
      this.events.emit("context.failed", {
        workspaceRoot: input.workspaceRoot,
        code: error instanceof NyxaraToolError ? error.code : "context_error",
      });
      throw error;
    }
  }

  private async findCandidates(
    repository: Repository,
    prompt: string,
    changedFiles: readonly string[],
  ): Promise<Candidate[]> {
    const candidates = new Map<string, Candidate>();
    const terms = extractSearchTerms(prompt);

    for (const path of changedFiles) {
      this.addCandidate(candidates, path, 20, "current Git change");
    }

    for (const term of terms) {
      const [fileMatches, codeMatches] = await Promise.all([
        repository.searchFiles(term, 24),
        repository.searchCode(term, 24),
      ]);
      for (const path of fileMatches.matches) {
        this.addCandidate(candidates, path, 10, `path matched "${term}"`);
      }
      for (const match of codeMatches.matches) {
        this.addCandidate(candidates, match.path, 6, `code matched "${term}"`);
      }
    }

    return [...candidates.values()].sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    );
  }

  private addCandidate(
    candidates: Map<string, Candidate>,
    path: string,
    score: number,
    reason: string,
  ): void {
    const candidate = candidates.get(path) ?? {
      path,
      score: 0,
      reasons: new Set<string>(),
    };
    candidate.score += score;
    candidate.reasons.add(reason);
    candidates.set(path, candidate);
  }

  private resolveBudget(budget: Partial<ContextBudget> | undefined): ContextBudget {
    const resolved = { ...DEFAULT_BUDGET, ...budget };
    if (
      !Number.isInteger(resolved.maxFiles) ||
      resolved.maxFiles <= 0 ||
      resolved.maxBytes <= 0 ||
      resolved.maxBytesPerFile <= 0
    ) {
      throw new NyxaraToolError("context_error", "Context budget is invalid");
    }
    return resolved;
  }
}

export function extractSearchTerms(prompt: string): string[] {
  return [
    ...new Set(
      prompt
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_./-]+/gu)
        ?.map((term) => term.replace(/^\W+|\W+$/g, ""))
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) ?? [],
    ),
  ].slice(0, 8);
}
