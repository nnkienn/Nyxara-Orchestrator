import type { ModelToolCall, ModelToolResult } from "@nyxara/provider-sdk";
import { describe, expect, it } from "vitest";
import type { ContextBundle } from "../src/context/context.types.js";
import { resolveExecutorLimits } from "../src/executor/executor-limits.js";
import { ExecutorSession } from "../src/executor/executor-session.js";

describe("Executor evidence progress identity", () => {
  it("allows evidence to become current again after context compaction removes it", () => {
    const context: ContextBundle = {
      ...emptyContext(),
      files: [{ path: "src/a.ts", content: "same", reason: "initial", size: 4, truncated: false }],
      totalBytes: 4,
    };
    const state = new ExecutorSession(context, resolveExecutorLimits(undefined));
    const whilePresent = state.prepareBatch([read("present", 1, 10)])[0]!;
    expect(whilePresent.duplicateResult).toMatchObject({
      result: { reason: "file_already_present_in_current_context" },
    });

    state.setCurrentContext(emptyContext());
    expect(record(state, read("after-compaction", 1, 10), readResult("after-compaction", "same"))).toBe(true);
  });

  it("treats the same read range and unchanged content as no progress", () => {
    const state = session();
    expect(record(state, read("read-1", 1, 10), readResult("read-1", "same"))).toBe(true);
    advanceRevision(state, "revision-1");
    expect(record(state, read("read-2", 1, 10), readResult("read-2", "same"))).toBe(false);
  });

  it("treats a different unread range as progress even when the text repeats", () => {
    const state = session();
    expect(record(state, read("read-1", 1, 10), readResult("read-1", "repeated"))).toBe(true);
    expect(record(state, read("read-2", 11, 20), readResult("read-2", "repeated"))).toBe(true);
  });

  it("treats the same search scope and same results as no progress", () => {
    const state = session();
    const first = searchCode("search-1", 10);
    expect(record(state, first, searchCodeResult("search-1", [match("src/a.ts", 3), match("src/b.ts", 8)]))).toBe(true);
    advanceRevision(state, "revision-1");
    expect(record(state, searchCode("search-2", 10), searchCodeResult("search-2", [match("src/b.ts", 8), match("src/a.ts", 3)]))).toBe(false);
  });

  it("treats a changed search result and a different search scope as progress", () => {
    const state = session();
    expect(record(state, searchCode("search-1", 10), searchCodeResult("search-1", [match("src/a.ts", 3)]))).toBe(true);
    advanceRevision(state, "revision-1");
    expect(record(state, searchCode("search-2", 10), searchCodeResult("search-2", [match("src/a.ts", 3), match("src/b.ts", 8)]))).toBe(true);
    expect(record(state, searchCode("search-3", 20), searchCodeResult("search-3", [match("src/a.ts", 3), match("src/b.ts", 8)]))).toBe(true);
  });

  it("treats a newly discovered file as progress", () => {
    const state = session();
    expect(record(state, searchFiles("files-1"), searchFilesResult("files-1", ["src/a.ts"]))).toBe(true);
    advanceRevision(state, "revision-1");
    expect(record(state, searchFiles("files-2"), searchFilesResult("files-2", ["src/a.ts", "src/dependency.ts"]))).toBe(true);
  });

  it("treats successful writes and patches as progress", () => {
    const state = session();
    expect(record(state, {
      id: "write",
      name: "write_file",
      arguments: { path: "src/new.ts", content: "export const value = true;\n" },
    }, toolResult("write", "write_file", { path: "src/new.ts", created: true, bytesWritten: 27 }))).toBe(true);
    expect(record(state, {
      id: "patch",
      name: "apply_patch",
      arguments: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" },
    }, toolResult("patch", "apply_patch", { applied: true, filesChanged: ["src/a.ts"], additions: 1, deletions: 1 }))).toBe(true);
  });

  it("uses stable command output so only a changed validation result is progress", () => {
    const state = session();
    expect(record(state, validation("validation-1"), commandResult("validation-1", "ok", 1))).toBe(true);
    advanceRevision(state, "revision-1");
    expect(record(state, validation("validation-2"), commandResult("validation-2", "ok", 999))).toBe(false);
    advanceRevision(state, "revision-2");
    expect(record(state, validation("validation-3"), commandResult("validation-3", "new result", 5))).toBe(true);
  });

  it("records the first empty search but still stalls a real repeated loop", () => {
    const state = session({ maxConsecutiveNoProgressToolCalls: 2, maxNoProgressModelTurns: 2 });
    const first = record(state, searchFiles("empty-1"), searchFilesResult("empty-1", []));
    expect(first).toBe(true);
    state.finishToolRound(first);

    const second = record(state, searchFiles("empty-2"), searchFilesResult("empty-2", []));
    expect(second).toBe(false);
    state.finishToolRound(second);

    const third = record(state, searchFiles("empty-3"), searchFilesResult("empty-3", []));
    expect(third).toBe(false);
    expect(() => state.finishToolRound(third)).toThrowError(expect.objectContaining({ code: "executor_stalled" }));
  });
});

