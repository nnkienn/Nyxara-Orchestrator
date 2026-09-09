import type { PlannedTask } from "../planner/planner.types.js";
import { CONTEXT_DIFF_MAX_BYTES } from "../internal/byte-limits.js";
import { truncateUtf8 } from "../internal/text.js";
import { extractSearchTerms } from "./context-engine.js";
import { extractRepositoryTargetHints } from "./planning-context-policy.js";
import { ApproximateTokenEstimator } from "./token-estimator.js";
import type {
  ContextBudget,
  ContextBundle,
  ContextFile,
} from "./context.types.js";

export const DEFAULT_TASK_CONTEXT_BUDGET: ContextBudget = {
  maxFiles: 6,
  maxBytes: 96 * 1024,
  maxBytesPerFile: 24 * 1024,
};

export interface TaskContextSelection {
  readonly context: ContextBundle;
  readonly matchedRelevantFiles: readonly string[];
  readonly missingRelevantFiles: readonly string[];
  readonly missingSymbols: readonly string[];
}

const TOKEN_ESTIMATOR = new ApproximateTokenEstimator();

/** Deterministic query text for one task; no model call is involved. */
export function taskContextQuery(task: PlannedTask): string {
  return [
    ...(task.relevantFiles ?? []),
    task.title,
    task.description,
    ...task.acceptanceCriteria,
  ].join("\n");
}

/** Paths and symbols carried by the approved task, bounded before retrieval. */
export function taskContextTargets(task: PlannedTask): {
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
} {
  const hints = extractRepositoryTargetHints(taskContextQuery(task));
  return {
    paths: [...new Set([
      ...(task.relevantFiles ?? []).map(normalize),
      ...hints.paths.map(normalize),
    ])],
    symbols: hints.symbols,
  };
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function scoreFile(
  file: ContextFile,
  relevant: ReadonlySet<string>,
  terms: readonly string[],
): number {
  const path = normalize(file.path);
  let score = relevant.has(path) ? 100 : 0;
  if (file.reason.startsWith("Targeted context requested")) score += 80;
  for (const term of terms) {
    if (path.toLocaleLowerCase().includes(term)) score += 10;
  }
  if (score === 0) {
    const content = file.content.toLocaleLowerCase();
    for (const term of terms) {
      if (content.includes(term)) score += 3;
    }
  }
  return score;
}

/**
 * Narrows an existing Planner ContextBundle to the evidence one task needs.
 * Preference order is exact relevant file, then path/term match, then nearby
 * planner entries used only to fill the remaining budget.
 */
export function selectTaskContext(input: {
  readonly task: PlannedTask;
  readonly plannerContext: ContextBundle;
  readonly budget?: Partial<ContextBudget>;
}): TaskContextSelection {
  const budget = { ...DEFAULT_TASK_CONTEXT_BUDGET, ...input.budget };
  const targets = taskContextTargets(input.task);
  const relevant = new Set(targets.paths);
  const terms = extractSearchTerms(taskContextQuery(input.task));
  const scored = input.plannerContext.files
    .map((file, index) => ({
      file,
      index,
      score: scoreFile(file, relevant, terms),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        normalize(left.file.path).localeCompare(normalize(right.file.path)),
    );

  const files: ContextFile[] = [];
  const matched = new Set<string>();
  const selectedPaths = new Set<string>();
  const boundedDiff = truncateUtf8(
    input.plannerContext.git.diff.diff,
    Math.max(
      1,
      Math.min(CONTEXT_DIFF_MAX_BYTES, Math.floor(budget.maxBytes / 4)),
    ),
  );
  const git = {
    status: input.plannerContext.git.status,
    diff: {
      ...input.plannerContext.git.diff,
      diff: boundedDiff.value,
      truncated:
        input.plannerContext.git.diff.truncated || boundedDiff.truncated,
    },
  };
  let totalBytes = Buffer.byteLength(boundedDiff.value, "utf8");
  let truncated = git.diff.truncated;

  for (const entry of scored) {
    if (files.length >= budget.maxFiles || totalBytes >= budget.maxBytes) {
      truncated = true;
      break;
    }
    const entryPath = normalize(entry.file.path);
    if (selectedPaths.has(entryPath)) continue;
    const remaining = budget.maxBytes - totalBytes;
    const bounded = truncateUtf8(
      entry.file.content,
      Math.min(budget.maxBytesPerFile, remaining),
    );
    files.push({
      path: entry.file.path,
      content: bounded.value,
      reason: entry.file.reason,
      size: entry.file.size,
      truncated: entry.file.truncated || bounded.truncated,
    });
    totalBytes += Buffer.byteLength(bounded.value, "utf8");
    truncated ||= entry.file.truncated || bounded.truncated;
    selectedPaths.add(entryPath);
    if (relevant.has(entryPath)) matched.add(entryPath);
  }

  const context: ContextBundle = {
    workspaceRoot: input.plannerContext.workspaceRoot,
    prompt: taskContextQuery(input.task),
    files,
    git,
    totalBytes,
    estimatedTokens: TOKEN_ESTIMATOR.estimate(
      [taskContextQuery(input.task), boundedDiff.value, ...files.map((file) => file.content)].join("\n"),
    ),
    truncated,
    ...(input.plannerContext.targetIssues
      ? { targetIssues: input.plannerContext.targetIssues }
      : {}),
  };
  const selectedText = files
    .map((file) => `${file.path}\n${file.content}`)
    .join("\n")
    .toLocaleLowerCase();
  const explicitRelevant = new Set((input.task.relevantFiles ?? []).map(normalize));
  return {
    context,
    matchedRelevantFiles: [...matched].filter((path) => explicitRelevant.has(path)),
    missingRelevantFiles: [...relevant].filter((path) => !matched.has(path)),
    missingSymbols: targets.symbols.filter((symbol) =>
      !selectedText.includes(symbol.toLocaleLowerCase()),
    ),
  };
}
