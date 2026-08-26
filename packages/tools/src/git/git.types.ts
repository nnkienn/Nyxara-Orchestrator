export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "unknown";

export interface GitStatusFile {
  readonly path: string;
  readonly status: GitFileStatus;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}

export interface GitStatusResult {
  readonly isRepository: boolean;
  readonly branch: string | null;
  readonly files: readonly GitStatusFile[];
  readonly truncated: boolean;
}

export interface GitDiffInput {
  readonly path?: string;
  readonly maxBytes?: number;
}

export interface GitDiffResult {
  readonly isRepository: boolean;
  readonly diff: string;
  readonly files: readonly string[];
  readonly truncated: boolean;
}

