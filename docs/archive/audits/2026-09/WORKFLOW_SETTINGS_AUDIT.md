# Workflow Settings audit

> [!WARNING]
> Historical document retained for engineering and research provenance.
>
> This document describes a previous Nyxara alpha baseline. It is not the
> current product direction or the canonical architecture specification.
> See `../../../ARCHITECTURE.md` and `../../../ROADMAP.md`.

**Status:** Historical

Audit date: September 7, 2026. Baseline: VS Code `0.1.0-alpha.24`.

## Classification and baseline

- **A — Configurable:** persisted user configuration consumed by Core (through the existing client adapter where necessary).
- **B — Fixed capability:** supported runtime behavior with no persisted user switch in the baseline. Some B entries have an existing public Core option; these are explicitly distinguished from architectural invariants.
- **C — Internal only:** process-local API tuning, evidence/resource budgets, implementation heuristics, or runtime state; not a Settings control.

**There were no persisted Workflow options in alpha.24.** Its Workflow, Validation, Review, and Repair projections were static summaries. In particular, the displayed repair limit came from `DEFAULT_REPAIR_LIMITS`, not a saved preference. The existing Core options in the next table are exposed using the request's persistence-plumbing exception; they are not described as pre-existing VS Code settings.

Evidence: `apps/vscode/package.json` configuration contributions; `apps/vscode/src/extension.ts` configuration reader/update handlers; `apps/vscode/src/session.ts` constructor and `approveAndRun`; `apps/vscode/src/settings-projection.ts`.

## Existing public options receiving persistence

All paths below retain their existing Core names beneath the single new VS Code storage key `nyxara.workflow`. They move from **B (supported public option, no persisted user setting)** in alpha.24 to **A** with this bridge. No new stage, gate, retry strategy, or workflow mode is introduced.

| Existing Core path | Existing behavior/default and constraint | Control |
| --- | --- | --- |
| `runApprovedPlan.allowRepair` | `true`; actual boolean. Already snapshotted into `WorkflowRuntime.allowRepair`. `runTaskPipeline.allowRepair` also exists; its direct-call omission semantics are unchanged. | Automatic Repair checkbox |
| `repairLimits.maxRepairCycles` | `3`; integer `1..5` | Maximum Repair Cycles number |
| `repairLimits.maxExecutorAttemptsPerTask` | `3`; integer `1..5` | Maximum Executor Attempts number |
| `repairLimits.maxValidationAttempts` | `4`; positive integer; Core has no additional maximum | Maximum Validation Attempts number |
| `repairLimits.maxReviewAttempts` | `4`; positive integer; Core has no additional maximum | Maximum Review Attempts number |
| `validation.failFast` | `true`; actual boolean | Stop Validation on First Failure checkbox |
| `validation.{typecheck,lint,test,build}.enabled` | `true` per step; actual boolean | Four validation-step checkboxes |
| `validation.{typecheck,lint,test,build}.timeoutMs` | Typecheck/lint `120000`; test/build `300000`; integer `1..1800000` ms | Four timeout numbers |
| `reviewerLimits.maxReviewerTurns` | `2`; integer `1..4` | Maximum Reviewer Turns number |

Sources/consumers:

- `packages/core/src/orchestrator/orchestrator.types.ts`: `NyxaraOrchestratorConfig`, `RunTaskPipelineInput`, `RepairTaskInput` already declare these config paths except `allowRepair`, which already exists on the run inputs.
- `packages/core/src/orchestrator/orchestrator.ts`: `runApprovedPlan`, `runTaskPipeline`, `validate`, `reviewTask`, `repairTask` consume the existing options.
- `packages/core/src/repair/repair-orchestrator.ts`: `DEFAULT_REPAIR_LIMITS`, `resolveRepairLimits`, loop counters and stop conditions.
- `packages/core/src/validation/validation-config.ts`: `normalizeValidationConfig`, boolean and timeout validation.
- `packages/core/src/validation/validation-command-discovery.ts`: `resolveStep`, default enabled behavior and `DEFAULT_TIMEOUTS`.
- `packages/core/src/review/reviewer.ts`: `DEFAULT_REVIEWER_LIMITS`, `resolveReviewerLimits`, reviewer turn loop.

