import type {
  ContextBundle,
  ExecutionResult,
  PlannedTask,
  ValidationResult,
} from "../../src/index.js";

export function task(): PlannedTask {
  return {
    id: "T1",
    title: "Add pagination",
    description: "Add page and limit handling",
    dependencies: [],
    acceptanceCriteria: ["Page is supported", "Limit is supported"],
    relevantFiles: ["src/notification.ts"],
  };
}

export function execution(replacement = "page: number"): ExecutionResult {
  const diff = [
    "diff --git a/src/notification.ts b/src/notification.ts",
    "--- a/src/notification.ts",
    "+++ b/src/notification.ts",
    "@@ -1 +1 @@",
    "-export const page = 0;",
    `+export const page = ${replacement};`,
    "diff --git a/src/unrelated.ts b/src/unrelated.ts",
    "--- a/src/unrelated.ts",
    "+++ b/src/unrelated.ts",
    "@@ -1 +1 @@",
    "-export const unrelated = false;",
    "+export const unrelated = true;",
    "",
  ].join("\n");
  return {
    taskId: "T1",
    status: "completed",
    summary: "Implemented pagination",
    changedFiles: ["src/notification.ts"],
    toolCalls: 1,
    modelTurns: 2,
    diff: { files: ["src/notification.ts"], truncated: false },
    git: {
      initialStatus: {
        isRepository: true,
        branch: "main",
        files: [],
        truncated: false,
      },
      finalStatus: {
        isRepository: true,
        branch: "main",
        files: [
          {
            path: "src/notification.ts",
            status: "modified",
            indexStatus: " ",
            worktreeStatus: "M",
          },
        ],
        truncated: false,
      },
      diff: {
        isRepository: true,
        diff,
        files: ["src/notification.ts", "src/unrelated.ts"],
        truncated: false,
      },
      initialDiffFiles: [],
    },
  };
}

export function validation(error = "Expected 4, received 3"): ValidationResult {
  return {
    status: "failed",
    packageManager: "pnpm",
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
    durationMs: 1000,
    taskId: "T1",
    steps: [
      {
        kind: "typecheck",
        status: "passed",
        required: true,
        source: "discovered",
        durationMs: 100,
        stdout: "large successful log should not be handed to Reviewer",
      },
      {
        kind: "test",
        status: "failed",
        required: true,
        source: "discovered",
        durationMs: 900,
        exitCode: 1,
        stderr: error,
      },
    ],
  };
}

export function passingValidation(): ValidationResult {
  return {
    ...validation(),
    status: "passed",
    steps: validation().steps.map((step) => ({
      ...step,
      status: "passed" as const,
      exitCode: 0,
      stderr: "",
    })),
  };
}

export function context(content: string, reason: string): ContextBundle {
  return {
    workspaceRoot: "/workspace",
    prompt: "pagination",
    files: [
      {
        path: "src/notification.ts",
        content,
        reason,
        size: Buffer.byteLength(content, "utf8"),
        truncated: false,
      },
    ],
    git: {
      status: {
        isRepository: true,
        branch: "main",
        files: [],
        truncated: false,
      },
      diff: { isRepository: true, diff: "", files: [], truncated: false },
    },
    totalBytes: Buffer.byteLength(content, "utf8"),
    estimatedTokens: 1,
    truncated: false,
  };
}
