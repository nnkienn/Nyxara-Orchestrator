import { createHash } from "node:crypto";
import type { ExecutionResult } from "../executor/executor.types.js";
import type { PlannedTask } from "../planner/planner.types.js";
import type { ReviewResult } from "../review/reviewer.types.js";
import type {
  ValidationResult,
  ValidationStepResult,
} from "../validation/validation.types.js";
import { RepairError } from "./repair.errors.js";
import type {
  RepairEvidence,
  RepairFinding,
  RepairTask,
} from "./repair.types.js";

const MAX_MESSAGE_LENGTH = 400;
const MAX_FINDINGS = 12;
const MAX_RELEVANT_FILES = 8;
const MAX_ACCEPTANCE_CRITERIA = 10;

export interface BuildRepairTaskInput {
  readonly originalTask: PlannedTask;
  readonly execution: ExecutionResult;
  readonly validation: ValidationResult;
  readonly review?: ReviewResult;
  readonly evidence: RepairEvidence;
  readonly cycle: number;
}

export interface ValidationFailureDetail {
  readonly kind: ValidationStepResult["kind"];
  readonly status: ValidationStepResult["status"];
  readonly finding: RepairFinding;
  /** True when the original validator output was bounded before storage. */
  readonly truncated: boolean;
}

/**
 * Deterministic RepairTask builder. It never calls a model: it reduces the
 * existing validation and review evidence to the smallest actionable repair
 * description.
 */
export class RepairTaskBuilder {
  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  build(input: BuildRepairTaskInput): RepairTask {
    const findings = deduplicateFindings([
      ...validationFindings(input.validation),
      ...reviewFindings(input.review),
    ]).slice(0, MAX_FINDINGS);
    if (findings.length === 0) {
      throw new RepairError(
        "repair_not_required",
        "A repair task requires actionable validation or review failures",
      );
    }

    const hasValidation = findings.some(
      (finding) => finding.source === "validation",
    );
    const hasReview = findings.some((finding) => finding.source === "review");
    const relevantFiles = unique([
      ...findings.flatMap((finding) => (finding.file ? [finding.file] : [])),
      ...input.evidence.currentChangedFiles,
      ...(input.originalTask.relevantFiles ?? []),
    ]).slice(0, MAX_RELEVANT_FILES);
    const fingerprint = createHash("sha256")
      .update(findings.map(findingKey).join("|"))
      .digest("hex")
      .slice(0, 12);

    return Object.freeze({
      id: "repair-" + input.originalTask.id + "-" + input.cycle + "-" + fingerprint,
      originalTaskId: input.originalTask.id,
      cycle: input.cycle,
      reason:
        hasValidation && hasReview
          ? "validation_and_review_failure"
          : hasValidation
            ? "validation_failure"
            : "review_failure",
      objective: objectiveFrom(findings),
      findings,
      acceptanceCriteria: unique([
        ...findings.map((finding) => "Resolve: " + finding.message),
        "Preserve already-correct behavior and the existing public shape",
        "Deterministic validation passes without new failures",
      ]).slice(0, MAX_ACCEPTANCE_CRITERIA),
      relevantFiles,
      createdAt: this.now(),
    });
  }
}

export function validationFailureDetails(
  result: ValidationResult,
): ValidationFailureDetail[] {
  return result.steps
    .filter(
      (step) =>
        step.required && !["passed", "skipped"].includes(step.status),
    )
    .map((step) => {
      const output = [step.stderr, step.stdout]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n")
        .trim();
      const headline =
        output.split("\n").find((line) => line.trim())?.trim() ??
        step.kind + " " + step.status;
      const location = parseLocation(output);
      const bounded = boundMessageWithFlag(headline);
      return {
        kind: step.kind,
        status: step.status,
        finding: {
          source: "validation" as const,
          code: step.errorCode ?? step.kind,
          message: bounded.value,
          ...(location.file ? { file: location.file } : {}),
          ...(location.line ? { line: location.line } : {}),
          severity: "error",
        },
        truncated: bounded.truncated,
      };
    });
}

export function validationFindings(result: ValidationResult): RepairFinding[] {
  return validationFailureDetails(result).map((detail) => detail.finding);
}

export function reviewFindings(result?: ReviewResult): RepairFinding[] {
  if (!result || result.status === "passed") return [];
  return result.findings
    .filter((finding) => finding.severity !== "info")
    .map((finding) => ({
      source: "review" as const,
      code: finding.category,
      message: boundMessage(finding.message),
      ...(finding.file ? { file: normalizePath(finding.file) } : {}),
      ...(finding.line ? { line: finding.line } : {}),
      severity: finding.severity,
    }));
}

/**
 * Deterministic deduplication key: source + file + line + normalized message.
 */
export function findingKey(finding: RepairFinding): string {
  return [
    finding.source,
    normalizePath(finding.file ?? ""),
    finding.line ?? "",
    normalizeMessage(finding.message),
  ].join(":");
}

export function deduplicateFindings(
  findings: readonly RepairFinding[],
): RepairFinding[] {
  const unique = new Map<string, RepairFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

function objectiveFrom(findings: readonly RepairFinding[]): string {
  const primary = findings[0]!;
  const location = primary.file
    ? " in " + primary.file + (primary.line ? ":" + primary.line : "")
    : "";
  const extra =
    findings.length > 1 ? " (+" + (findings.length - 1) + " more failure(s))" : "";
  return (
    "Repair: " + primary.message.replace(/[.\s]+$/, "") + location + extra + "."
  );
}

function parseLocation(value: string): { file?: string; line?: number } {
  const match = value.match(
    /((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+)(?::|\()(\d+)/,
  );
  if (!match) return {};
  return { file: normalizePath(match[1]!), line: Number(match[2]) };
}

function boundMessage(value: string): string {
  return boundMessageWithFlag(value).value;
}

function boundMessageWithFlag(value: string): { value: string; truncated: boolean } {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= MAX_MESSAGE_LENGTH
    ? { value: normalized, truncated: false }
    : { value: normalized.slice(0, MAX_MESSAGE_LENGTH), truncated: true };
}

function normalizeMessage(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
