import type { PlannerInput } from "./planner.types.js";
import { compilePlanningProfile } from "./planning-profile-compiler.js";
import { DEFAULT_PLANNING_PROFILE, type PlanningProfile } from "./planning-profile.js";
import { compileEngineeringRules, type ResolvedRuleSet } from "../rules/engineering-rule.js";
import { DEFAULT_PLAN_STRUCTURE_BOUNDS, type PlanStructureBounds } from "./plan-validator.js";

export class PlannerPromptBuilder {
  build(input: PlannerInput, profile: PlanningProfile = DEFAULT_PLANNING_PROFILE, engineeringRules?: ResolvedRuleSet, bounds: PlanStructureBounds = DEFAULT_PLAN_STRUCTURE_BOUNDS): string {
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
      "Define executable tasks, explicit dependencies, acceptance criteria, relevant files, executionMode, and obvious risks.",
      "Set executionMode to implementation when the task must change repository state, or read_only only when its accepted result is an audit/report with no repository mutation.",
      `Keep the plan concise: at most ${bounds.maxTasks} tasks, ${bounds.maxAcceptanceCriteriaPerTask} acceptance criteria per task, ${bounds.maxRisks} risks, and ${bounds.maxAssumptions} assumptions.`,
      `Hard character limits: objective ${bounds.maxObjectiveCharacters}, summary ${bounds.maxSummaryCharacters}, task title ${bounds.maxTitleCharacters}, task description ${bounds.maxDescriptionCharacters}, each acceptance criterion ${bounds.maxAcceptanceCriterionCharacters}.`,
      `Each task may list at most ${bounds.maxRelevantFilesPerTask} relevant files. Each risk description and mitigation must fit ${bounds.maxRiskDescriptionCharacters} and ${bounds.maxRiskMitigationCharacters} characters respectively; each assumption must fit ${bounds.maxAssumptionCharacters} characters.`,
      "These are acceptance limits, not style suggestions. Preserve every requested check; group related checks concisely instead of adding redundant criteria or tasks.",
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
              executionMode: "implementation | read_only",
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
      "",
      `Before returning JSON, count every task's acceptanceCriteria: 1–${bounds.maxAcceptanceCriteriaPerTask} entries, each at most ${bounds.maxAcceptanceCriterionCharacters} characters. Keep all requirements, task dependencies, and numeric thresholds intact.`,
      "Final response contract: return exactly one complete JSON object matching the required shape above, without analysis, Markdown, or implementation results.",
      "Describe requested commands, screenshots, and reports as tasks or acceptance criteria; do not execute or produce them during planning.",
    ].join("\n");
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
