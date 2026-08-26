import { NyxaraToolError } from "../errors.js";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { Tool, ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";
import { ignoredDirectorySet, walkFiles } from "./repository-walker.js";
import type {
  RepositoryToolOptions,
  SearchFilesInput,
  SearchFilesResult,
} from "./repository.types.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 1_000;

export class SearchFilesTool
  implements Tool<SearchFilesInput, SearchFilesResult>
{
  readonly name = "search_files";
  private readonly ignoredDirectories: ReadonlySet<string>;

  constructor(options: RepositoryToolOptions = {}) {
    this.ignoredDirectories = ignoredDirectorySet(options.ignoredDirectories);
  }

  permission(
    _input: SearchFilesInput,
    context: ToolContext,
  ): PermissionRequest {
    return {
      capability: "search_workspace",
      workspaceRoot: context.workspaceRoot,
      resource: ".",
    };
  }

  async execute(
    input: SearchFilesInput,
    context: ToolContext,
  ): Promise<SearchFilesResult> {
    const query = input.query.trim().toLocaleLowerCase();
    const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
    if (query.length === 0 || maxResults <= 0 || maxResults > MAX_RESULTS) {
      throw new NyxaraToolError(
        "tool_error",
        "File search requires a query and a valid result limit",
        this.name,
      );
    }

    const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
    const matches: string[] = [];
    let truncated = false;

    for await (const file of walkFiles(
      resolver.root,
      this.ignoredDirectories,
      context.signal,
    )) {
      if (!file.relativePath.toLocaleLowerCase().includes(query)) {
        continue;
      }

      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      matches.push(file.relativePath);
    }

    return { matches, truncated };
  }
}

