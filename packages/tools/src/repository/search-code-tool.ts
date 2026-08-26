import { readFile, stat } from "node:fs/promises";
import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import { ignoredDirectorySet, walkFiles } from "./repository-walker.js";
import type {
  CodeSearchMatch,
  RepositoryToolOptions,
  SearchCodeInput,
  SearchCodeResult,
} from "./repository.types.js";

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 1_000;

export class SearchCodeTool
  implements Tool<SearchCodeInput, SearchCodeResult>
{
  readonly name = "search_code";
  private readonly ignoredDirectories: ReadonlySet<string>;

  constructor(options: RepositoryToolOptions = {}) {
    this.ignoredDirectories = ignoredDirectorySet(options.ignoredDirectories);
  }

  permission(
    _input: SearchCodeInput,
    context: ToolContext,
  ): PermissionRequest {
    return {
      capability: "search_workspace",
      workspaceRoot: context.workspaceRoot,
      resource: ".",
    };
  }

  async execute(
    input: SearchCodeInput,
    context: ToolContext,
  ): Promise<SearchCodeResult> {
    const query = input.query.trim().toLocaleLowerCase();
    const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (
      query.length === 0 ||
      maxResults <= 0 ||
      maxResults > MAX_RESULTS ||
      maxFileBytes <= 0
    ) {
      throw new NyxaraToolError(
        "tool_error",
        "Code search requires a query and valid limits",
        this.name,
      );
    }

    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const matches: CodeSearchMatch[] = [];
    let truncated = false;

    outer: for await (const file of walkFiles(
      resolver.root,
      this.ignoredDirectories,
      context.signal,
    )) {
      const fileStats = await stat(file.absolutePath);
      if (fileStats.size > maxFileBytes) {
        continue;
      }

      const buffer = await readFile(file.absolutePath);
      if (buffer.includes(0)) {
        continue;
      }

      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.toLocaleLowerCase().includes(query)) {
          continue;
        }

        if (matches.length >= maxResults) {
          truncated = true;
          break outer;
        }
        matches.push({
          path: file.relativePath,
          line: index + 1,
          preview: line.trim().slice(0, 240),
        });
      }
    }

    return { matches, truncated };
  }
}

