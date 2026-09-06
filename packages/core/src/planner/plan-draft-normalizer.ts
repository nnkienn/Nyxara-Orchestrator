import { PlannerError } from "./planner-error.js";

type JsonRecord = Record<string, unknown>;

/**
 * Accepts bounded, common structured-output variations without weakening the
 * semantic plan validator. Provider prose, Markdown fences, one wrapper object,
 * and snake_case field names are normalized; dependency and graph correctness
 * remain the responsibility of PlanValidator.
 */
export function parseAndNormalizePlanDraft(text: string): unknown {
  return normalizeDraft(parseJsonValue(text));
}

function parseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [unfenced, firstJsonObject(unfenced)]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try the bounded extraction */ }
  }
  throw new PlannerError("plan_parse_error", "Planner response did not contain a valid JSON object");
}

function firstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return undefined;
}

function normalizeDraft(value: unknown): unknown {
  if (typeof value === "string") {
    try { return normalizeDraft(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value) && value.length === 1) return normalizeDraft(value[0]);
  if (!record(value)) return value;

  const wrapped = first(value, "plan", "executionPlan", "execution_plan", "result");
  const source = !Array.isArray(value.tasks) && !Array.isArray(value.steps) && record(wrapped) ? wrapped : value;
  const tasks = first(source, "tasks", "steps");
  return {
    ...source,
    objective: first(source, "objective", "goal"),
    summary: first(source, "summary", "overview"),
    tasks: Array.isArray(tasks) ? tasks.map(normalizeTask) : tasks,
    risks: normalizeRisks(source.risks),
    assumptions: normalizeStringArray(source.assumptions),
  };
}

function normalizeTask(value: unknown): unknown {
  if (!record(value)) return value;
  const dependencies = first(value, "dependencies", "dependsOn", "depends_on");
  const acceptance = first(value, "acceptanceCriteria", "acceptance_criteria", "acceptance", "criteria", "verification");
  const files = first(value, "relevantFiles", "relevant_files", "files");
  return {
    ...value,
    id: first(value, "id", "taskId", "task_id"),
    title: value.title,
    description: first(value, "description", "details"),
    dependencies: dependencies === undefined ? [] : normalizeStringArray(dependencies),
    acceptanceCriteria: normalizeStringArray(acceptance),
    ...(files === undefined ? {} : { relevantFiles: normalizeStringArray(files) }),
    ...(typeof value.risk === "string" ? { risk: value.risk.toLowerCase() } : {}),
  };
}

function normalizeRisks(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return value;
  return value.map((risk) => record(risk) && typeof risk.severity === "string"
    ? { ...risk, severity: risk.severity.toLowerCase() }
    : risk);
}

function normalizeStringArray(value: unknown): unknown {
  if (typeof value === "string") return value.trim() ? [value] : [];
  return value;
}

function first(source: JsonRecord, ...keys: readonly string[]): unknown {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
