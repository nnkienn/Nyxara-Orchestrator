import type { PlanStructureBounds } from "./plan-validator.js";
import type { ExecutionPlanDraft } from "./planner.types.js";

export function groupPlanAcceptanceCriteria(
  draft: ExecutionPlanDraft,
  bounds: PlanStructureBounds,
): ExecutionPlanDraft {
  let changed = false;
  const tasks = draft.tasks.map((task) => {
    const criteria = groupCriteria(task.acceptanceCriteria, bounds);
    if (criteria === task.acceptanceCriteria) return task;
    changed = true;
    return { ...task, acceptanceCriteria: criteria };
  });
  return changed ? { ...draft, tasks } : draft;
}

function groupCriteria(criteria: string[], bounds: PlanStructureBounds): string[] {
  const requiredPairs = criteria.length - bounds.maxAcceptanceCriteriaPerTask;
  if (
    requiredPairs <= 0 ||
    !Number.isInteger(bounds.maxAcceptanceCriteriaPerTask) || bounds.maxAcceptanceCriteriaPerTask < 1 ||
    requiredPairs > Math.floor(criteria.length / 2) ||
    criteria.some((criterion) => criterion.length > bounds.maxAcceptanceCriterionCharacters)
  ) return criteria;

  const grouped: string[] = [];
  let pairs = 0;
  for (let index = 0; index < criteria.length; index += 1) {
    const current = criteria[index]!;
    const next = criteria[index + 1];
    if (pairs < requiredPairs && next !== undefined && current.length + 1 + next.length <= bounds.maxAcceptanceCriterionCharacters) {
      grouped.push(`${current}\n${next}`);
      pairs += 1;
      index += 1;
    } else {
      grouped.push(current);
    }
  }
  return pairs === requiredPairs ? grouped : criteria;
}
