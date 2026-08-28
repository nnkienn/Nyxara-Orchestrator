import type { ReviewerInput } from "./reviewer.types.js";

export class ReviewerPromptBuilder {
  build(input: ReviewerInput): string {
    const evidence = input.evidence;
    const validation = evidence.validation.steps
      .map((step) =>
        [
          `${step.kind}: ${step.status}${step.exitCode !== undefined ? ` (exit ${step.exitCode})` : ""}`,
          ...(step.errorExcerpt ? [step.errorExcerpt] : []),
        ].join("\n"),
      )
      .join("\n\n");
    const context = evidence.context
      .map(
        (item) =>
          `<context id="${escapeAttribute(item.id)}" path="${escapeAttribute(item.path)}" lines="${item.startLine}-${item.endLine}" truncated="${item.truncated}">\n${item.content}\n</context>`,
      )
      .join("\n\n");

    return [
      "You are the Reviewer role in Nyxara Orchestrator.",
      "Review only the bounded evidence provided. You have no repository or command tools.",
      "Do not assume unseen code works and do not claim a criterion is satisfied without evidence.",
      "Git diff has higher authority than Executor prose. Deterministic validation has higher authority than AI opinion.",
      "Request more context only for specific paths or symbols with specific reasons. Never request a broad repository scan.",
      "Do not edit files, run commands, trigger Executor, or propose an automatic repair loop.",
      "Return one JSON object only, without Markdown fences or prose outside JSON.",
      "Evaluate every acceptance criterion exactly once using its exact text.",
      "Allowed status values: passed, failed, needs_more_context.",
      "Allowed criterion status values: satisfied, unsatisfied, uncertain.",
      "A passed result requires all criteria satisfied and no error/critical findings.",
      "Required JSON shape:",
      JSON.stringify(
        {
          status: "passed | failed | needs_more_context",
          summary: "string",
          findings: [
            {
              severity: "info | warning | error | critical",
              category:
                "correctness | requirement | architecture | security | maintainability | performance | testing",
              message: "string",
              file: "optional/path.ts",
              line: 1,
              taskId: input.task.id,
            },
          ],
          criteria: input.task.acceptanceCriteria.map((criterion) => ({
            criterion,
            status: "satisfied | unsatisfied | uncertain",
            reason: "string",
          })),
          risks: ["optional string"],
          contextRequest: {
            paths: ["specific/optional/path.ts"],
            symbols: ["SpecificSymbol"],
            reasons: ["specific reason"],
          },
        },
        null,
        2,
      ),
      "",
      `1. User requirement:\n${input.requirement}`,
      "",
      `2. Current task:\n${input.task.id}: ${input.task.title}\n${input.task.description}`,
      "",
      `3. Acceptance criteria:\n${input.task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
      "",
      `4. Deterministic validation (${evidence.validation.status.toUpperCase()}):\n${validation || "No validation steps"}`,
      "",
      `5. Git diff (${Buffer.byteLength(evidence.diff.content, "utf8")} bytes, truncated=${evidence.diff.truncated}):\n${evidence.diff.content || "(no bounded diff content)"}`,
      "",
      `6. Minimal reused context (${evidence.context.length} snippets):\n${context || "(no reused context)"}`,
      "",
      `7. Executor summary (orientation only, not evidence):\n${evidence.executorSummary ?? "(none)"}`,
    ].join("\n");
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
