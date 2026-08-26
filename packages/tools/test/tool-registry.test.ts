import { describe, expect, it, vi } from "vitest";
import {
  DefaultPermissionEngine,
  ToolRegistry,
  type Tool,
} from "../src/index.js";

const fakeTool: Tool<{ value: string }, string> = {
  name: "fake",
  permission(_input, context) {
    return {
      capability: "read_workspace_file",
      workspaceRoot: context.workspaceRoot,
      resource: "file.ts",
    };
  },
  async execute(input) {
    return input.value;
  },
};

describe("ToolRegistry", () => {
  it("registers, retrieves, lists, and executes a tool", async () => {
    const registry = new ToolRegistry(new DefaultPermissionEngine());
    registry.register(fakeTool);

    expect(registry.get("fake")).toBe(fakeTool);
    expect(registry.list()).toEqual(["fake"]);
    await expect(
      registry.execute<{ value: string }, string>(
        "fake",
        { value: "result" },
        { workspaceRoot: process.cwd() },
      ),
    ).resolves.toBe("result");
  });

  it("rejects duplicate and unknown tools with controlled errors", () => {
    const registry = new ToolRegistry(new DefaultPermissionEngine());
    registry.register(fakeTool);

    expect(() => registry.register(fakeTool)).toThrowError(
      expect.objectContaining({ code: "duplicate_tool" }),
    );
    expect(() => registry.get("missing")).toThrowError(
      expect.objectContaining({ code: "unknown_tool" }),
    );
  });

  it("enforces permission before executing a tool", async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry({ evaluate: async () => "deny" });
    registry.register({ ...fakeTool, execute });

    await expect(
      registry.execute("fake", { value: "blocked" }, { workspaceRoot: "/tmp" }),
    ).rejects.toMatchObject({ code: "permission_error" });
    expect(execute).not.toHaveBeenCalled();
  });
});

