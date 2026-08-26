import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { NyxaraToolError } from "../errors.js";

export const DEFAULT_IGNORED_DIRECTORIES = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);

export function ignoredDirectorySet(
  configured?: readonly string[],
): ReadonlySet<string> {
  return new Set(configured ?? DEFAULT_IGNORED_DIRECTORIES);
}

export async function* walkFiles(
  workspaceRoot: string,
  ignoredDirectories: ReadonlySet<string>,
  signal?: AbortSignal,
): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
  yield* walkDirectory(workspaceRoot, workspaceRoot, ignoredDirectories, signal);
}

async function* walkDirectory(
  workspaceRoot: string,
  directory: string,
  ignoredDirectories: ReadonlySet<string>,
  signal?: AbortSignal,
): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
  throwIfAborted(signal);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        yield* walkDirectory(
          workspaceRoot,
          absolutePath,
          ignoredDirectories,
          signal,
        );
      }
    } else if (entry.isFile()) {
      yield {
        absolutePath,
        relativePath: relative(workspaceRoot, absolutePath).split(sep).join("/"),
      };
    }
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NyxaraToolError("tool_error", "Tool execution was aborted");
  }
}