The repair counters start at **zero on entry to the repair loop**. The prior execution/validation/review supplied as evidence is not counted as a repair attempt. The earliest cycle/attempt/stall condition stops repair. A higher cycle limit does not override the independent attempt limits.

There is **no scalar workflow enum setting**. Validation's `order` is a structured array of validation-kind enums, not a scalar mode. Planning-profile enums belong to the existing Planning feature; model execution enums belong to Models & Roles.

## Fixed capabilities — B, kept read-only

| Item | Audited behavior / source |
| --- | --- |
| Plan Approval | Required on the approved-plan path. `approvePlan`, `assertApprovedPlanIntegrity`, and `runApprovedPlan` verify approval, workflow/plan linkage, and integrity. No approval configuration exists. Lower-level pipeline APIs do not create a user-facing bypass. |
| After Approval | `NyxaraSession.approveAndRun` calls approval then `runApprovedPlan`; Core sequentially advances the dependency graph. There is no configurable continuation switch. |
| Validation before Review | `runTaskPipeline` and repair run deterministic validation first. Failed validation skips the Reviewer. No global validation-stage toggle exists; only existing per-step options are editable. |
| Review enabled/disabled | No Review enable flag exists. Review runs after passing validation; `needs_more_context` is a runtime result, not a selectable policy. |
| Pause / Resume | `pauseWorkflow`, `pauseAtBoundary`, `resumeWorkflow`; checkpoints, preserved completed tasks, and workspace integrity verification on resume. No pause policy/configuration exists. |
| Permission waiting | `awaitWorkflowPermission`, `resolveWorkflowPermission`; waits for the matching request ID and allow/deny decision. No user-configurable wait duration or auto-resolution option exists. Rules remain in Permissions. |
| Abort | `abortWorkflow`/AbortController signal; existing repository changes remain. No configurable rollback, abort strategy, or abort timeout exists. |
| Repair no-change detection | Stops on absent trusted changes, identical Git diff, or no relevant changed paths. No user-facing option exists to bypass these checks. |
| Repair orchestration | Validation first, uses the Executor assignment, reuses context, no Planner replan. These are capabilities, not editable workflow modes. |

Sources: `packages/core/src/orchestrator/orchestrator.ts`, `packages/core/src/workflow/workflow-runtime.ts`, `packages/core/src/workflow/workflow.types.ts`, `packages/core/src/planner/plan-runtime.ts`, `packages/core/src/repair/repair-orchestrator.ts`, and `apps/vscode/src/session.ts`.

## Internal-only values — C, not exposed

These are real implementation/API values, not invented omissions. Having a public TypeScript limit type does not by itself make every resource budget a user-facing preference.

