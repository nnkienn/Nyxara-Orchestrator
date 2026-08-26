export type PlannerErrorCode =
  | "planner_error"
  | "invalid_plan"
  | "plan_parse_error"
  | "plan_cycle_detected"
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

