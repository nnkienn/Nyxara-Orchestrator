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

/**
 * Optional retrieval focus supplied by the pre-planning context policy. It
 * narrows what ContextEngine considers; ranking, bounding, and truncation
 * remain ContextEngine's responsibility.
 */
export interface ContextFocus {
  /** Paths the request named explicitly, or a cheap active-file anchor. */
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  /**
   * True when retrieval must stay inside the focus set. Unrelated files are then
   * left out even when budget remains available.
   */
  readonly exclusive?: boolean;
}

export interface BuildContextInput {
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly budget?: Partial<ContextBudget>;
  readonly focus?: ContextFocus;
  readonly signal?: AbortSignal;
}

export interface ExpandContextInput {
  readonly workspaceRoot: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly budget?: Partial<ContextBudget>;
  readonly signal?: AbortSignal;
}

export interface ExpandedContext {
  readonly files: readonly ContextFile[];
  readonly totalBytes: number;
  readonly truncated: boolean;
}
