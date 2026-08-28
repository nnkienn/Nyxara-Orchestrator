import type { ContextFile } from "../context/context.types.js";
import { ReviewerError } from "./reviewer.errors.js";
import type {
  ReviewContextEvidence,
  ReviewEvidenceBudget,
  ReviewEvidenceBundle,
  ReviewEvidenceInput,
  ReviewValidationEvidence,
} from "./reviewer.types.js";

export const DEFAULT_REVIEW_EVIDENCE_BUDGET: ReviewEvidenceBudget = {
  maxDiffBytes: 96 * 1024,
  maxContextFiles: 6,
  maxContextBytes: 64 * 1024,
  maxBytesPerContextFile: 16 * 1024,
  maxValidationBytes: 12 * 1024,
  maxContextExpansions: 1,
};

const HARD_MAX_REVIEW_BYTES = 1024 * 1024;

export class ReviewEvidenceBuilder {
  build(input: ReviewEvidenceInput): ReviewEvidenceBundle {
    const requirement = input.requirement.trim();
    const objective = input.objective.trim();
    if (!requirement || !objective || input.execution.taskId !== input.task.id) {
      throw new ReviewerError(
        "invalid_review",
        "Review requirement, objective, and matching task evidence are required",
      );
    }
    const budget = resolveReviewEvidenceBudget(input.budget);
    const diff = buildDiffEvidence(
      input.execution.git.diff.diff,
      input.execution.changedFiles,
      input.execution.git.diff.truncated,
      budget.maxDiffBytes,
    );
    const validation = buildValidationEvidence(
      input.validation,
      budget.maxValidationBytes,
    );
    const contextResult = buildContextEvidence(
      input.contexts.flatMap((bundle) => bundle.files),
      budget,
    );

    return {
      requirement,
      objective,
      task: input.task,
      acceptanceCriteria: [...input.task.acceptanceCriteria],
      changedFiles: [...new Set(input.execution.changedFiles)].sort(),
      diff,
      validation,
      context: contextResult.context,
      ...(input.execution.summary
        ? { executorSummary: input.execution.summary }
        : {}),
      truncated:
        diff.truncated || validation.truncated || contextResult.truncated,
    };
  }

  expand(
    evidence: ReviewEvidenceBundle,
    files: readonly ContextFile[],
    budgetInput?: Partial<ReviewEvidenceBudget>,
  ): ReviewEvidenceBundle {
    const budget = resolveReviewEvidenceBudget(budgetInput);
    const existing = evidence.context.map((item): ContextFile => ({
      path: item.path,
      content: item.content,
      reason: item.reason ?? "reused review context",
      size: Buffer.byteLength(item.content, "utf8"),
      truncated: item.truncated,
    }));
    const contextResult = buildContextEvidence([...files, ...existing], budget);
    return {
      ...evidence,
      context: contextResult.context,
      truncated: evidence.truncated || contextResult.truncated,
    };
  }
}

export function resolveReviewEvidenceBudget(
  input?: Partial<ReviewEvidenceBudget>,
): ReviewEvidenceBudget {
  const budget = { ...DEFAULT_REVIEW_EVIDENCE_BUDGET, ...input };
  const values = [
    budget.maxDiffBytes,
    budget.maxContextFiles,
    budget.maxContextBytes,
    budget.maxBytesPerContextFile,
    budget.maxValidationBytes,
  ];
  if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new ReviewerError("reviewer_error", "Review evidence budget is invalid");
  }
  if (
    !Number.isInteger(budget.maxContextExpansions) ||
    budget.maxContextExpansions < 0
  ) {
    throw new ReviewerError("reviewer_error", "Review expansion budget is invalid");
  }
  if (
    budget.maxDiffBytes > HARD_MAX_REVIEW_BYTES ||
    budget.maxContextBytes > HARD_MAX_REVIEW_BYTES ||
    budget.maxBytesPerContextFile > HARD_MAX_REVIEW_BYTES ||
    budget.maxValidationBytes > HARD_MAX_REVIEW_BYTES
  ) {
    throw new ReviewerError(
      "review_evidence_too_large",
      "Review evidence budget exceeds the Phase 6 hard limit",
    );
  }
  return budget;
}

