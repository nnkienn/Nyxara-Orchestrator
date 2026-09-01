import type { PlannerInput } from "./planner.types.js";
import { compilePlanningProfile } from "./planning-profile-compiler.js";
import { DEFAULT_PLANNING_PROFILE, type PlanningProfile } from "./planning-profile.js";
import { compileEngineeringRules, type ResolvedRuleSet } from "../rules/engineering-rule.js";

export class PlannerPromptBuilder {
  build(input: PlannerInput, profile: PlanningProfile = DEFAULT_PLANNING_PROFILE, engineeringRules?: ResolvedRuleSet): string {
    const files = input.context.files
      .map(
        (file) =>
          `<file path="${escapeAttribute(file.path)}" reason="${escapeAttribute(file.reason)}">\n${file.content}\n</file>`,
      )
      .join("\n\n");
    const changedFiles = input.context.git.status.files
      .map((file) => `- ${file.path}: ${file.status}`)
      .join("\n");
    const constraints = input.constraints?.map((item) => `- ${item}`).join("\n");

    return [
      "You are the Planner role in Nyxara Orchestrator.",
      "Create an implementation plan only. Do not modify files, execute code, or claim work is complete.",
      "Use only the bounded repository context below. Avoid unrelated work.",
      "Define executable tasks, explicit dependencies, acceptance criteria, relevant files, and obvious risks.",
      "Return one JSON object only. Do not use Markdown fences or explanatory prose.",
      "",
      "Architecture boundaries:",
      "- Core remains provider-agnostic and UI-agnostic.",
      "- Roles are independent from providers and models.",
      "- Runtime plan state is structured data, never Markdown files.",
      "- Planner must not modify repository files.",
      "",
      compilePlanningProfile(profile),
      "",
      ...(engineeringRules ? [compileEngineeringRules(engineeringRules), ""] : []),
      "Required JSON shape:",
      JSON.stringify(
        {
          objective: "string",
          summary: "optional string",
          tasks: [
            {
              id: "T1",
              title: "string",
              description: "string",
              dependencies: [],
              acceptanceCriteria: ["string"],
              relevantFiles: ["optional/path.ts"],
              risk: "low | medium | high",
            },
          ],
          risks: [
            {
              description: "string",
              severity: "low | medium | high",
              mitigation: "optional string",
            },
          ],
          assumptions: ["string"],
        },
        null,
        2,
      ),
      "",
      `User requirement:\n${input.prompt}`,
      "",
      ...(constraints ? [`Additional constraints:\n${constraints}`, ""] : []),
      `Workspace: ${input.workspaceRoot}`,
      `Context metadata: ${input.context.files.length} files, approximately ${input.context.estimatedTokens} tokens, truncated=${input.context.truncated}`,
      "",
      `Current Git changes:\n${changedFiles || "- none"}`,
      "",
      `Working tree diff:\n${input.context.git.diff.diff || "(no working tree diff)"}`,
      "",
      `Relevant files:\n${files || "(no relevant files found)"}`,
    ].join("\n");
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
