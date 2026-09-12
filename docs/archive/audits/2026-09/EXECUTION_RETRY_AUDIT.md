# Executor recovery audit — alpha.34

> [!WARNING]
> Historical document retained for engineering and research provenance.
>
> This document describes a previous Nyxara alpha baseline. It is not the
> current product direction or the canonical architecture specification.
> See `../../../ARCHITECTURE.md` and `../../../ROADMAP.md`.

**Status:** Historical

## Observed failure versus inference

The retained extension log records workflow `d1af0df5-b3b0-47d3-a926-2100174be01f` entering Planning, Approval, Running, Executing, then failing with `invalid_model`. The previously inspected history recorded an approved eleven-task plan and no completed Executor generation. The user subsequently cleared local history; it is not restored or reconstructed by this change.

The old error code is ambiguous: Core emitted it when a configured model was absent from discovery, and the compatible adapter also emitted it for generation HTTP 404. No completed-generation usage record does **not** prove that no HTTP request was attempted. The retained log cannot establish which branch caused this particular incident. A later read-only `/models` request returned HTTP 200 and included all four inspected configured/routed IDs. That proves only current discovery availability, not historical or future generation availability. Model quality is not established by these failures.

Two concrete client problems were identified:

- The failed-task button always sent `retryPlanning`, discarded the live presentation, and started another Planner request even after plan approval.
- Every role required membership in a newly fetched discovery list, despite the compatible-provider UI supporting exact manual IDs and unsupported discovery endpoints.

## Recovery boundaries

Core owns `retryWorkflowExecution`. The Webview sends only workflow, plan, and task identities. The session checks the current retained plan; Core rechecks workflow ownership, explicit approval, the approval fingerprint, terminal failure, non-aborted runtime, and retained failed-task state. Concurrent or stale messages cannot start a second retry. Arbitrary `failed -> running` transitions and `resumeWorkflow` on failed workflows remain illegal; the workflow engine has a separate guarded manual recovery operation.

Recovery reuses the scheduler, approved plan object, completed task set, usage history, and pipeline-settings snapshot. It clears the previous terminal error/result and unblocks the scheduler, then retries only the interrupted Executor task. That task rebuilds context from the current workspace. Completed tasks are not executed again. Existing per-attempt Executor limits remain; this is one explicit user-requested attempt, not an automatic retry loop. Automatic Repair budgets are not reset because recovery is not offered after this task enters Validation/Review/Repair.

Current role-model selections are used on the explicit retry, matching existing Core role lookup semantics. Changing the selected Executor after a failure therefore does not require replanning. The action does not write provider, model, execution-profile, permission, workflow, or credential settings. Active provider protections are restored for the retry. Normal permission requests, pause/resume, abort, Validation-first authority, and Review remain enforced.

Partial repository changes remain in place. Already-applied commands are not guaranteed idempotent, and may be issued again for the failed task; the UI warns about this. Known tool changes and counts survive an exception and are included in the cumulative workflow result. This is not rollback or an OS process sandbox. Provider requests that fail without usage still have unavailable token/cost data, not invented zero usage.

## Gateway model resolution

The optional Provider SDK `resolveModel(modelId, executionOptions)` lets an adapter own model resolution. Other providers retain exact discovery checks. The compatible adapter preserves an explicit route ID and does not substitute, strip prefixes, or infer a fallback model. Provider Default resolution is local. Official OpenAI still uses its discovery check. A saved non-default execution profile whose capability metadata is not cached triggers the existing bounded discovery path before generation; its fields remain validated rather than silently dropped or guessed.

The generation endpoint remains authoritative about whether an explicit gateway route can actually execute. HTTP errors, timeouts, authentication failures, empty/truncated responses, and invalid tool output are still rejected. No real generation request, hidden fallback, retry timer, or provider configuration change is added. Explicit model discovery in Settings is unchanged.

Executor failure events/logs now distinguish `model_resolution`, `generation`, `tools`, and `response`; safe HTTP status codes distinguish actual upstream rejection from a local catalog check. No raw response, authorization header, or credential is logged. Persisted HTTP 404 errors get route/endpoint-specific UI copy instead of only “Choose another model.”

## Tests and limitations

Deterministic tests cover same-plan retry with a corrected model, completed-task preservation, fresh context after partial writes, cumulative tool evidence, unchanged workflow settings and approval, duplicate/stale/malformed requests, approval tampering, permission waiting, pause/resume, abort, and evicted/missing runtime. VS Code tests exercise protocol, session, projection, button routing, history cleanup, and idle behavior. Fake HTTP/SSE transports exercise real provider-factory → Planner → Approval → failed Executor → explicit retry → native tools → Validation → Reviewer flow with HTTP 404 and 502, preserving every requested model ID and making no `/models` call in Provider Default mode.

These are deterministic fixtures, not a claim that a live routed model completed the user's task. The only live diagnostic in this phase is a read-only model-list request. No user task is approved, retried, or aborted automatically. On extension activation, the newest valid failed-Executor recovery for an open workspace is restored as a dormant failed runtime; execution still requires an explicit **Retry Execute** action.

Recovery is retained in memory and as a bounded exact local record for a failed approved Executor attempt. Credential-shaped text in the requirement or approved plan disables persistence instead of writing it to history. Ordinary history summaries still omit executable task descriptions and cannot reconstruct an approved runtime. Draft/awaiting-approval plans and Validation/Review/Repair failures are not restart-recoverable. Missing root validation commands in a monorepo remain a separate configuration issue; no validation check is bypassed or guessed.
