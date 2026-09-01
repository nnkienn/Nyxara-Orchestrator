import { describe, expect, it } from "vitest";
import { taskStatusGlyph, workflowStage, safeErrorMessage } from "../src/projection.js";

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
});
