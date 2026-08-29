export type RepairErrorCode =
  | "repair_error"
  | "repair_not_required"
  | "repair_limits_invalid"
  | "repair_evidence_insufficient"
  | "task_not_found";

export class RepairError extends Error {
  constructor(
    readonly code: RepairErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepairError";
  }
}
