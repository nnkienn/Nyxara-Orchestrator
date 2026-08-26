import type { GitDiffResult, GitStatusResult } from "@nyxara/tools";

export interface ContextBudget {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxBytesPerFile: number;
}

export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly reason: string;
  readonly size: number;
  readonly truncated: boolean;
}

export interface ContextBundle {
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly files: readonly ContextFile[];
  readonly git: {
    readonly status: GitStatusResult;
    readonly diff: GitDiffResult;
  };
  readonly totalBytes: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

export interface BuildContextInput {
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly budget?: Partial<ContextBudget>;
  readonly signal?: AbortSignal;
}

