import type { ContextBundle, ContextFile } from "../context/context.types.js";
import type { ExecutionResult } from "../executor/executor.types.js";
import { truncateUtf8 } from "../review/review-evidence-builder.js";
import type { ReviewResult } from "../review/reviewer.types.js";
import type { ValidationResult } from "../validation/validation.types.js";
import {
  reviewFindings,
  validationFailureDetails,
} from "./repair-task-builder.js";
import type {
  RepairContextEvidence,
  RepairEvidence,
  RepairLimits,
} from "./repair.types.js";

const MAX_CONTEXT_FILES = 6;
const MAX_VALIDATION_FAILURES = 8;
const MAX_REVIEW_FINDINGS = 8;
const MAX_BYTES_PER_CONTEXT_FILE = 16 * 1024;

export interface BuildRepairEvidenceInput {
  readonly taskId: string;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly review?: ReviewResult;
  readonly contexts: readonly ContextBundle[];
  readonly additionalContext?: readonly ContextFile[];
  readonly limits: Pick<RepairLimits, "maxEvidenceBytes" | "maxDiffBytes">;
}

/**
 * Bounded repair evidence. Successful logs, unrelated task history, and raw
 * provider payloads are never included.
 */
export class RepairEvidenceBuilder {
  build(input: BuildRepairEvidenceInput): RepairEvidence {
    const validationBudget = Math.floor(input.limits.maxEvidenceBytes / 3);
    const reviewBudget = Math.floor(input.limits.maxEvidenceBytes / 3);
    const contextBudget =
      input.limits.maxEvidenceBytes - validationBudget - reviewBudget;
    let validationRemaining = validationBudget;
    const validationFailures = validationFailureDetails(input.validation)
      .slice(0, MAX_VALIDATION_FAILURES)
      .map((detail) => {
        const bounded = truncateUtf8(
          detail.finding.message,
          Math.max(0, validationRemaining),
        );
        validationRemaining -= Buffer.byteLength(bounded.value, "utf8");
        return {
          kind: detail.kind,
          status: detail.status,
          ...(detail.finding.code ? { code: detail.finding.code } : {}),
          message: bounded.value,
          ...(detail.finding.file ? { file: detail.finding.file } : {}),
          ...(detail.finding.line ? { line: detail.finding.line } : {}),
          truncated: detail.truncated || bounded.truncated,
        };
      });

    let reviewRemaining = reviewBudget;
    const findings = reviewFindings(input.review)
      .slice(0, MAX_REVIEW_FINDINGS)
      .map((finding) => {
        const bounded = truncateUtf8(finding.message, reviewRemaining);
        reviewRemaining -= Buffer.byteLength(bounded.value, "utf8");
        return {
          ...(finding.code ? { code: finding.code } : {}),
          message: bounded.value,
          ...(finding.file ? { file: finding.file } : {}),
          ...(finding.line ? { line: finding.line } : {}),
          ...(finding.severity ? { severity: finding.severity } : {}),
        };
      });

    const relevantPaths = new Set([
      ...validationFailures.flatMap((failure) =>
        failure.file ? [failure.file] : [],
      ),
      ...findings.flatMap((finding) => (finding.file ? [finding.file] : [])),
      ...input.execution.changedFiles,
    ]);
    const relevantContext = this.buildContext(
      [
        ...(input.additionalContext ?? []),
        ...input.contexts.flatMap((context) => context.files),
      ],
      relevantPaths,
      contextBudget,
    );
    const diff = truncateUtf8(
      relevantDiff(input.execution.git.diff.diff, input.execution.changedFiles),
      input.limits.maxDiffBytes,
    );

    return Object.freeze({
      originalTaskId: input.taskId,
      currentChangedFiles: [...new Set(input.execution.changedFiles)].sort(),
      validationFailures,
      reviewFindings: findings,
      relevantContext,
      diff: {
        content: diff.value,
        truncated: input.execution.git.diff.truncated || diff.truncated,
      },
    });
  }

  private buildContext(
    files: readonly ContextFile[],
    relevantPaths: ReadonlySet<string>,
    maxBytes: number,
  ): RepairContextEvidence[] {
    const context: RepairContextEvidence[] = [];
    const seen = new Set<string>();
    let remaining = maxBytes;

    for (const file of files) {
      if (context.length >= MAX_CONTEXT_FILES || remaining <= 0) break;
      if (!relevantPaths.has(file.path) || seen.has(file.path)) continue;
      seen.add(file.path);
      const bounded = truncateUtf8(
        file.content,
        Math.min(MAX_BYTES_PER_CONTEXT_FILE, remaining),
      );
      remaining -= Buffer.byteLength(bounded.value, "utf8");
      context.push({
        path: file.path,
        content: bounded.value,
        reason: file.reason,
        truncated: file.truncated || bounded.truncated,
      });
    }
    return context;
  }
}

/**
 * Keeps only the diff sections for files the current execution actually changed,
 * so historical or unrelated patch text is not resent every cycle.
 */
export function relevantDiff(
  diff: string,
  changedFiles: readonly string[],
): string {
  if (changedFiles.length === 0) return "";
  const changed = new Set(changedFiles);
  const headers = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (headers.length === 0) return diff;
  return headers
    .filter((header) => changed.has(header[2]!))
    .map((header) => {
      const start = header.index!;
      const next = headers.find((candidate) => candidate.index! > start);
      return diff.slice(start, next?.index ?? diff.length);
    })
    .join("");
}
