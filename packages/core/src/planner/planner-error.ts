export type PlannerErrorCode =
  | "planner_error"
  | "invalid_plan"
  | "plan_parse_error"
  | "plan_response_empty"
  | "plan_response_truncated"
  | "plan_cycle_detected"
  | "plan_bounds_exceeded"
  | "clarification_required"
  | "missing_dependency"
  | "self_dependency"
  | "invalid_model";

export class PlannerError extends Error {
  constructor(
    readonly code: PlannerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
