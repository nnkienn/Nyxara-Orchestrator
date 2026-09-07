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
  const trimmed = stripLeadingThinkingBlocks(text.trim());
  try { return JSON.parse(trimmed); } catch {}

  const fences = [...trimmed.matchAll(/^[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*\r?$/gmi)];
  if (fences.length > 0) {
    if (fences.length === 1) {
      try { return JSON.parse(fences[0]![1]!); } catch {}
    }
    throw parseError();
  }

  const parsed: unknown[] = [];
  const plans: unknown[] = [];
  for (const candidate of jsonObjects(trimmed)) {
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { continue; }
    parsed.push(value);
    const normalized = normalizeDraft(value);
    if (record(normalized) && (normalized.tasks !== undefined || normalized.objective !== undefined)) plans.push(value);
  }
  if (plans.length === 1) return plans[0];
  if (plans.length === 0 && parsed.length === 1) return parsed[0];
  throw parseError();
}

function stripLeadingThinkingBlocks(text: string): string {
  let remaining = text;
  while (/^<(think|thinking)>/i.test(remaining)) {
    const block = remaining.match(/^<(think|thinking)>[\s\S]*?<\/\1>\s*/i);
    if (!block) throw parseError();
    remaining = remaining.slice(block[0].length);
  }
  return remaining;
}

function parseError(): PlannerError {
  return new PlannerError("plan_parse_error", "Planner response did not contain one unambiguous valid plan JSON object");
}

function* jsonObjects(value: string): Generator<string> {
  let start: number | undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (start === undefined) {
      if (character === "{") { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      yield value.slice(start, index + 1);
      start = undefined;
    }
  }
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
