import { z } from "zod";

export const ReviewContextRequestSchema = z
  .object({
    paths: z.array(z.string().trim().min(1)).max(8).optional(),
    symbols: z.array(z.string().trim().min(1)).max(8).optional(),
    reasons: z.array(z.string().trim().min(1)).min(1).max(8),
  })
  .superRefine((request, context) => {
    if ((request.paths?.length ?? 0) + (request.symbols?.length ?? 0) === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A context request needs at least one path or symbol",
      });
    }
  });

export const ReviewFindingDraftSchema = z.object({
  id: z.string().trim().min(1).optional(),
  severity: z.enum(["info", "warning", "error", "critical"]),
  category: z.enum([
    "correctness",
    "requirement",
    "architecture",
    "security",
    "maintainability",
    "performance",
    "testing",
  ]),
  message: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
  line: z.number().int().positive().optional(),
  taskId: z.string().trim().min(1).optional(),
});

export const ReviewCriterionResultSchema = z.object({
  criterion: z.string().trim().min(1),
  status: z.enum(["satisfied", "unsatisfied", "uncertain"]),
  reason: z.string().trim().min(1),
});

export const ReviewResultDraftSchema = z.object({
  status: z.enum(["passed", "failed", "needs_more_context"]),
  summary: z.string().trim().min(1),
  findings: z.array(ReviewFindingDraftSchema),
  criteria: z.array(ReviewCriterionResultSchema),
  risks: z.array(z.string().trim().min(1)).optional(),
  contextRequest: ReviewContextRequestSchema.optional(),
});

export type ReviewResultDraft = Readonly<
  z.infer<typeof ReviewResultDraftSchema>
>;
