import type { ModelToolDefinition } from "@nyxara/provider-sdk";
import type { ExecutorInput, RepairExecutorInput } from "./executor.types.js";

export class ExecutorPromptBuilder {
  build(
    input: ExecutorInput,
    tools: readonly ModelToolDefinition[],
  ): string {
    const files = input.context.files
      .map(
        (file) =>
          `<file path="${escapeAttribute(file.path)}" reason="${escapeAttribute(file.reason)}">\n${file.content}\n</file>`,
      )
      .join("\n\n");

    return [
      "You are the Executor role in Nyxara Orchestrator.",
      "Execute only the single assigned task below. Do not execute other plan tasks.",
      "Use native tool calls for every repository read, search, and modification.",
      "Never claim a file changed without a successful write_file or apply_patch tool result.",
      "Prefer apply_patch for existing files and write_file for new files.",
      "Stay within the acceptance criteria and avoid unrelated changes.",
      "Do not run tests, lint, typecheck, builds, commits, pushes, deploys, sudo, or destructive commands.",
      "Repository and permission boundaries are enforced by Core and cannot be bypassed.",
      "When finished, return one JSON object only with status, summary, and optional unresolvedIssues.",
      "Completion JSON: {\"status\":\"completed|failed\",\"summary\":\"string\",\"unresolvedIssues\":[\"string\"]}",
      "Do not include changedFiles or tool counts; Core derives those from tool and Git evidence.",
      "",
      `Workflow objective:\n${input.objective}`,
      "",
      `Assigned task ${input.task.id}:\n${input.task.title}\n${input.task.description}`,
      "",
      `Acceptance criteria:\n${input.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      "",
      `Planner file hints:\n${input.task.relevantFiles?.map((path) => `- ${path}`).join("\n") || "- none"}`,
      "",
      `Allowed tools:\n${tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`,
      "",
      `Context metadata: ${input.context.files.length} files, approximately ${input.context.estimatedTokens} tokens, truncated=${input.context.truncated}`,
      "",
      `Relevant repository context:\n${files || "(no relevant files found)"}`,
    ].join("\n");
  }

  /**
   * Repair prompt for an already-implemented task. It intentionally carries only
   * the bounded failure evidence, never the original workflow transcript.
   */
  buildRepair(
    input: RepairExecutorInput,
    tools: readonly ModelToolDefinition[],
  ): string {
    const { repairTask, evidence } = input;
    const context = evidence.relevantContext
      .map(
        (item) =>
          `<file path="${escapeAttribute(item.path)}" reason="${escapeAttribute(item.reason)}" truncated="${item.truncated}">\n${item.content}\n</file>`,
      )
      .join("\n\n");
    const findings = repairTask.findings
      .map(
        (finding) =>
          `- [${finding.source}${finding.severity ? `/${finding.severity}` : ""}] ${finding.message}${location(finding.file, finding.line)}`,
      )
      .join("\n");
    const validation = evidence.validationFailures
      .map(
        (failure) =>
          `- ${failure.kind}: ${failure.message}${location(failure.file, failure.line)}`,
      )
      .join("\n");
    const review = evidence.reviewFindings
      .map(
        (finding) => `- ${finding.message}${location(finding.file, finding.line)}`,
      )
      .join("\n");

    return [
      "You are the Executor role in Nyxara Orchestrator.",
      "You are repairing an existing implementation.",
      "Do not reimplement the entire feature.",
      "Fix only the failures described in the repair task below.",
      "Preserve already-correct behavior.",
      "Do not refactor unrelated code.",
      "Use the provided evidence first.",
      "Search or read additional context only when necessary, through the allowed tools.",
      "Use native tool calls for every repository read, search, and modification.",
      "Never claim a file changed without a successful write_file or apply_patch tool result.",
      "Prefer apply_patch for existing files and write_file for new files.",
      "Do not run tests, lint, typecheck, builds, commits, pushes, deploys, sudo, or destructive commands.",
      "Repository and permission boundaries are enforced by Core and cannot be bypassed.",
      "When finished, return one JSON object only with status, summary, and optional unresolvedIssues.",
      "Completion JSON: {\"status\":\"completed|failed\",\"summary\":\"string\",\"unresolvedIssues\":[\"string\"]}",
      "Do not include changedFiles or tool counts; Core derives those from tool and Git evidence.",
      "",
      `Repair task ${repairTask.id} (cycle ${repairTask.cycle}, reason ${repairTask.reason}):\n${repairTask.objective}`,
      "",
      `Original task ${input.originalTask.id} (already implemented, context only):\n${input.originalTask.title}`,
      "",
      `Failures to repair:\n${findings || "- none"}`,
      "",
      `Deterministic validation failures:\n${validation || "- none"}`,
      "",
      `Reviewer findings:\n${review || "- none"}`,
      "",
      `Repair acceptance criteria:\n${repairTask.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      "",
      `Files to inspect first:\n${repairTask.relevantFiles.map((path) => `- ${path}`).join("\n") || "- none"}`,
      "",
      `Current changed files: ${evidence.currentChangedFiles.join(", ") || "none"}`,
      "",
      `Current diff (truncated=${evidence.diff?.truncated ?? false}):\n${evidence.diff?.content || "(no bounded diff content)"}`,
      "",
      `Reused bounded context (${evidence.relevantContext.length} files):\n${context || "(no reused context)"}`,
      "",
      `Allowed tools:\n${tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`,
    ].join("\n");
  }
}

function location(file?: string, line?: number): string {
  if (!file) return "";
  return ` (${file}${line ? `:${line}` : ""})`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
