export interface ListDirectoryInput {
  readonly path?: string;
  readonly depth?: number;
}

export interface DirectoryEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly size?: number;
}

export interface ListDirectoryResult {
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly ignoredDirectories: readonly string[];
}

export interface SearchFilesInput {
  readonly query: string;
  readonly maxResults?: number;
}

export interface SearchFilesResult {
  readonly matches: readonly string[];
  readonly truncated: boolean;
}

export interface SearchCodeInput {
  readonly query: string;
  readonly maxResults?: number;
  readonly maxFileBytes?: number;
}

export interface CodeSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export interface SearchCodeResult {
  readonly matches: readonly CodeSearchMatch[];
  readonly truncated: boolean;
}

export interface ReadFileInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxBytes?: number;
}

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly lineCount: number;
  readonly truncated: boolean;
}

export interface RepositoryToolOptions {
  readonly ignoredDirectories?: readonly string[];
}

