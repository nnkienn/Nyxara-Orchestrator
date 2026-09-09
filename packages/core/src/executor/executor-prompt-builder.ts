import type { ModelToolDefinition } from "@nyxara/provider-sdk";
import { compileEngineeringRules } from "../rules/engineering-rule.js";
import type { ExecutorInput, RepairExecutorInput } from "./executor.types.js";

export interface ExecutorPromptState {
  readonly executionState: string;
  readonly retainedEvidence: string;
  readonly readOnly: boolean;
}

export class ExecutorPromptBuilder {
  build(
    input: ExecutorInput,
    tools: readonly ModelToolDefinition[],
    state?: ExecutorPromptState,
  ): string {
    const files = input.context.files
      .map(
        (file) =>
          `<file path="${escapeAttribute(file.path)}" reason="${escapeAttribute(file.reason)}">\n${file.content}\n</file>`,
      )
      .join("\n\n");
    const targetIssues = input.context.targetIssues
      ?.map((issue) => `- ${issue.kind} ${issue.target}: ${issue.code} — ${issue.message}`)
      .join("\n");

    return [
      "You are the Executor role in Nyxara Orchestrator.",
      "Execute only the single assigned task below. Do not execute other plan tasks.",
      "The relevant repository context below was read through Core's safe repository tools and is authoritative initial evidence for this task.",
      "If a required path or symbol is absent from that bounded context, use the allowed read_file or search_code tool instead of failing because a prior Planner read result is missing.",
      "Use native tool calls for every additional repository read, search, and every modification.",
      "Never claim a file changed without tool and Git evidence.",
      "Prefer apply_patch for existing files and write_file for new files.",
      "Use run_command for scripts or commands explicitly needed by the assigned task; pass the executable and arguments separately. It runs from the workspace root without a shell and may require user permission.",
      "Stay within the acceptance criteria and avoid unrelated changes.",
      state?.readOnly
        ? "This is a read-only task. Do not call mutating tools; a truthful zero-change completion is valid."
        : "This is an implementation task. Once sufficient relevant evidence exists, decide and transition to a patch instead of repeating repository inspection.",
      "Core owns automatic validation. Do not duplicate tests, lint, typecheck, or builds unless explicitly required by the assigned task. Never run commits, pushes, deploys, sudo, shells, or destructive commands.",
      "Repository and permission boundaries are enforced by Core and cannot be bypassed.",
      "When finished, return one JSON object only with status, summary, and optional unresolvedIssues.",
      "Completion JSON: {\"status\":\"completed|failed\",\"summary\":\"string\",\"unresolvedIssues\":[\"string\"]}",
      "Do not include changedFiles or tool counts; Core derives those from tool and Git evidence.",
      "",
      `Workflow objective:\n${input.objective}`,
      "",
      `Assigned task ${input.task.id} (Task ID: ${input.task.id}):\n${input.task.title}\n${input.task.description}`,
      "",
      `Acceptance criteria:\n${input.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      "",
      `Execution mode: ${state?.readOnly ? "read_only" : "implementation"}`,
      "",
      ...(input.engineeringRules ? [compileEngineeringRules(input.engineeringRules), ""] : []),
      `Planner file hints:\n${input.task.relevantFiles?.map((path) => `- ${path}`).join("\n") || "- none"}`,
      "",
      `Allowed tools:\n${tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`,
      "",
      `Context metadata: ${input.context.files.length} files, approximately ${input.context.estimatedTokens} tokens, truncated=${input.context.truncated}`,
      "",
      `Relevant repository context:\n${files || "(no relevant files found)"}`,
      "",
      `Targeted lookup results:\n${targetIssues || "- no missing target was reported by the bounded prefetch; use the allowed tools for any target not shown above"}`,
      "",
      `Current execution state:\n${state?.executionState ?? "phase=inspect"}`,
      "",
      `Compacted useful tool evidence:\n${state?.retainedEvidence || "(none; the latest tool exchange, when present, is supplied separately)"}`,
    ].join("\n");
  }

  /**
   * Repair prompt for an already-implemented task. It intentionally carries only
   * the bounded failure evidence, never the original workflow transcript.
   */
  buildRepair(
    input: RepairExecutorInput,
    tools: readonly ModelToolDefinition[],
    state?: ExecutorPromptState,
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
          `- [${finding.source}${finding.severity ? `/${finding.severity}` : ""}${finding.ruleId ? `/rule:${finding.ruleId}` : ""}] ${finding.message}${location(finding.file, finding.line)}`,
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
      "Never claim a file changed without tool and Git evidence.",
      "Prefer apply_patch for existing files and write_file for new files.",
      "Use run_command only for commands required by the repair task, from the workspace root with separate arguments, bounded timeout/output, no shell, and Core permissions.",
      "Core owns automatic validation. Do not duplicate tests, lint, typecheck, or builds unless explicitly required by the assigned task. Never run commits, pushes, deploys, sudo, shells, or destructive commands.",
      "Repository and permission boundaries are enforced by Core and cannot be bypassed.",
      "When finished, return one JSON object only with status, summary, and optional unresolvedIssues.",
      "Completion JSON: {\"status\":\"completed|failed\",\"summary\":\"string\",\"unresolvedIssues\":[\"string\"]}",
      "Do not include changedFiles or tool counts; Core derives those from tool and Git evidence.",
      "",
      `Repair task ${repairTask.id} (cycle ${repairTask.cycle}, reason ${repairTask.reason}):\n${repairTask.objective}`,
      "",
      `Original task ${input.originalTask.id} (already implemented, context only):\n${input.originalTask.title}`,
      "",
      ...(input.engineeringRules ? [compileEngineeringRules(input.engineeringRules), ""] : []),
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
      "",
      `Current execution state:\n${state?.executionState ?? "phase=inspect"}`,
      "",
      `Compacted useful tool evidence:\n${state?.retainedEvidence || "(none; the latest tool exchange, when present, is supplied separately)"}`,
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
