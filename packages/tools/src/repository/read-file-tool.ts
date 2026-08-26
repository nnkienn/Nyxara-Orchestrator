import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import { throwIfAborted } from "./repository-walker.js";
import type { ReadFileInput, ReadFileResult } from "./repository.types.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;

export class ReadFileTool implements Tool<ReadFileInput, ReadFileResult> {
  readonly name = "read_file";

  permission(input: ReadFileInput, context: ToolContext): PermissionRequest {
    return {
      capability: "read_workspace_file",
      workspaceRoot: context.workspaceRoot,
      resource: input.path,
    };
  }

  async execute(
    input: ReadFileInput,
    context: ToolContext,
  ): Promise<ReadFileResult> {
    const startLine = input.startLine ?? 1;
    const endLine = input.endLine ?? Number.POSITIVE_INFINITY;
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    if (
      !Number.isInteger(startLine) ||
      startLine < 1 ||
      endLine < startLine ||
      maxBytes <= 0 ||
      maxBytes > HARD_MAX_BYTES
    ) {
      throw new NyxaraToolError(
        "tool_error",
        "File read limits are invalid",
        this.name,
      );
    }

    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const target = await resolver.resolve(input.path);
    const fileStats = await stat(target.absolutePath);
    if (!fileStats.isFile()) {
      throw new NyxaraToolError(
        "tool_error",
        "Requested workspace path is not a file",
        this.name,
      );
    }

    const stream = createReadStream(target.absolutePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const content: string[] = [];
    let contentBytes = 0;
    let lineCount = 0;
    let hitByteLimit = false;

    try {
      for await (const line of lines) {
        throwIfAborted(context.signal);
        lineCount += 1;
        if (lineCount < startLine || lineCount > endLine || hitByteLimit) {
          continue;
        }

        const separatorBytes = content.length > 0 ? 1 : 0;
        const lineBuffer = Buffer.from(line, "utf8");
        const remaining = maxBytes - contentBytes - separatorBytes;
        if (remaining <= 0) {
          hitByteLimit = true;
          continue;
        }

        if (content.length > 0) {
          contentBytes += 1;
        }
        if (lineBuffer.byteLength > remaining) {
          content.push(lineBuffer.subarray(0, remaining).toString("utf8"));
          contentBytes += remaining;
          hitByteLimit = true;
        } else {
          content.push(line);
          contentBytes += lineBuffer.byteLength;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }

    return {
      path: target.relativePath,
      content: content.join("\n"),
      size: fileStats.size,
      lineCount,
      truncated:
        hitByteLimit ||
        startLine > 1 ||
        (Number.isFinite(endLine) && endLine < lineCount),
    };
  }
}
