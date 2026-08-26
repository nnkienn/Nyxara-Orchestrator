import { describe, expect, it, vi } from "vitest";
import { NyxaraOrchestrator } from "../src/index.js";

describe("NyxaraOrchestrator", () => {
  it("executes the Phase 0 workflow", async () => {
    const nyxara = new NyxaraOrchestrator();

    const workflow = await nyxara.run({
      workspace: "/workspace",
      prompt: "hello",
    });

    expect(workflow.status).toBe("completed");
    expect(workflow.workspace).toBe("/workspace");
    expect(workflow.prompt).toBe("hello");
  });

  it("emits workflow.started and workflow.completed in lifecycle order", async () => {
    const nyxara = new NyxaraOrchestrator();
    const lifecycle: string[] = [];

    nyxara.events.on("workflow.started", ({ workflow }) => {
      lifecycle.push(workflow.status);
    });
    nyxara.events.on("workflow.completed", ({ workflow }) => {
      lifecycle.push(workflow.status);
    });

    await nyxara.run({ workspace: "/workspace", prompt: "hello" });

    expect(lifecycle).toEqual(["analyzing", "completed"]);
  });

  it("emits workflow.failed when input validation fails", async () => {
    const nyxara = new NyxaraOrchestrator();
    const onFailed = vi.fn();

    nyxara.events.on("workflow.failed", onFailed);

    await expect(
      nyxara.run({ workspace: "/workspace", prompt: "" }),
    ).rejects.toThrow("prompt is required");
    expect(onFailed).toHaveBeenCalledOnce();
  });
});