function buildDiffEvidence(
  rawDiff: string,
  changedFiles: readonly string[],
  sourceTruncated: boolean,
  maxBytes: number,
): ReviewEvidenceBundle["diff"] {
  const changed = new Set(changedFiles);
  const sections = splitDiff(rawDiff);
  const relevant = sections
    .filter((section) => changed.has(section.path))
    .map((section) => section.content)
    .join("");
  const bounded = truncateUtf8(relevant, maxBytes);
  const representedFiles = new Set(
    sections.filter((section) => changed.has(section.path)).map((section) => section.path),
  );
  const missingDiff = changedFiles.some((path) => !representedFiles.has(path));
  const lines = bounded.value.split("\n");
  return {
    files: [...changed].sort(),
    content: bounded.value,
    additions: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    deletions: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
    truncated: sourceTruncated || bounded.truncated || missingDiff,
  };
}

function splitDiff(diff: string): Array<{ path: string; content: string }> {
  const matches = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  return matches.map((match, index) => ({
    path: match[2]!,
    content: diff.slice(match.index!, matches[index + 1]?.index ?? diff.length),
  }));
}

function buildValidationEvidence(
  validation: ReviewEvidenceInput["validation"],
  maxBytes: number,
): ReviewValidationEvidence {
  let remaining = maxBytes;
  let truncated = false;
  const steps = validation.steps.map((step) => {
    const output = step.status === "passed"
      ? ""
      : [step.stderr, step.stdout]
          .filter((value): value is string => Boolean(value?.trim()))
          .join("\n")
          .trim();
    const bounded = truncateUtf8(output, remaining);
    remaining -= Buffer.byteLength(bounded.value, "utf8");
    truncated ||= bounded.truncated || Boolean(step.truncated);
    return {
      kind: step.kind,
      status: step.status,
      required: step.required,
      ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
      summary: `${step.kind}: ${step.status}`,
      ...(bounded.value ? { errorExcerpt: bounded.value } : {}),
      ...(bounded.truncated || step.truncated ? { truncated: true } : {}),
    };
  });
  return { status: validation.status, steps, truncated };
}

function buildContextEvidence(
  files: readonly ContextFile[],
  budget: ReviewEvidenceBudget,
): { context: ReviewContextEvidence[]; truncated: boolean } {
  const context: ReviewContextEvidence[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  let truncated = false;

  for (const file of files) {
    const path = normalizeEvidencePath(file.path);
    if (seenPaths.has(path)) continue;
    if (
      context.length >= budget.maxContextFiles ||
      totalBytes >= budget.maxContextBytes
    ) {
      truncated = true;
      break;
    }
    seenPaths.add(path);
    const remaining = budget.maxContextBytes - totalBytes;
    const bounded = truncateUtf8(
      file.content,
      Math.min(budget.maxBytesPerContextFile, remaining),
    );
    const endLine = Math.max(1, bounded.value.split("\n").length);
    context.push({
      id: `${path}:1-${endLine}`,
      path,
      startLine: 1,
      endLine,
      content: bounded.value,
      ...(file.reason ? { reason: file.reason } : {}),
      truncated: file.truncated || bounded.truncated,
    });
    totalBytes += Buffer.byteLength(bounded.value, "utf8");
    truncated ||= file.truncated || bounded.truncated;
  }
  return { context, truncated };
}

function normalizeEvidencePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return { value: output, truncated: true };
}

export function reviewContextBytes(evidence: ReviewEvidenceBundle): number {
  return evidence.context.reduce(
    (total, item) => total + Buffer.byteLength(item.content, "utf8"),
    0,
  );
}
