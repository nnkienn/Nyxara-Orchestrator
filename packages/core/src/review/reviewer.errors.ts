export type ReviewerErrorCode =
  | "reviewer_error"
  | "reviewer_aborted"
  | "reviewer_not_configured"
  | "invalid_model"
  | "review_parse_error"
  | "invalid_review"
  | "review_context_request_invalid"
  | "review_context_limit_exceeded"
  | "review_evidence_too_large"
  | "review_validation_failed";

export class ReviewerError extends Error {
  constructor(
    readonly code: ReviewerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewerError";
  }
}