| Area | Existing fields/state and treatment |
| --- | --- |
| Repair heuristics | `stuckThreshold` (default `2`); repeated-finding counts/keys, relevance checks, diff comparison. Repetition threshold is an SDK limit but has no prior persisted user-level configuration; retained as internal tuning. |
| Repair resources | `maxContextExpansions`, `maxEvidenceBytes`, `maxDiffBytes`, `maxHistoryEntries`; kept as bounded evidence/context/history mechanics. |
| Review context | `reviewerLimits.maxContextExpansions` (default `1`); `reviewTask` further clamps it against evidence budget and `maxReviewerTurns - 1`. No misleading independent expansion control is added. One reviewer turn therefore permits no expansion, as before. |
| Review evidence | `reviewEvidenceBudget.maxDiffBytes`, `maxContextFiles`, `maxContextBytes`, `maxBytesPerContextFile`, `maxValidationBytes`, `maxContextExpansions`; bounded evidence/expansion mechanics. |
| Validation commands/policy | Per-step `command`, `required`, `maxOutputBytes`, and `validation.order` exist as Core API overrides, but have no persisted user-level settings in this client. Command discovery and conditional required defaults depend on repository metadata; opening Settings must not resolve them. No command editor, discovered-command cache, required-policy enum, output-budget control, or order editor is introduced. |
| Validation discovery | `SCRIPT_CANDIDATES`, detected package manager, explicit/discovered/missing source, availability, changed-file checks and fail-fast execution state. Commands are discovered only when real validation runs. |
| Executor | Provider-neutral internal safety controls: final `maxToolCallsPerTask` (`96`), category ceilings for read (`72`), mutation (`16`), and validation (`12`), provider calls (`16`), per-result bytes (`24576`), retained evidence (`65536`), complete request bytes (`196608`), estimated input tokens (`49152`), and progress-stall thresholds. `maxModelTurnsPerTask` remains a compatibility alias for the provider-call ceiling. These are resource guards, not new Workflow UI controls. |
| Context/planning | `contextBudget`, planner-context reuse, task-context/evidence selectors, `PlanningRequestSignals`, planning-context mode/ambiguity decisions, planner output token cap; remain in their existing Core APIs/Context/Planning ownership. |
| Workflow retention/state | `workflowLimits.maxWorkflows`, `maxTasksPerWorkflow`; runtime/store retention, transition table, plan approval records/fingerprints, abort/pause/permission gates, completed/failed/blocked sets, task attempt counters, usage accumulators and terminal outcomes. These are not preferences. |
| Permission policies | `DefaultPermissionPolicy` command and file-write decisions are process-local tool/permission-engine configuration, not Workflow configuration. No permission rule is changed or duplicated. |
| Other timeouts | Generic process execution timeout/output bounds and subscription CLI timeout/output bounds remain execution/provider internals. Auth expiration/discovery timeouts remain provider lifecycle internals. No general workflow timeout or configurable retry/backoff setting was found. Repair attempts are the existing bounded retry mechanism. |

Additional evidence: `packages/core/src/executor/executor.ts`, `packages/core/src/context/`, `packages/core/src/review/review-evidence-builder.ts`, `packages/core/src/validation/validation-engine.ts`, `packages/core/src/workflow/workflow-state-store.ts`, `packages/tools/src/permissions/default-permission-engine.ts`, `packages/tools/src/execution/local-execution-runtime.ts`, `packages/providers/src/cli-subscription/cli-subscription-provider.ts`.

## Values owned elsewhere — unchanged

- **A:** `nyxara.planningProfile` selects a Core-registered profile. Profile `planStyle`, `riskMode`, output language, locale, acceptance/dependency/risk requirements and custom instructions are compiled by Core. Keep selection in Planning; no second workflow profile selector.
- **A:** `nyxara.{planner,executor,reviewer}.{provider,model,execution}` and provider configurations route model execution. Keep them in Models & Roles / AI Providers.
- **A:** `nyxara.workspace.selectedRoot` selects the workspace passed to Core. Keep in Workspace.
- **C:** Process-local `planningProfiles` and `engineeringRules` registry definitions affect Core planning/review/repair, but are not independently persisted VS Code workflow preferences. No profile/rule persistence is added by this phase.
- Outside the workflow-config classification: persisted `modelMode` controls the client editor; `nyxara.history.retention` controls client storage rather than Core stages. Context, Permissions, auth, history and Performance ownership are unchanged.

## Data flow, atomicity, and active workflows

