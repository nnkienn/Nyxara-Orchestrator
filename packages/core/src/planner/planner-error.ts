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

export interface PlannerStructureViolation {
  readonly path: string;
  readonly actual: number;
  readonly maximum: number;
  readonly kind: "length" | "count";
}

export class PlannerError extends Error {
  constructor(
    readonly code: PlannerErrorCode,
    message: string,
    readonly violations?: readonly PlannerStructureViolation[],
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
