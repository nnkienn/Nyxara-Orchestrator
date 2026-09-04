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
    case "created": return "Analyzing";
    case "planning": return "Planning";
    case "awaiting_plan_approval": return "Awaiting approval";
    case "approved": return "Approved";
    case "executing": case "running": return "Executing";
    case "validating": return "Validating";
    case "reviewing": return "Reviewing";
    case "repairing": return "Repairing";
    case "waiting_for_permission": return "Waiting for permission";
    case "paused": return "Paused";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
    case "planned": return "Planned";
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
    case "invalid_plan": case "plan_response_invalid": return "Structured plan invalid. Try generating the plan again.";
    case "permission_denied": return "Permission denied.";
    case "validation_failed": return "Validation failed.";
    case "review_failed": return "Review failed.";
    case "aborted": return "Workflow aborted.";
  }
  if (typeof record?.message === "string") return safeErrorMessage(new Error(record.message));
  return safeErrorMessage(error);
}
