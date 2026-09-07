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

/** User-facing outcome label. Rejection is a user action, not a system failure. */
export function outcomeLabel(outcome: string | undefined): string {
  switch (outcome) {
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
    case "rejected": return "Plan Rejected";
    case "interrupted": return "Interrupted";
    default: return "Active";
  }
}

export function workflowStage(snapshot: WorkflowSnapshot | undefined): string {
  // A rejected plan is presented as its own outcome rather than a failed stage.
  if (snapshot?.outcome === "rejected") return "Plan Rejected";
  if (!snapshot) return "Idle";
  switch (snapshot.status) {
    case "created": return "Analyzing";
    case "planning": return "Planning";
    case "awaiting_plan_approval": return "Awaiting Approval";
    case "approved": return "Approved";
    case "executing": case "running": return "Executing";
    case "validating": return "Validating";
    case "reviewing": return "Reviewing";
    case "repairing": return "Repairing";
    case "waiting_for_permission": return "Waiting for Permission";
    case "paused": return "Paused";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
    case "planned": return "Planned";
  }
}

/**
 * Compact truthful token line. Cache read/write are shown separately so a
 * cache-heavy call never appears as a tiny input count, and absent cache values
 * stay hidden rather than displayed as zero.
 */
export function tokenSummaryParts(usage: {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
} | undefined): readonly string[] {
  if (!usage) return [];
  const compact = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K` : `${value}`;
  return [
    ...(usage.inputTokens != null ? [`${compact(usage.inputTokens)} input`] : []),
    ...(usage.cacheReadTokens != null && usage.cacheReadTokens > 0 ? [`${compact(usage.cacheReadTokens)} cache read`] : []),
    ...(usage.cacheWriteTokens != null && usage.cacheWriteTokens > 0 ? [`${compact(usage.cacheWriteTokens)} cache write`] : []),
    ...(usage.outputTokens != null ? [`${compact(usage.outputTokens)} output`] : []),
  ];
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
      .replace(/((?:access|refresh|device|bearer)[-_ ]?token\s*[:=]\s*)[^\s,;&]+/gi, "$1[redacted]")
      .replace(/(cookie\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted]");
  }
  return "Nyxara operation failed";
}

export function friendlyErrorMessage(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown } : undefined;
  const code = typeof record?.code === "string" ? record.code : "";
  switch (code) {
    case "provider_not_configured": return "Provider not configured.";
    case "authentication_error": return "Provider authentication failed. Check the configured credential.";
    case "invalid_model": return "Configured model unavailable. Choose another model.";
    case "network_error": return "Network error. Check the provider endpoint and connection.";
    case "invalid_plan": case "plan_response_invalid": {
      const detail = typeof record?.message === "string" && record.message.startsWith("Planner plan field ")
        ? `${safeErrorMessage(new Error(record.message))}. `
        : "";
      return `${detail}The model returned an invalid plan. Try again or choose another model.`;
    }
    case "plan_parse_error": return "The model response did not contain valid plan JSON. Try again or choose another model.";
    case "plan_response_empty": return "The provider returned an empty Planner response. No plan was accepted. Try again or choose another model.";
    case "plan_response_truncated": return "The provider stopped at its output limit before completing the plan. No plan was accepted. Narrow the requirement or choose another model.";
    case "permission_denied": return "Permission denied.";
    case "validation_failed": return "Validation failed.";
    case "review_failed": return "Review failed.";
    case "aborted": return "Workflow aborted.";
    case "plan_rejected": return "No changes were made.";
    case "plan_bounds_exceeded": {
      const detail = typeof record?.message === "string" && record.message.startsWith("Planner returned ") && /beyond the supported bound \(\d+ > \d+\)$/.test(record.message)
        ? record.message : "Planner exceeded the supported plan limits";
      return safeErrorMessage(new Error(`${detail}. No plan was accepted. Retry planning or choose another model.`));
    }
  }
  if (typeof record?.message === "string") return safeErrorMessage(new Error(record.message));
  return safeErrorMessage(error);
}
