import type { ExecutionRuntime } from "../execution/execution.types.js";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import { isNotGitRepository, runGit } from "./git-runtime.js";
import type { GitDiffInput, GitDiffResult } from "./git.types.js";

const DEFAULT_MAX_DIFF_BYTES = 256 * 1024;
const HARD_MAX_DIFF_BYTES = 1024 * 1024;

export class GitDiffTool implements Tool<GitDiffInput, GitDiffResult> {
  readonly name = "git_diff";

  constructor(private readonly runtime: ExecutionRuntime) {}

  permission(input: GitDiffInput, context: ToolContext): PermissionRequest {
    return {
      capability: "git_diff",
      workspaceRoot: context.workspaceRoot,
      ...(input.path ? { resource: input.path } : {}),
    };
  }

  async execute(
    input: GitDiffInput,
    context: ToolContext,
  ): Promise<GitDiffResult> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
    if (maxBytes <= 0 || maxBytes > HARD_MAX_DIFF_BYTES) {
      throw new NyxaraToolError(
        "tool_error",
        "Git diff output limit is invalid",
        this.name,
      );
    }

    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const path = input.path
      ? (await resolver.resolve(input.path, { mustExist: false })).relativePath
      : undefined;
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (path) {
      args.push("--", path);
    }

    const result = await runGit(
      this.runtime,
      resolver.root,
      args,
      maxBytes,
      context.signal,
    );
    if (isNotGitRepository(result)) {
      return { isRepository: false, diff: "", files: [], truncated: false };
    }
    if (result.exitCode !== 0 && !result.truncated) {
      throw new NyxaraToolError("git_error", "Git diff failed", this.name);
    }

    const files = new Set<string>();
    for (const match of result.stdout.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
      if (match[2]) {
        files.add(match[2]);
      }
    }

    return {
      isRepository: true,
      diff: result.stdout,
      files: [...files],
      truncated: result.truncated,
    };
  }
}

