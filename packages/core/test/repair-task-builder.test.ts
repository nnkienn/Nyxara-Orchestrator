import { describe, expect, it, vi } from "vitest";
import {
  deduplicateFindings,
  findingKey,
  relevantDiff,
  RepairEvidenceBuilder,
  RepairTaskBuilder,
} from "../src/index.js";
import {
  contextBundle,
  execution,
  failingReview,
  failingValidation,
  passingValidation,
  repairTask,
} from "./fixtures/repair-fixtures.js";

const limits = { maxEvidenceBytes: 64 * 1024, maxDiffBytes: 48 * 1024 };

describe("RepairTaskBuilder", () => {
  it("reduces a validation failure to a bounded, deterministic repair task", () => {
    const generate = vi.fn();
    const builder = new RepairTaskBuilder(() => "2026-08-29T00:00:05.000Z");
    const evidence = new RepairEvidenceBuilder().build({
      taskId: "T1",
      execution: execution(),
      validation: failingValidation(),
      contexts: [contextBundle()],
      limits,
    });

    const first = builder.build({
      originalTask: repairTask(),
      execution: execution(),
      validation: failingValidation(),
      evidence,
      cycle: 1,
    });
    const second = builder.build({
      originalTask: repairTask(),
      execution: execution(),
      validation: failingValidation(),
      evidence,
      cycle: 1,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      originalTaskId: "T1",
      cycle: 1,
      reason: "validation_failure",
      createdAt: "2026-08-29T00:00:05.000Z",
    });
    expect(first.objective).toContain("TS2322");
    expect(first.objective).toContain("src/notification.service.ts:42");
    expect(first.findings).toEqual([
      {
        source: "validation",
        code: "validation_failed",
        message:
          "src/notification.service.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        file: "src/notification.service.ts",
        line: 42,
        severity: "error",
      },
    ]);
    expect(first.relevantFiles).toEqual(["src/notification.service.ts"]);
    expect(first.acceptanceCriteria).toContain(
      "Preserve already-correct behavior and the existing public shape",
    );
    // The builder is deterministic: no model is involved.
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps review failures actionable and combines both failure sources", () => {
    const builder = new RepairTaskBuilder();
    const evidence = new RepairEvidenceBuilder().build({
      taskId: "T1",
      execution: execution(),
      validation: passingValidation(),
      review: failingReview(),
      contexts: [contextBundle()],
      limits,
    });

    const reviewOnly = builder.build({
      originalTask: repairTask(),
      execution: execution(),
      validation: passingValidation(),
      review: failingReview(),
      evidence,
      cycle: 2,
    });
    const both = builder.build({
      originalTask: repairTask(),
      execution: execution(),
      validation: failingValidation(),
      review: failingReview(),
      evidence,
      cycle: 2,
    });

    expect(reviewOnly.reason).toBe("review_failure");
    expect(reviewOnly.findings).toEqual([
      {
        source: "review",
        code: "correctness",
        message: "totalPages is calculated incorrectly",
        file: "src/notification.service.ts",
        line: 42,
        severity: "error",
      },
    ]);
    expect(reviewOnly.acceptanceCriteria[0]).toBe(
      "Resolve: totalPages is calculated incorrectly",
    );
    expect(reviewOnly.objective).not.toContain(repairTask().description);
    expect(both.reason).toBe("validation_and_review_failure");
    expect(both.findings).toHaveLength(2);
    expect(both.id).not.toBe(reviewOnly.id);
  });

  it("deduplicates repeated failures and rejects a repair without evidence", () => {
    const repeated = failingValidation();
    const duplicated = deduplicateFindings([
      ...[repeated, repeated, repeated].flatMap(() => [
        {
          source: "validation" as const,
          message: "error  TS2322:   duplicated   message",
          file: "src/notification.service.ts",
          line: 42,
        },
        {
          source: "validation" as const,
          message: "Error TS2322: DUPLICATED message",
          file: "./src/notification.service.ts",
          line: 42,
        },
      ]),
    ]);

    expect(duplicated).toHaveLength(1);
    expect(findingKey(duplicated[0]!)).toBe(
      "validation:src/notification.service.ts:42:error ts2322: duplicated message",
    );
    expect(() =>
      new RepairTaskBuilder().build({
        originalTask: repairTask(),
        execution: execution(),
        validation: passingValidation(),
        evidence: new RepairEvidenceBuilder().build({
          taskId: "T1",
          execution: execution(),
          validation: passingValidation(),
          contexts: [contextBundle()],
          limits,
        }),
        cycle: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "repair_not_required" }));
  });
});

describe("RepairEvidenceBuilder", () => {
  it("keeps only actionable failure evidence and the relevant diff delta", () => {
    const evidence = new RepairEvidenceBuilder().build({
      taskId: "T1",
      execution: execution(),
      validation: failingValidation(),
      review: failingReview(),
      contexts: [contextBundle()],
      limits,
    });

    expect(evidence.originalTaskId).toBe("T1");
    expect(evidence.currentChangedFiles).toEqual(["src/notification.service.ts"]);
    expect(evidence.validationFailures).toEqual([
      expect.objectContaining({ kind: "typecheck", status: "failed" }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain(
      "large successful lint log must not reach the repair prompt",
    );
    expect(evidence.reviewFindings).toEqual([
      expect.objectContaining({ message: "totalPages is calculated incorrectly" }),
    ]);
    expect(evidence.reviewFindings).toHaveLength(1);
    expect(evidence.relevantContext.map((item) => item.path)).toEqual([
      "src/notification.service.ts",
    ]);
    expect(evidence.diff?.content).toContain("src/notification.service.ts");
    expect(evidence.diff?.content).not.toContain("src/unrelated.ts");
  });

  it("bounds validation excerpts, context, and diff to the configured budget", () => {
    const huge = "E".repeat(200_000);
    const evidence = new RepairEvidenceBuilder().build({
      taskId: "T1",
      execution: execution(),
      validation: failingValidation(
        "src/notification.service.ts(42,7): error TS2322: " + huge,
      ),
      contexts: [
        contextBundle([
          { path: "src/notification.service.ts", content: "C".repeat(200_000) },
        ]),
      ],
      limits: { maxEvidenceBytes: 4096, maxDiffBytes: 64 },
    });

    const failure = evidence.validationFailures[0]!;
    expect(failure.truncated).toBe(true);
    expect(Buffer.byteLength(failure.message, "utf8")).toBeLessThanOrEqual(1365);
    expect(evidence.relevantContext[0]?.truncated).toBe(true);
    expect(
      Buffer.byteLength(evidence.relevantContext[0]!.content, "utf8"),
    ).toBeLessThanOrEqual(4096);
    expect(evidence.diff).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(evidence.diff!.content, "utf8")).toBeLessThanOrEqual(64);
  });

  it("returns only the diff sections of currently changed files", () => {
    const diff = execution().git.diff.diff;

    expect(relevantDiff(diff, ["src/unrelated.ts"])).toContain("src/unrelated.ts");
    expect(relevantDiff(diff, ["src/unrelated.ts"])).not.toContain(
      "a/src/notification.service.ts",
    );
    expect(relevantDiff(diff, [])).toBe("");
  });
});
