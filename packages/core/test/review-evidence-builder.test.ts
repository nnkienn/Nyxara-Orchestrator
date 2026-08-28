import { describe, expect, it } from "vitest";
import {
  ReviewEvidenceBuilder,
  type ContextBundle,
  type ExecutionResult,
  type PlannedTask,
  type ValidationResult,
} from "../src/index.js";

describe("ReviewEvidenceBuilder", () => {
  it("builds current-task evidence, filters diff, summarizes validation, and deduplicates context", () => {
    const evidence = new ReviewEvidenceBuilder().build({
      requirement: "Add pagination to notifications",
      objective: "Paginate notification results",
      task: task(),
      execution: execution(),
      validation: validation(),
      contexts: [
        context("executor version", "task-specific context"),
        context("duplicate planner version", "planner context"),
      ],
    });

    expect(evidence.requirement).toBe("Add pagination to notifications");
    expect(evidence.task.id).toBe("T1");
    expect(evidence.acceptanceCriteria).toEqual(task().acceptanceCriteria);
    expect(evidence.changedFiles).toEqual(["src/notification.ts"]);
    expect(evidence.diff.content).toContain("page: number");
    expect(evidence.diff.content).not.toContain("unrelated = true");
    expect(evidence.diff).toMatchObject({ additions: 1, deletions: 1 });
    expect(evidence.validation.steps[0]).not.toHaveProperty("errorExcerpt");
    expect(evidence.validation.steps[1]).toMatchObject({
      kind: "test",
      status: "failed",
      errorExcerpt: expect.stringContaining("Expected 4"),
    });
    expect(evidence.context).toHaveLength(1);
    expect(evidence.context[0]).toMatchObject({
      path: "src/notification.ts",
      content: "executor version",
      reason: "task-specific context",
    });
  });

  it("enforces UTF-8 diff, validation, and context budgets with truncation metadata", () => {
    const largeExecution = execution("😀".repeat(500));
    const failedValidation = validation("failure ".repeat(500));
    const evidence = new ReviewEvidenceBuilder().build({
      requirement: "Review bounded evidence",
      objective: "Keep evidence small",
      task: task(),
      execution: largeExecution,
      validation: failedValidation,
      contexts: [
        context("a".repeat(200), "first"),
        {
          ...context("b".repeat(200), "second"),
          files: [
            {
              path: "src/second.ts",
              content: "b".repeat(200),
              reason: "second",
              size: 200,
              truncated: false,
            },
          ],
        },
      ],
      budget: {
        maxDiffBytes: 64,
        maxValidationBytes: 48,
        maxContextFiles: 1,
        maxContextBytes: 32,
        maxBytesPerContextFile: 32,
      },
    });

    expect(Buffer.byteLength(evidence.diff.content, "utf8")).toBeLessThanOrEqual(64);
    expect(evidence.diff.truncated).toBe(true);
    expect(
      Buffer.byteLength(evidence.validation.steps[1]?.errorExcerpt ?? "", "utf8"),
    ).toBeLessThanOrEqual(48);
    expect(evidence.validation.truncated).toBe(true);
    expect(evidence.context).toHaveLength(1);
    expect(Buffer.byteLength(evidence.context[0]!.content, "utf8")).toBe(32);
    expect(evidence.truncated).toBe(true);
  });

  it("rejects mismatched task evidence and excessive budgets", () => {
    const builder = new ReviewEvidenceBuilder();
    expect(() =>
      builder.build({
        requirement: "Review",
        objective: "Review",
        task: task(),
        execution: { ...execution(), taskId: "T2" },
        validation: validation(),
        contexts: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_review" }));
    expect(() =>
      builder.build({
        requirement: "Review",
        objective: "Review",
        task: task(),
        execution: execution(),
        validation: validation(),
        contexts: [],
        budget: { maxDiffBytes: 2 * 1024 * 1024 },
      }),
    ).toThrowError(expect.objectContaining({ code: "review_evidence_too_large" }));
  });
});

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
