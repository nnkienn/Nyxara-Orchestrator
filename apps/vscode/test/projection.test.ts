import { describe, expect, it } from "vitest";
import { taskStatusGlyph, workflowStage, safeErrorMessage, usageSummary } from "../src/projection.js";

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
});
