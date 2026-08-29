import type {
  ContextBundle,
  ExecutionResult,
  PlannedTask,
  ReviewResult,
  ValidationResult,
} from "../../src/index.js";

export function repairTask(): PlannedTask {
  return {
    id: "T1",
    title: "Add pagination metadata",
    description: "Return pagination metadata from the notification API",
    dependencies: [],
    acceptanceCriteria: ["Response exposes totalPages"],
    relevantFiles: ["src/notification.service.ts"],
  };
}

export function diffFor(files: readonly string[], marker: string): string {
  return files
    .map((file) =>
      [
        "diff --git a/" + file + " b/" + file,
        "--- a/" + file,
        "+++ b/" + file,
        "@@ -1 +1 @@",
        "-export const totalPages = 0;",
        "+export const totalPages = " + marker + ";",
        "",
      ].join("\n"),
    )
    .join("");
}

export function execution(
  overrides: {
    readonly changedFiles?: readonly string[];
    readonly marker?: string;
    readonly status?: "completed" | "failed";
  } = {},
): ExecutionResult {
  const changedFiles = overrides.changedFiles ?? ["src/notification.service.ts"];
  const diff = diffFor([...changedFiles, "src/unrelated.ts"], overrides.marker ?? "1");
  return {
    taskId: "T1",
    status: overrides.status ?? "completed",
    summary: "The model claims the repair is complete",
    changedFiles,
    toolCalls: 1,
    modelTurns: 2,
    diff: { files: [...changedFiles], truncated: false },
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
        files: changedFiles.map((path) => ({
          path,
          status: "modified" as const,
          indexStatus: " ",
          worktreeStatus: "M",
        })),
        truncated: false,
      },
      diff: {
        isRepository: true,
        diff,
        files: [...changedFiles, "src/unrelated.ts"],
        truncated: false,
      },
      initialDiffFiles: [],
    },
  };
}

export function failingValidation(
  stderr = "src/notification.service.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.",
): ValidationResult {
  return {
    status: "failed",
    packageManager: "pnpm",
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:02.000Z",
    durationMs: 2000,
    taskId: "T1",
    errorCode: "validation_failed",
    steps: [
      {
        kind: "typecheck",
        status: "failed",
        required: true,
        source: "discovered",
        durationMs: 1000,
        exitCode: 2,
        stderr,
        errorCode: "validation_failed",
      },
      {
        kind: "lint",
        status: "passed",
        required: true,
        source: "discovered",
        durationMs: 500,
        stdout: "large successful lint log must not reach the repair prompt",
      },
    ],
  };
}

export function passingValidation(): ValidationResult {
  return {
    status: "passed",
    packageManager: "pnpm",
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:02.000Z",
    durationMs: 2000,
    taskId: "T1",
    steps: [
      {
        kind: "typecheck",
        status: "passed",
        required: true,
        source: "discovered",
        durationMs: 100,
        exitCode: 0,
        stdout: "successful typecheck log",
      },
    ],
  };
}

export function failingReview(
  message = "totalPages is calculated incorrectly",
): ReviewResult {
  return {
    status: "failed",
    summary: "Pagination metadata is incorrect",
    findings: [
      {
        id: "F1",
        severity: "error",
        category: "correctness",
        message,
        file: "src/notification.service.ts",
        line: 42,
        taskId: "T1",
      },
      {
        id: "F2",
        severity: "info",
        category: "maintainability",
        message: "Consider extracting a helper",
      },
    ],
    criteria: [
      {
        criterion: "Response exposes totalPages",
        status: "unsatisfied",
        reason: "The calculation is wrong",
      },
    ],
    reviewedAt: "2026-08-29T00:00:03.000Z",
  };
}

export function passingReview(): ReviewResult {
  return {
    status: "passed",
    summary: "Pagination metadata is correct",
    findings: [],
    criteria: [
      {
        criterion: "Response exposes totalPages",
        status: "satisfied",
        reason: "totalPages is derived from total and limit",
      },
    ],
    reviewedAt: "2026-08-29T00:00:04.000Z",
  };
}

export function contextBundle(
  files: readonly { path: string; content: string }[] = [
    { path: "src/notification.service.ts", content: "export const totalPages = 0;" },
    { path: "src/unrelated.ts", content: "export const unrelated = true;" },
  ],
): ContextBundle {
  const contextFiles = files.map((file) => ({
    path: file.path,
    content: file.content,
    reason: "reused executor context",
    size: Buffer.byteLength(file.content, "utf8"),
    truncated: false,
  }));
  return {
    workspaceRoot: "/workspace",
    prompt: "pagination metadata",
    files: contextFiles,
    git: {
      status: { isRepository: true, branch: "main", files: [], truncated: false },
      diff: { isRepository: true, diff: "", files: [], truncated: false },
    },
    totalBytes: contextFiles.reduce((total, file) => total + file.size, 0),
    estimatedTokens: 12,
    truncated: false,
  };
}
