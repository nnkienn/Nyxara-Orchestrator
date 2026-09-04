import { describe, expect, it } from "vitest";
import { friendlyErrorMessage, taskStatusGlyph, workflowStage, safeErrorMessage, usageSummary } from "../src/projection.js";

describe("VS Code workflow projection", () => {
  it("maps Core task statuses without scheduling logic", () => {
    expect(taskStatusGlyph("completed")).toBe("✓");
    expect(taskStatusGlyph("running")).toBe("●");
    expect(taskStatusGlyph("blocked")).toBe("⚠");
    expect(taskStatusGlyph("pending")).toBe("○");
  });
  it("renders Core stages", () => {
    expect(workflowStage({ status: "validating" } as any)).toBe("Validating");
    expect(workflowStage({ status: "reviewing" } as any)).toBe("Reviewing");
    expect(workflowStage(undefined)).toBe("Idle");
  });
  it("bounds error display", () => {
    expect(safeErrorMessage(new Error("x".repeat(500))).length).toBe(240);
    expect(safeErrorMessage("secret")).toBe("Nyxara operation failed");
  });
  it("projects authoritative Core usage without recalculation", () => {
    expect(usageSummary({ usage: { totalTokens: 7073, totalProviderCalls: 3, usageSource: "provider_reported", totalDurationMs: 20620 } } as any)).toEqual({ tokens: 7073, modelCalls: 3, usageSource: "Provider reported", durationMs: 20620 });
  });
  it.each([
    ["authentication_error", "Provider authentication failed. Check the configured credential."],
    ["invalid_model", "Configured model unavailable. Choose another model."],
    ["network_error", "Network error. Check the provider endpoint and connection."],
    ["invalid_plan", "Structured plan invalid. Try generating the plan again."],
    ["permission_denied", "Permission denied."],
    ["validation_failed", "Validation failed."],
    ["review_failed", "Review failed."],
    ["aborted", "Workflow aborted."],
  ])("maps known %s errors for inline display", (code, expected) => {
    expect(friendlyErrorMessage({ code, message: "raw provider body" })).toBe(expected);
  });
});
