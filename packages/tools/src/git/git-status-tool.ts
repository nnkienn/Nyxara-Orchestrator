import type { ExecutionRuntime } from "../execution/execution.types.js";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import { isNotGitRepository, runGit } from "./git-runtime.js";
import type {
  GitFileStatus,
  GitStatusFile,
  GitStatusResult,
} from "./git.types.js";

const MAX_STATUS_BYTES = 256 * 1024;

export class GitStatusTool implements Tool<Record<string, never>, GitStatusResult> {
  readonly name = "git_status";

  constructor(private readonly runtime: ExecutionRuntime) {}

  permission(
    _input: Record<string, never>,
    context: ToolContext,
  ): PermissionRequest {
    return { capability: "git_status", workspaceRoot: context.workspaceRoot };
  }

  async execute(
    _input: Record<string, never>,
    context: ToolContext,
  ): Promise<GitStatusResult> {
    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const result = await runGit(
      this.runtime,
      resolver.root,
      ["status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"],
      MAX_STATUS_BYTES,
      context.signal,
    );

    if (isNotGitRepository(result)) {
      return {
        isRepository: false,
        branch: null,
        files: [],
        truncated: false,
      };
    }
    if (result.exitCode !== 0 && !result.truncated) {
      throw new NyxaraToolError("git_error", "Git status failed", this.name);
    }

    return this.parseStatus(result.stdout, result.truncated);
  }

  private parseStatus(output: string, truncated: boolean): GitStatusResult {
    const records = output.split("\0").filter(Boolean);
    let branch: string | null = null;
    const files: GitStatusFile[] = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.startsWith("## ")) {
        const branchValue = record.slice(3).split("...")[0]!.split(" ")[0]!;
        branch = branchValue === "HEAD" ? null : branchValue;
        continue;
      }

      if (record.length < 4) {
        continue;
      }
      const indexStatus = record[0]!;
      const worktreeStatus = record[1]!;
      const path = record.slice(3);
      files.push({
        path,
        status: normalizeGitStatus(indexStatus, worktreeStatus),
        indexStatus,
        worktreeStatus,
      });

      if (indexStatus === "R" || indexStatus === "C") {
        index += 1;
      }
    }

    return { isRepository: true, branch, files, truncated };
  }
}

function normalizeGitStatus(index: string, worktree: string): GitFileStatus {
  const combined = `${index}${worktree}`;
  if (combined === "??") return "untracked";
  if (combined.includes("U") || ["AA", "DD"].includes(combined)) {
    return "conflicted";
  }
  if (combined.includes("R")) return "renamed";
  if (combined.includes("C")) return "copied";
  if (combined.includes("D")) return "deleted";
  if (combined.includes("A")) return "added";
  if (combined.includes("M")) return "modified";
  return "unknown";
}
