import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import {
  DEFAULT_IGNORED_DIRECTORIES,
  ignoredDirectorySet,
  throwIfAborted,
} from "./repository-walker.js";
import type {
  DirectoryEntry,
  ListDirectoryInput,
  ListDirectoryResult,
  RepositoryToolOptions,
} from "./repository.types.js";

const MAX_DEPTH = 10;

export class ListDirectoryTool
  implements Tool<ListDirectoryInput, ListDirectoryResult>
{
  readonly name = "list_directory";
  private readonly ignoredDirectories: ReadonlySet<string>;

  constructor(options: RepositoryToolOptions = {}) {
    this.ignoredDirectories = ignoredDirectorySet(options.ignoredDirectories);
  }

  permission(
    input: ListDirectoryInput,
    context: ToolContext,
  ): PermissionRequest {
    return {
      capability: "list_workspace_directory",
      workspaceRoot: context.workspaceRoot,
      resource: input.path ?? ".",
    };
  }

  async execute(
    input: ListDirectoryInput,
    context: ToolContext,
  ): Promise<ListDirectoryResult> {
    const depth = input.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
      throw new NyxaraToolError(
        "tool_error",
        `Directory depth must be between 0 and ${MAX_DEPTH}`,
        this.name,
      );
    }

    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const target = await resolver.resolve(input.path ?? ".");
    const targetStats = await stat(target.absolutePath);
    if (!targetStats.isDirectory()) {
      throw new NyxaraToolError(
        "tool_error",
        "Requested workspace path is not a directory",
        this.name,
      );
    }

    const entries: DirectoryEntry[] = [];
    await this.collectEntries(
      resolver.root,
      target.absolutePath,
      depth,
      1,
      entries,
      context.signal,
    );

    return {
      path: target.relativePath,
      entries,
      ignoredDirectories: [...this.ignoredDirectories],
    };
  }

  private async collectEntries(
    workspaceRoot: string,
    directory: string,
    maxDepth: number,
    currentDepth: number,
    output: DirectoryEntry[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (currentDepth > maxDepth) {
      return;
    }

    throwIfAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory() && this.ignoredDirectories.has(entry.name)) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      const normalizedPath = relative(workspaceRoot, absolutePath)
        .split(sep)
        .join("/");

      if (entry.isDirectory()) {
        output.push({ path: normalizedPath, type: "directory" });
        await this.collectEntries(
          workspaceRoot,
          absolutePath,
          maxDepth,
          currentDepth + 1,
          output,
          signal,
        );
      } else if (entry.isFile()) {
        const fileStats = await stat(absolutePath);
        output.push({ path: normalizedPath, type: "file", size: fileStats.size });
      } else if (entry.isSymbolicLink()) {
        output.push({ path: normalizedPath, type: "symlink" });
      }
    }
  }
}

export { DEFAULT_IGNORED_DIRECTORIES };

