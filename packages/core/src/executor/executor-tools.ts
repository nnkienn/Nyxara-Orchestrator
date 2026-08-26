import type { ModelToolDefinition } from "@nyxara/provider-sdk";

export const EXECUTOR_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: "list_directory",
    description: "List bounded entries beneath a workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        depth: { type: "integer", minimum: 0, maximum: 4 },
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
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
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
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
        maxFileBytes: { type: "integer", minimum: 1, maximum: 1048576 },
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
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        maxBytes: { type: "integer", minimum: 1, maximum: 65536 },
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
        path: { type: "string" },
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
      properties: { patch: { type: "string" } },
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
        path: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, maximum: 262144 },
      },
      additionalProperties: false,
    },
  },
] as const;

export const EXECUTOR_TOOL_NAMES = new Set(
  EXECUTOR_TOOL_DEFINITIONS.map((tool) => tool.name),
);