1. Read effective `nyxara.workflow` from VS Code. Its contributed default is `{}`; missing values resolve through existing Core defaults. The Webview supplies no defaults.
2. Project typed values, labels and existing numeric bounds. Render native checkbox/number controls under **Workflow Settings**, grouped in compact Repair/Validation/Review disclosures. Fixed behavior is separately under **Current Capabilities**.
3. A change posts a small `updateWorkflowSettings` patch. Strict allowlists reject unsupported keys, coercions, arrays, nulls, nonfinite/fractional/out-of-range numbers and prototype-pollution keys. Core validators check supported limits.
4. Serialize Workflow saves, merge against freshly read persisted values, validate the complete result, and use the existing `updateSettingsAtomic` infrastructure for **one object write**. Related changes cannot partially commit. Prefer the effective workspace override if one exists; otherwise use User settings. All other config keys remain untouched.
5. Refresh the projection after the write, or refresh the previous values on persistence failure. The changed control waits for the authoritative response. No extension/window reload is required for settings changes.
6. `NyxaraSession.generate` snapshots resolved settings for the new task. Regeneration/approval/resume of that task preserve this snapshot. Saving while planning, awaiting approval, executing, paused, or waiting for permission only affects subsequently generated tasks.
7. The existing `runApprovedPlan` entry point accepts the existing `validation`, `repairLimits`, and `reviewerLimits` pipeline config paths as optional overrides and copies them into its runtime. Each scheduled task receives the same snapshot through `runTaskPipeline`, which already forwards these options to validation/review/repair. `allowRepair` uses its existing runtime snapshot. Constructor defaults, omitted-option behavior, workflow transitions, scheduling, approval, and loop algorithms are unchanged.

This optional forwarding is persistence plumbing, not a new workflow engine. No Webview state is consulted by Core. No provider replacement or session/Core recreation is needed.

Opening or editing this page only reads local configuration and existing in-memory Settings metadata (including cached model metadata and local SecretStorage presence). It triggers **no provider request, model discovery, repository scan, Git/process, validation run, polling, or timer**. The existing live-stage clock stops when Settings is shown.

## Deterministic verification

- `apps/vscode/test/workflow-settings.test.ts`: Core defaults, sparse effective values, boolean/numeric controls, no invented enum/approval field, exact manifest/control paths, boolean/numeric/shape validation, serialization.
- `apps/vscode/test/settings-projection.test.ts`: immediate current values and unchanged unrelated sections.
- `apps/vscode/test/activation.test.ts`: opening idle/zero timers and work, atomic save/reload/failure, concurrent patches, workspace override scope, malformed messages, unchanged provider/model/execution/permissions/rules/context/history/auth/Performance state, active-session preservation.
- `apps/vscode/test/session.test.ts`: generate-time snapshot survives regeneration/approval/resume; next task reads updated configuration.
- `packages/core/test/runtime-control.test.ts`: existing pipeline options remain an isolated snapshot across all tasks and pause/resume.
- `apps/vscode/test/webview-runtime.test.ts`: editable values, typed changes/acknowledgement, read-only capabilities/no approval toggle, search terms, no idle messages/timers.
- `apps/vscode/test/webview-layout.test.ts`: real-browser Workflow layout alongside existing Settings scenarios at 320/340/360/480/720 px and 13/16 px fonts, with all Workflow disclosures expanded.

Release verification commands: `npm run build`, `npm run vscode:test`, `npm test`, benchmark TypeScript check, `git diff --check`, and `npm run vscode:dogfood`. Installation/version/hash results are recorded in the task result after these commands complete.

## Verified release

- Workspace build and all workspace TypeScript projects: passed.
- `tools/benchmark/tsconfig.json --noEmit` and Webview JavaScript syntax: passed.
- VS Code suite: **413 passed**, including real-browser responsive layouts.
- Full regression: **760 passed across 69 files**.
- `npm run vscode:dogfood`: built the VSIX, force-installed it, and verified `nyxara.nyxara-vscode@0.1.0-alpha.25`.
- Archive integrity and embedded manifest/Workflow schema: verified.
- Artifact: `dist/vscode/nyxara-vscode-0.1.0-alpha.25.vsix`.
- SHA-256: `72ca37a0c9e2fa79ec63cd1486929242ca3ae2a04c7d82b4f371cb90d5e3890e`.
- Reload the VS Code window once to load the updated extension code. Subsequent Workflow preference saves do not require a reload.
