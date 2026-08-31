/**
 * Named diff/output budgets. Subsystems intentionally keep different bounds:
 * execution needs the widest evidence window, context and review are narrower
 * because their payloads are sent to a model on every turn.
 */
export const EXECUTION_DIFF_MAX_BYTES = 256 * 1024;
export const VALIDATION_DIFF_MAX_BYTES = 256 * 1024;
export const CONTEXT_DIFF_MAX_BYTES = 64 * 1024;
export const REVIEW_DIFF_MAX_BYTES = 96 * 1024;
export const REPAIR_DIFF_MAX_BYTES = 48 * 1024;
export const REPAIR_EVIDENCE_MAX_BYTES = 64 * 1024;
