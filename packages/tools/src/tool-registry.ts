import {
  NyxaraToolError,
  ToolRegistryError,
} from "./errors.js";
import type { PermissionEngine } from "./permissions/permission.types.js";
import type {
  Tool,
  ToolContext,
  ToolEventObserver,
} from "./tool.types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  constructor(
    private readonly permissionEngine: PermissionEngine,
    private readonly observer?: ToolEventObserver,
  ) {}

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(
        "duplicate_tool",
        tool.name,
        `Tool already registered: ${tool.name}`,
      );
    }

    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
  }

  get<TInput = unknown, TOutput = unknown>(name: string): Tool<TInput, TOutput> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new ToolRegistryError(
        "unknown_tool",
        name,
        `Tool is not registered: ${name}`,
      );
    }

    return tool as Tool<TInput, TOutput>;
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  async execute<TInput, TOutput>(
    name: string,
    input: TInput,
    context: ToolContext,
  ): Promise<TOutput> {
    const tool = this.get<TInput, TOutput>(name);
    const permission = tool.permission(input, context);
    this.observer?.({
      type: "permission.requested",
      tool: name,
      capability: permission.capability,
      ...(permission.resource ? { resource: permission.resource } : {}),
      ...(permission.command ? { command: permission.command.command } : {}),
    });

    const decision = await this.permissionEngine.evaluate(permission);
    if (decision !== "allow") {
      this.observer?.({
        type: "permission.denied",
        tool: name,
        capability: permission.capability,
      });
      const code =
        decision === "ask"
          ? "permission_required"
          : permission.capability === "run_command"
            ? "command_blocked"
            : "permission_error";
      const error = new NyxaraToolError(
        code,
        decision === "ask"
          ? `Permission is required to execute tool: ${name}`
          : `Permission denied for tool: ${name}`,
        name,
      );
      this.observer?.({ type: "tool.failed", tool: name, code: error.code });
      throw error;
    }

    this.observer?.({
      type: "permission.allowed",
      tool: name,
      capability: permission.capability,
    });
    this.observer?.({ type: "tool.started", tool: name });
    const startedAt = Date.now();

    try {
      const output = await tool.execute(input, context);
      this.observer?.({
        type: "tool.completed",
        tool: name,
        durationMs: Date.now() - startedAt,
      });
      return output;
    } catch (error: unknown) {
      this.observer?.({
        type: "tool.failed",
        tool: name,
        code: error instanceof NyxaraToolError ? error.code : "tool_error",
      });
      throw error;
    }
  }
}
