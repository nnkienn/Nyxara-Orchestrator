import type { PlannedTask } from "../planner/planner.types.js";
import { truncateUtf8 } from "../internal/text.js";
import { extractSearchTerms } from "./context-engine.js";
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
}

/** Deterministic query text for one task; no model call is involved. */
export function taskContextQuery(task: PlannedTask): string {
  return [
    ...(task.relevantFiles ?? []),
    task.title,
    task.description,
    ...task.acceptanceCriteria,
  ].join("\n");
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
  const relevant = new Set(
    (input.task.relevantFiles ?? []).map((path) => normalize(path)),
  );
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
  let totalBytes = Buffer.byteLength(
    input.plannerContext.git.diff.diff,
    "utf8",
  );
  let truncated = false;

  for (const entry of scored) {
    if (files.length >= budget.maxFiles || totalBytes >= budget.maxBytes) {
      truncated = true;
      break;
    }
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
    const normalized = normalize(entry.file.path);
    if (relevant.has(normalized)) matched.add(normalized);
  }

  const context: ContextBundle = {
    workspaceRoot: input.plannerContext.workspaceRoot,
    prompt: taskContextQuery(input.task),
    files,
    git: input.plannerContext.git,
    totalBytes,
    estimatedTokens: input.plannerContext.estimatedTokens,
    truncated,
  };
  return {
    context,
    matchedRelevantFiles: [...matched],
    missingRelevantFiles: [...relevant].filter((path) => !matched.has(path)),
  };
}
