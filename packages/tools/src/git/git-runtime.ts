import { NyxaraToolError } from "../errors.js";
import type {
  CommandResult,
  ExecutionRuntime,
} from "../execution/execution.types.js";

export async function runGit(
  runtime: ExecutionRuntime,
  workspaceRoot: string,
  args: readonly string[],
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result = await runtime.run({
    command: "git",
    args,
    cwd: workspaceRoot,
    timeoutMs: 15_000,
    maxOutputBytes,
    ...(signal ? { signal } : {}),
  });

  if (result.timedOut) {
    throw new NyxaraToolError("git_error", "Git command timed out");
  }

  return result;
}

export function isNotGitRepository(result: CommandResult): boolean {
  return (
    result.exitCode !== 0 &&
    result.stderr.toLocaleLowerCase().includes("not a git repository")
  );
}

