import { describe, expect, it } from "vitest";
import { friendlyErrorMessage, outcomeLabel, taskStatusGlyph, workflowStage, safeErrorMessage, usageSummary } from "../src/projection.js";

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
  it.each([
    ["completed", "Completed"], ["failed", "Failed"], ["rejected", "Plan Rejected"], ["aborted", "Aborted"], ["interrupted", "Interrupted"],
  ])("renders the public %s outcome as %s", (outcome, label) => expect(outcomeLabel(outcome)).toBe(label));
  it("bounds error display", () => {
    expect(safeErrorMessage(new Error("x".repeat(500))).length).toBe(240);
    expect(safeErrorMessage("secret")).toBe("Nyxara operation failed");
  });
  it("shows the precise oversized-plan field instead of blaming the requirement", () => {
    const message = friendlyErrorMessage({ code: "plan_bounds_exceeded", message: "Planner returned acceptance criteria for T7 beyond the supported bound (8 > 6)" });
    expect(message).toContain("T7");
    expect(message).toContain("8 > 6");
    expect(message).not.toContain("narrow the requirement");
  });
  it("bounds and redacts structural diagnostics without exposing arbitrary provider errors", () => {
    expect(friendlyErrorMessage({ code: "plan_bounds_exceeded", message: "private-provider-response" })).not.toContain("private-provider-response");
    const message = friendlyErrorMessage({ code: "plan_bounds_exceeded", message: "Planner returned acceptance criteria for sk-privateexample12345678 beyond the supported bound (8 > 6)" });
    expect(message).not.toContain("sk-privateexample12345678");
    expect(message.length).toBeLessThanOrEqual(240);
  });
  it("projects authoritative Core usage without recalculation", () => {
    expect(usageSummary({ usage: { totalTokens: 7073, totalProviderCalls: 3, usageSource: "provider_reported", totalDurationMs: 20620 } } as any)).toEqual({ tokens: 7073, modelCalls: 3, usageSource: "Provider reported", durationMs: 20620 });
  });
  it.each([
    ["authentication_error", "Provider authentication failed. Check the configured credential."],
    ["invalid_model", "Configured model unavailable. Choose another model."],
    ["network_error", "Network error. Check the provider endpoint and connection."],
    ["invalid_plan", "The model returned an invalid plan. Try again or choose another model."],
    ["plan_parse_error", "The model response did not contain valid plan JSON. Try again or choose another model."],
    ["plan_response_empty", "The provider returned an empty Planner response. No plan was accepted. Try again or choose another model."],
    ["plan_response_truncated", "The provider stopped at its output limit before completing the plan. No plan was accepted. Narrow the requirement or choose another model."],
    ["permission_denied", "Permission denied."],
    ["validation_failed", "Validation failed."],
    ["review_failed", "Review failed."],
    ["aborted", "Workflow aborted."],
  ])("maps known %s errors for inline display", (code, expected) => {
    expect(friendlyErrorMessage({ code, message: "raw provider body" })).toBe(expected);
  });
  it("shows a bounded safe plan field without exposing a raw provider body", () => {
    expect(friendlyErrorMessage({ code: "invalid_plan", message: "Planner plan field tasks.0.description is invalid: Required" })).toBe("Planner plan field tasks.0.description is invalid: Required. The model returned an invalid plan. Try again or choose another model.");
  });
});
