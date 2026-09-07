import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import type {
  CommandResult,
  ExecutionRuntime,
} from "./execution.types.js";

export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

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
    validateCommandInput(input);
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
    validateCommandInput(input);
    if (context.signal?.aborted) {
      throw new NyxaraToolError("tool_error", "Command execution was aborted", this.name);
    }
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

function validateCommandInput(input: unknown): asserts input is RunCommandInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new NyxaraToolError("tool_error", "Command input must be an object", "run_command");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["command", "args", "timeoutMs", "maxOutputBytes"].includes(key)) ||
    typeof value.command !== "string" || !value.command.trim() || value.command.includes("\0") ||
    (value.args !== undefined && (!Array.isArray(value.args) || [...value.args].some((argument) => typeof argument !== "string" || argument.includes("\0")))) ||
    (value.timeoutMs !== undefined && !validLimit(value.timeoutMs, MAX_COMMAND_TIMEOUT_MS)) ||
    (value.maxOutputBytes !== undefined && !validLimit(value.maxOutputBytes, MAX_COMMAND_OUTPUT_BYTES)) ||
    Buffer.byteLength(JSON.stringify([value.command, value.args ?? []]), "utf8") > 16 * 1024
  ) {
    throw new NyxaraToolError("tool_error", "Invalid command, arguments, timeout, or output limit", "run_command");
  }
}

function validLimit(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}
