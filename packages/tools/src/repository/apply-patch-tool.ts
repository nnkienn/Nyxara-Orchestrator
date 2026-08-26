import type { ExecutionRuntime } from "../execution/execution.types.js";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import { inspectWriteTarget } from "./write-safety.js";

export interface ApplyPatchInput {
  readonly patch: string;
}

export interface ApplyPatchResult {
  readonly applied: boolean;
  readonly filesChanged: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

export interface ApplyPatchToolOptions {
  readonly maxBytes?: number;
  readonly largePatchBytes?: number;
}

interface ParsedPatch {
  readonly paths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly bytes: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_LARGE_PATCH_BYTES = 64 * 1024;

export class ApplyPatchTool implements Tool<ApplyPatchInput, ApplyPatchResult> {
  readonly name = "apply_patch";
  private readonly maxBytes: number;
  private readonly largePatchBytes: number;

  constructor(
    private readonly runtime: ExecutionRuntime,
    options: ApplyPatchToolOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.largePatchBytes = options.largePatchBytes ?? DEFAULT_LARGE_PATCH_BYTES;
  }

  async permission(
    input: ApplyPatchInput,
    context: ToolContext,
  ): Promise<readonly PermissionRequest[]> {
    const parsed = this.parse(input);
    return Promise.all(
      parsed.paths.map(async (path) =>
        (
          await inspectWriteTarget(
            path,
            parsed.bytes,
            this.largePatchBytes,
            context,
          )
        ).permission,
      ),
    );
  }

  async execute(
    input: ApplyPatchInput,
    context: ToolContext,
  ): Promise<ApplyPatchResult> {
    const parsed = this.parse(input);
    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    for (const path of parsed.paths) {
      await resolver.resolve(path, { mustExist: false });
    }

    const request = {
      command: "git",
      args: ["apply", "--recount", "--whitespace=nowarn", "-"],
      cwd: resolver.root,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      stdin: input.patch,
      ...(context.signal ? { signal: context.signal } : {}),
    } as const;
    const checked = await this.runtime.run({
      ...request,
      args: ["apply", "--check", "--recount", "--whitespace=nowarn", "-"],
    });
    if (checked.exitCode !== 0 || checked.timedOut || checked.aborted) {
      throw new NyxaraToolError(
        "patch_failed",
        "Patch validation failed; no changes were applied",
        this.name,
      );
    }

    const applied = await this.runtime.run(request);
    if (applied.exitCode !== 0 || applied.timedOut || applied.aborted) {
      throw new NyxaraToolError(
        "patch_failed",
        "Patch application failed",
        this.name,
      );
    }

    return {
      applied: true,
      filesChanged: parsed.paths,
      additions: parsed.additions,
      deletions: parsed.deletions,
    };
  }

  private parse(input: ApplyPatchInput): ParsedPatch {
    if (typeof input.patch !== "string" || input.patch.trim().length === 0) {
      throw new NyxaraToolError("patch_failed", "Patch text is required", this.name);
    }
    const bytes = Buffer.byteLength(input.patch, "utf8");
    if (bytes > this.maxBytes) {
      throw new NyxaraToolError(
        "file_too_large",
        "Patch exceeds the configured size limit",
        this.name,
      );
    }

    const paths = new Set<string>();
    if (
      /^(?:rename from|rename to|deleted file mode|GIT binary patch|Binary files )/m.test(
        input.patch,
      )
    ) {
      throw new NyxaraToolError(
        "patch_failed",
        "Delete, rename, and binary patches are not supported",
        this.name,
      );
    }

    const diffPaths = new Set<string>();
    for (const match of input.patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
      if (match[1] !== match[2]) {
        throw new NyxaraToolError(
          "patch_failed",
          "File rename patches are not supported",
          this.name,
        );
      }
      diffPaths.add(match[2]!);
    }
    if (/^diff --git /m.test(input.patch) && diffPaths.size === 0) {
      throw new NyxaraToolError(
        "patch_failed",
        "Quoted or ambiguous patch paths are not supported",
        this.name,
      );
    }

    const headerPattern = /^--- (.+)\r?\n\+\+\+ (.+)$/gm;
    for (const match of input.patch.matchAll(headerPattern)) {
      const oldPath = normalizePatchPath(match[1]!);
      const newPath = normalizePatchPath(match[2]!);
      if (newPath === null) {
        throw new NyxaraToolError(
          "patch_failed",
          "File deletion patches are not supported",
          this.name,
        );
      }
      if (oldPath !== null && oldPath !== newPath) {
        throw new NyxaraToolError(
          "patch_failed",
          "File rename patches are not supported",
          this.name,
        );
      }
      paths.add(newPath);
    }
    if (paths.size === 0) {
      throw new NyxaraToolError(
        "patch_failed",
        "Patch contains no supported file changes",
        this.name,
      );
    }
    for (const path of diffPaths) {
      if (!paths.has(path)) {
        throw new NyxaraToolError(
          "patch_failed",
          "Patch path metadata is inconsistent",
          this.name,
        );
      }
    }

    let additions = 0;
    let deletions = 0;
    for (const line of input.patch.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    return { paths: [...paths], additions, deletions, bytes };
  }
}

function normalizePatchPath(header: string): string | null {
  const rawPath = header.split("\t", 1)[0]!.trim();
  if (rawPath === "/dev/null") return null;
  if (rawPath.startsWith('"') || rawPath.length === 0) {
    throw new NyxaraToolError(
      "patch_failed",
      "Quoted or empty patch paths are not supported",
      "apply_patch",
    );
  }
  return rawPath.startsWith("a/") || rawPath.startsWith("b/")
    ? rawPath.slice(2)
    : rawPath;
}
