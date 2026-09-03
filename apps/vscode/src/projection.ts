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

export function usageSummary(snapshot: WorkflowSnapshot | undefined): { tokens: number | null; modelCalls: number; usageSource: string; durationMs?: number | null } | undefined {
  const usage = snapshot?.usage;
  if (!usage) return undefined;
  return { tokens: usage.totalTokens, modelCalls: usage.totalProviderCalls, usageSource: usage.usageSource === "provider_reported" ? "Provider reported" : usage.usageSource === "estimated" ? "Estimated" : "Unavailable", ...(usage.totalDurationMs !== undefined ? { durationMs: usage.totalDurationMs } : {}) };
}

/** Bounded, metadata-only text suitable for a sidebar or notification. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const bounded = error.message.slice(0, 240);
    return bounded
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
      .replace(/(api[-_ ]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted]");
  }
  return "Nyxara operation failed";
}