function session(overrides: Parameters<typeof resolveExecutorLimits>[0] = {}): ExecutorSession {
  return new ExecutorSession(emptyContext(), resolveExecutorLimits(overrides));
}

function record(
  state: ExecutorSession,
  call: ModelToolCall,
  result: ModelToolResult,
  changedPaths: readonly string[] = [],
): boolean {
  const prepared = state.prepareBatch([call])[0]!;
  state.acceptRequest(prepared);
  if (prepared.invalidResult) {
    state.recordInvalid();
    return false;
  }
  if (prepared.duplicateResult) {
    state.recordDuplicate();
    return false;
  }
  return state.recordOutcome(prepared, result, changedPaths).progress;
}

function advanceRevision(state: ExecutorSession, id: string): void {
  const call: ModelToolCall = {
    id,
    name: "write_file",
    arguments: { path: `src/${id}.ts`, content: id },
  };
  const prepared = state.prepareBatch([call])[0]!;
  state.acceptRequest(prepared);
  state.recordOutcome(prepared, toolResult(id, "write_file", {
    path: `src/${id}.ts`,
    created: true,
    bytesWritten: id.length,
  }), [`src/${id}.ts`]);
}

function read(id: string, startLine: number, endLine: number): ModelToolCall {
  return { id, name: "read_file", arguments: { path: "src/a.ts", startLine, endLine } };
}

function readResult(id: string, content: string): ModelToolResult {
  return toolResult(id, "read_file", {
    path: "src/a.ts",
    content,
    size: content.length,
    lineCount: 20,
    truncated: false,
  });
}

function searchCode(id: string, maxResults: number): ModelToolCall {
  return { id, name: "search_code", arguments: { query: "Dependency", maxResults } };
}

function searchCodeResult(id: string, matches: readonly Record<string, unknown>[]): ModelToolResult {
  return toolResult(id, "search_code", { matches, truncated: false });
}

function match(path: string, line: number): Record<string, unknown> {
  return { path, line, preview: "dependency" };
}

function searchFiles(id: string): ModelToolCall {
  return { id, name: "search_files", arguments: { query: "dependency", maxResults: 10 } };
}

function searchFilesResult(id: string, matches: readonly string[]): ModelToolResult {
  return toolResult(id, "search_files", { matches, truncated: false });
}

function validation(id: string): ModelToolCall {
  return { id, name: "run_command", arguments: { command: "npm", args: ["test"] } };
}

function commandResult(id: string, stdout: string, durationMs: number): ModelToolResult {
  return toolResult(id, "run_command", {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs,
    timedOut: false,
    aborted: false,
    truncated: false,
  });
}

function toolResult(id: string, name: string, result: unknown): ModelToolResult {
  return { callId: id, name, result };
}

function emptyContext(): ContextBundle {
  return {
    workspaceRoot: "/workspace",
    prompt: "test",
    files: [],
    git: {
      status: { isRepository: true, branch: "main", files: [], truncated: false },
      diff: { isRepository: true, diff: "", files: [], truncated: false },
    },
    totalBytes: 0,
    estimatedTokens: 0,
    truncated: false,
  };
}
