# Planner criteria bounds — alpha.33

> [!WARNING]
> Historical document retained for engineering and research provenance.
>
> This document describes a previous Nyxara alpha baseline. It is not the
> current product direction or the canonical architecture specification.
> See `../../../ARCHITECTURE.md` and `../../../ROADMAP.md`.

**Status:** Historical

## Evidence

The September 7, 2026 local task `a4545b0e-c590-4fb2-9edd-dda39df01abd`
failed with `plan_bounds_exceeded`: T7 contained 8 acceptance-criteria entries,
where Core allows 6. A later task `2230da9c-bfa7-4f2a-8472-0d4e19a3d0e4`
failed on the same rule for T6, with 7 entries. Both diagnostics identify an
array-size violation, not a provider timeout or empty response. The rejected
drafts are not retained, so their exact text cannot be replayed.

The prompt already mentioned six entries, but did not communicate every
structural character bound. VS Code replaced the precise validation error with
“oversized plan” and incorrectly implied the requirement needed narrowing.

## Conservative, lossless format normalization

After JSON/schema parsing and **before** validation/approval, Core can combine
two adjacent acceptance-criteria strings using one newline. It does this only
for a task exceeding the configured entry count, and only when enough pairs fit
the existing per-entry character bound. Every original string, duplicate,
numeric threshold, and ordering is retained. There is no summarization, deletion,
deduplication, cross-task transfer, or task/dependency change.

- Defaults remain **6 entries/task** and **400 characters/entry**.
- Each resulting entry contains at most two original entries. Large lists such
  as 20 short criteria still fail; normalization is not unrestricted packing.
- A task that cannot fit returns its original criteria array unchanged, rather
  than a partially truncated or partially grouped array.
- Already-in-bound drafts remain unchanged; normalization is idempotent.
- The normalizer and generation prompt read the actual `PlanValidator` bounds,
  including custom bounds, rather than independently hardcoding defaults.
- The unchanged validator checks the entire candidate afterward. Invalid graphs,
  missing dependencies, oversized fields/tasks/risks, and malformed data still
  fail. No partially valid plan is published.
- There is no extra provider request, automatic retry, output-budget increase,
  workflow stage, or new workflow configuration. User approval is still required.

Successful grouping emits counts only in the Planner completion diagnostic and
the local output log. The normal plan card displays all grouped text, and History
retains it on reload. No raw provider response or repository context is logged.

## Error and version visibility

VS Code preserves the precise bounded/redacted field/count diagnostic when a plan
still cannot fit. It no longer generically tells the user to narrow the requirement.
The prompt includes all existing structural bounds and repeats the per-task
criteria contract after repository context.

The activation log now includes the loaded version. Installing a VSIX does not
prove an existing extension host has loaded it: run **Developer: Reload Window**
after a task has stopped and confirm `Nyxara extension activated (v0.1.0-alpha.33)`.
This change does not reload, abort, or rerun a user's active workflow automatically.

## Validation

Focused tests cover 7–12 short criteria, exact 400-character boundaries, pairs that
cannot fit, duplicate/multiline/Unicode preservation, immutable inputs, custom
bounds, idempotence, dependency rejection, and all previous oversized-plan guards.
The mocked streaming gateway path still uses exactly one generation request and
waits for explicit approval. Webview and History tests retain every original check.

This fixes a presentation-sized criteria overflow, not all possible Planner
failures. Truly oversized drafts still fail safely. Model availability and the
target monorepo's missing root validation scripts remain separate issues; this
release does not modify routes, credentials, profiles, or the target repository.
