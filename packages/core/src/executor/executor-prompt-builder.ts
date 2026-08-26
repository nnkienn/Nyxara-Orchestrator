import type { ModelToolDefinition } from "@nyxara/provider-sdk";
import type { ExecutorInput } from "./executor.types.js";

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
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
