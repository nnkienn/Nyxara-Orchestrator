import type { WorkflowSnapshot } from "@nyxara/core";

export function taskStatusGlyph(status: string | undefined): string {
  switch (status) {
    case "completed": return "✓";
    case "running": return "●";
    case "failed": return "✗";
    case "blocked": return "⚠";
    default: return "○";
  }
}

export function workflowStage(snapshot: WorkflowSnapshot | undefined): string {
  if (!snapshot) return "Idle";
  switch (snapshot.status) {
    case "executing": case "running": return "Executing";
    case "validating": return "Validating";
    case "reviewing": return "Reviewing";
    case "repairing": return "Repairing";
    default: return snapshot.status.replaceAll("_", " ");
  }
}

/** Bounded, metadata-only text suitable for a sidebar or notification. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return "Nyxara operation failed";
}
