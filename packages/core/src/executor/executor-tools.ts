import type {
  ModelToolCall,
  ModelToolDefinition,
  ModelToolResult,
} from "@nyxara/provider-sdk";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_ARGUMENT_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
} from "@nyxara/tools";
import { z } from "zod";
import {
  DEFAULT_EXECUTOR_LIMITS,
  type ResolvedExecutorLimits,
} from "./executor-limits.js";

export interface ValidatedExecutorToolCall {
  readonly call: ModelToolCall;
  readonly invalidResult?: ModelToolResult;
}

export function createExecutorToolDefinitions(
  limits: ResolvedExecutorLimits,
): readonly ModelToolDefinition[] {
  return [
    {
      name: "run_command",
      description: `Run a task command in the workspace root with separate arguments, no shell, and Core permission checks. Defaults: 30-second timeout and bounded output. Set timeoutMs explicitly for longer scripts. Executable plus arguments must fit ${MAX_COMMAND_ARGUMENT_BYTES / 1024} KiB. Use script paths relative to the workspace root; no cwd override.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1 },
          args: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "integer", minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS },
          maxOutputBytes: { type: "integer", minimum: 1, maximum: Math.min(MAX_COMMAND_OUTPUT_BYTES, limits.maxToolResultBytes) },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "list_directory",
      description: "List bounded entries beneath a workspace directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          depth: { type: "integer", minimum: 0, maximum: limits.maxDirectoryDepth },
        },
        additionalProperties: false,
      },
    },
    {
      name: "search_files",
      description: "Search workspace file paths by a text query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          maxResults: { type: "integer", minimum: 1, maximum: limits.maxSearchResults },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "search_code",
      description: "Search workspace file contents and return bounded line matches.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          maxResults: { type: "integer", minimum: 1, maximum: limits.maxSearchResults },
          maxFileBytes: { type: "integer", minimum: 1, maximum: limits.maxSearchFileBytes },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description: "Read a bounded range from one workspace file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          maxBytes: { type: "integer", minimum: 1, maximum: limits.maxToolResultBytes },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description: "Create a text file or atomically replace a complete text file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "apply_patch",
      description: "Apply a bounded unified text patch atomically after validation.",
      inputSchema: {
        type: "object",
        properties: { patch: { type: "string", minLength: 1 } },
        required: ["patch"],
        additionalProperties: false,
      },
    },
    {
      name: "git_status",
      description: "Inspect normalized Git workspace status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "git_diff",
      description: "Inspect a bounded working-tree Git diff.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          maxBytes: { type: "integer", minimum: 1, maximum: limits.maxToolResultBytes },
        },
        additionalProperties: false,
      },
    },
  ] as const;
}

export const EXECUTOR_TOOL_DEFINITIONS = createExecutorToolDefinitions(DEFAULT_EXECUTOR_LIMITS);
export const EXECUTOR_TOOL_NAMES = new Set(EXECUTOR_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * Validates at the Executor boundary, before permission evaluation or tool
 * execution. Defaults are added only when a field is absent; malformed or
 * oversized values are never silently replaced or clamped.
 */
export function validateExecutorToolCall(
  call: ModelToolCall,
  limits: ResolvedExecutorLimits,
): ValidatedExecutorToolCall {
  if (typeof call.id !== "string" || call.id.trim().length === 0) {
    return invalid(call, "Executor tool-call ID must be a non-empty string");
  }
  if (typeof call.name !== "string" || !EXECUTOR_TOOL_NAMES.has(call.name)) {
    return invalid(call, "Executor requested a tool that is not allowed");
  }
  if (!isRecord(call.arguments)) {
    return invalid(call, `Executor tool arguments must be an object: ${call.name}`);
  }
  let serializedArguments: string;
  try {
    serializedArguments = JSON.stringify(call.arguments);
  } catch {
    return invalid(call, `Executor tool arguments must be JSON-serializable: ${call.name}`);
  }
  if (Buffer.byteLength(serializedArguments, "utf8") > limits.maxToolArgumentBytes) {
    return invalid(call, `Executor tool arguments exceed the configured byte bound: ${call.name}`);
  }

  const parsed = argumentSchema(call.name, limits).safeParse(call.arguments);
  if (!parsed.success) {
    return invalid(call, `Executor tool arguments do not match the ${call.name} contract`);
  }
  return { call: { ...call, arguments: withBoundedDefaults(call.name, parsed.data, limits) } };
}

function argumentSchema(name: string, limits: ResolvedExecutorLimits): z.ZodType<Record<string, unknown>> {
  const positiveInteger = (maximum: number) => z.number().int().positive().max(maximum);
  const path = z.string().trim().min(1);
  switch (name) {
    case "run_command":
      return z.object({
        command: z.string().trim().min(1).refine((value) => !value.includes("\0")),
        args: z.array(z.string().refine((value) => !value.includes("\0"))).optional(),
        timeoutMs: positiveInteger(MAX_COMMAND_TIMEOUT_MS).optional(),
        maxOutputBytes: positiveInteger(Math.min(MAX_COMMAND_OUTPUT_BYTES, limits.maxToolResultBytes)).optional(),
      }).strict().superRefine((value, context) => {
        if (Buffer.byteLength(JSON.stringify([value.command, value.args ?? []]), "utf8") > MAX_COMMAND_ARGUMENT_BYTES) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `command and arguments exceed ${MAX_COMMAND_ARGUMENT_BYTES / 1024} KiB` });
        }
      });
    case "list_directory":
      return z.object({ path: path.optional(), depth: z.number().int().min(0).max(limits.maxDirectoryDepth).optional() }).strict();
    case "search_files":
      return z.object({ query: z.string().trim().min(1), maxResults: positiveInteger(limits.maxSearchResults).optional() }).strict();
    case "search_code":
      return z.object({
        query: z.string().trim().min(1),
        maxResults: positiveInteger(limits.maxSearchResults).optional(),
        maxFileBytes: positiveInteger(limits.maxSearchFileBytes).optional(),
      }).strict();
    case "read_file":
      return z.object({
        path,
        startLine: positiveInteger(Number.MAX_SAFE_INTEGER).optional(),
        endLine: positiveInteger(Number.MAX_SAFE_INTEGER).optional(),
        maxBytes: positiveInteger(limits.maxToolResultBytes).optional(),
      }).strict().refine((value) => value.endLine === undefined || value.endLine >= (value.startLine ?? 1), {
        message: "endLine must not precede startLine",
      });
    case "write_file":
      return z.object({ path, content: z.string() }).strict();
    case "apply_patch":
      return z.object({ patch: z.string().min(1) }).strict();
    case "git_status":
      return z.object({}).strict();
    case "git_diff":
      return z.object({ path: path.optional(), maxBytes: positiveInteger(limits.maxToolResultBytes).optional() }).strict();
    default:
      return z.object({}).strict();
  }
}

function withBoundedDefaults(
  name: string,
  args: Record<string, unknown>,
  limits: ResolvedExecutorLimits,
): Record<string, unknown> {
  switch (name) {
    case "search_code":
      return { ...args, maxResults: args.maxResults ?? limits.maxSearchResults, maxFileBytes: args.maxFileBytes ?? limits.maxSearchFileBytes };
    case "search_files":
      return { ...args, maxResults: args.maxResults ?? limits.maxSearchResults };
    case "read_file":
    case "git_diff":
      return { ...args, maxBytes: args.maxBytes ?? limits.maxToolResultBytes };
    case "run_command":
      return { ...args, maxOutputBytes: args.maxOutputBytes ?? limits.maxToolResultBytes };
    default:
      return args;
  }
}

function invalid(call: ModelToolCall, message: string): ValidatedExecutorToolCall {
  const callId = typeof call.id === "string" && call.id ? call.id : "invalid-tool-call";
  const name = typeof call.name === "string" && call.name ? call.name : "invalid_tool";
  return {
    // The provider receives the structured error below. Do not replay rejected
    // raw arguments (which may be malformed or oversized) in the next round.
    call: { id: callId, name, arguments: { rejected: true } },
    invalidResult: {
      callId,
      name,
      error: { code: "invalid_tool_arguments", message },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
