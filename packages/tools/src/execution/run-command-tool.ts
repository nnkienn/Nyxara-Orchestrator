import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import type {
  CommandResult,
  ExecutionRuntime,
} from "./execution.types.js";

export interface RunCommandInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class RunCommandTool implements Tool<RunCommandInput, CommandResult> {
  readonly name = "run_command";

  constructor(private readonly runtime: ExecutionRuntime) {}

  permission(input: RunCommandInput, context: ToolContext): PermissionRequest {
    return {
      capability: "run_command",
      workspaceRoot: context.workspaceRoot,
      command: {
        command: input.command,
        cwd: context.workspaceRoot,
        ...(input.args ? { args: input.args } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined
          ? { maxOutputBytes: input.maxOutputBytes }
          : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      },
    };
  }

  async execute(
    input: RunCommandInput,
    context: ToolContext,
  ): Promise<CommandResult> {
    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const result = await this.runtime.run({
      command: input.command,
      ...(input.args ? { args: input.args } : {}),
      cwd: resolver.root,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined
        ? { maxOutputBytes: input.maxOutputBytes }
        : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    if (result.timedOut) {
      throw new NyxaraToolError(
        "command_timeout",
        "Command exceeded its time limit",
        this.name,
      );
    }
    if (result.aborted) {
      throw new NyxaraToolError(
        "tool_error",
        "Command execution was aborted",
        this.name,
      );
    }

    return result;
  }
}
