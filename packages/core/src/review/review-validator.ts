import { isAbsolute, posix } from "node:path";
import type { ValidationResult } from "../validation/validation.types.js";
import type { ReviewResultDraft } from "./reviewer.schema.js";
import { ReviewerError } from "./reviewer.errors.js";
import type {
  ReviewContextRequest,
  ReviewResult,
} from "./reviewer.types.js";

const BROAD_REQUESTS = [
  "all files",
  "whole repo",
  "whole repository",
  "entire repo",
  "entire repository",
  "scan project",
  "scan repository",
  "everything",
];
const BROAD_PATHS = new Set([".", "src", "lib", "app", "apps", "packages"]);

export class ReviewValidator {
  validate(
    draft: ReviewResultDraft,
    acceptanceCriteria: readonly string[],
    validation: ValidationResult,
  ): ReviewResult {
    assertAllCriteriaEvaluated(draft, acceptanceCriteria);
    const contextRequest = draft.contextRequest
      ? normalizeContextRequest(draft.contextRequest)
      : undefined;
    if (draft.status === "needs_more_context") {
      if (!contextRequest) {
        throw new ReviewerError(
          "invalid_review",
          "A needs-more-context result must include a context request",
        );
      }
      validateReviewContextRequest(contextRequest);
    } else if (contextRequest) {
      throw new ReviewerError(
        "invalid_review",
        "Only a needs-more-context result may include a context request",
      );
    }

    const findings = draft.findings.map((finding, index) => ({
      id: `RF${index + 1}`,
      severity: finding.severity,
      category: finding.category,
      message: finding.message,
      ...(finding.file ? { file: finding.file } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.taskId ? { taskId: finding.taskId } : {}),
    }));
    let status = draft.status;

    const deterministicFailure =
      validation.status === "failed" ||
      validation.steps.some(
        (step) =>
          (step.required && step.status !== "passed") ||
          step.status === "errored" ||
          step.status === "timed_out",
      );
    if (deterministicFailure) {
      status = "failed";
      findings.push({
        id: `RF${findings.length + 1}`,
        severity: "error",
        category: "testing",
        message: "Deterministic validation failed; an AI review cannot override it.",
      });
    } else if (
      status === "passed" &&
      (draft.criteria.some((criterion) => criterion.status !== "satisfied") ||
        findings.some((finding) =>
          finding.severity === "error" || finding.severity === "critical"
        ))
    ) {
      status = "failed";
    }

    return {
      status,
      summary: draft.summary,
      findings,
      criteria: draft.criteria,
      ...(draft.risks ? { risks: draft.risks } : {}),
      ...(status === "needs_more_context" && contextRequest
        ? { contextRequest }
        : {}),
      reviewedAt: new Date().toISOString(),
    };
  }
}

export function validateReviewContextRequest(
  request: ReviewContextRequest,
): void {
  const reasons = request.reasons.map((reason) => reason.trim());
  if (
    reasons.length === 0 ||
    reasons.some((reason) =>
      BROAD_REQUESTS.some((broad) => reason.toLocaleLowerCase().includes(broad)),
    )
  ) {
    throw new ReviewerError(
      "review_context_request_invalid",
      "Reviewer context reasons must be specific",
    );
  }

  const paths = request.paths ?? [];
  const symbols = request.symbols ?? [];
  if (paths.length + symbols.length === 0) {
    throw new ReviewerError(
      "review_context_request_invalid",
      "Reviewer must request a specific path or symbol",
    );
  }
  for (const requestedPath of paths) {
    const normalized = requestedPath.trim().replaceAll("\\", "/");
    const lower = normalized.toLocaleLowerCase();
    if (
      !normalized ||
      isAbsolute(normalized) ||
      normalized.endsWith("/") ||
      normalized.split("/").includes("..") ||
      /[*?\[\]{}]/.test(normalized) ||
      BROAD_PATHS.has(lower) ||
      BROAD_REQUESTS.some((broad) => lower.includes(broad))
    ) {
      throw new ReviewerError(
        "review_context_request_invalid",
        "Reviewer requested a broad or unsafe repository path",
      );
    }
  }
  for (const symbol of symbols) {
    if (!/^[\p{L}_$][\p{L}\p{N}_$.:#-]{0,127}$/u.test(symbol.trim())) {
      throw new ReviewerError(
        "review_context_request_invalid",
        "Reviewer requested a broad or invalid symbol",
      );
    }
  }
}

function assertAllCriteriaEvaluated(
  draft: ReviewResultDraft,
  acceptanceCriteria: readonly string[],
): void {
  const expected = [...acceptanceCriteria].sort();
  const received = draft.criteria.map((criterion) => criterion.criterion).sort();
  if (
    expected.length !== received.length ||
    expected.some((criterion, index) => criterion !== received[index])
  ) {
    throw new ReviewerError(
      "invalid_review",
      "Reviewer must evaluate every acceptance criterion exactly once",
    );
  }
}

function normalizeContextRequest(
  request: NonNullable<ReviewResultDraft["contextRequest"]>,
): ReviewContextRequest {
  return {
    ...(request.paths
      ? { paths: deduplicate(request.paths.map((path) => posix.normalize(path))) }
      : {}),
    ...(request.symbols ? { symbols: deduplicate(request.symbols) } : {}),
    reasons: deduplicate(request.reasons),
  };
}

function deduplicate(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))];
}
