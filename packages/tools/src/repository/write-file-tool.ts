import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { inspectWriteTarget } from "./write-safety.js";

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
}

export interface WriteFileResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytesWritten: number;
}

export interface WriteFileToolOptions {
  readonly maxBytes?: number;
  readonly largeWriteBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_LARGE_WRITE_BYTES = 64 * 1024;

export class WriteFileTool implements Tool<WriteFileInput, WriteFileResult> {
  readonly name = "write_file";
  private readonly maxBytes: number;
  private readonly largeWriteBytes: number;

  constructor(options: WriteFileToolOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.largeWriteBytes = options.largeWriteBytes ?? DEFAULT_LARGE_WRITE_BYTES;
  }

  async permission(
    input: WriteFileInput,
    context: ToolContext,
  ): Promise<PermissionRequest> {
    const bytes = this.validateInput(input);
    return (
      await inspectWriteTarget(input.path, bytes, this.largeWriteBytes, context)
    ).permission;
  }

  async execute(
    input: WriteFileInput,
    context: ToolContext,
  ): Promise<WriteFileResult> {
    const bytes = this.validateInput(input);
    const target = await inspectWriteTarget(
      input.path,
      bytes,
      this.largeWriteBytes,
      context,
    );
    await mkdir(dirname(target.absolutePath), { recursive: true });

    let mode: number | undefined;
    if (target.exists) {
      try {
        mode = (await stat(target.absolutePath)).mode;
      } catch {
        throw new NyxaraToolError(
          "tool_error",
          "Write target changed during execution",
          this.name,
        );
      }
    }

    const temporaryPath = join(
      dirname(target.absolutePath),
      `.nyxara-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, input.content, { flag: "wx" });
      if (mode !== undefined) {
        await chmod(temporaryPath, mode);
      }
      await rename(temporaryPath, target.absolutePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return {
      path: target.relativePath,
      created: !target.exists,
      bytesWritten: bytes,
    };
  }

  private validateInput(input: WriteFileInput): number {
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      throw new NyxaraToolError("tool_error", "Write path is required", this.name);
    }
    if (typeof input.content !== "string") {
      throw new NyxaraToolError(
        "tool_error",
        "Write content must be text",
        this.name,
      );
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > this.maxBytes) {
      throw new NyxaraToolError(
        "file_too_large",
        "Write content exceeds the configured size limit",
        this.name,
      );
    }
    return bytes;
  }
}
