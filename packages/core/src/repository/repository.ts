import type {
  GitDiffResult,
  GitStatusResult,
  ReadFileResult,
  SearchCodeResult,
  SearchFilesResult,
  ToolContext,
  ToolRegistry,
} from "@nyxara/tools";

export class Repository {
  constructor(
    readonly workspaceRoot: string,
    private readonly tools: ToolRegistry,
    private readonly signal?: AbortSignal,
  ) {}

  searchFiles(query: string, maxResults: number): Promise<SearchFilesResult> {
    return this.tools.execute(
      "search_files",
      { query, maxResults },
      this.context(),
    );
  }

  searchCode(query: string, maxResults: number): Promise<SearchCodeResult> {
    return this.tools.execute(
      "search_code",
      { query, maxResults },
      this.context(),
    );
  }

  readFile(path: string, maxBytes: number): Promise<ReadFileResult> {
    return this.tools.execute(
      "read_file",
      { path, maxBytes },
      this.context(),
    );
  }

  gitStatus(): Promise<GitStatusResult> {
    return this.tools.execute("git_status", {}, this.context());
  }

  gitDiff(maxBytes: number): Promise<GitDiffResult> {
    return this.tools.execute("git_diff", { maxBytes }, this.context());
  }

  private context(): ToolContext {
    return {
      workspaceRoot: this.workspaceRoot,
      ...(this.signal ? { signal: this.signal } : {}),
    };
  }
}

