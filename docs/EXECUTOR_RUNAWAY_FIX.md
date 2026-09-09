# Executor runaway loop audit and fix

## Root cause

The former Executor loop used one `maxToolCallsPerTask=25` counter for reads,
searches, mutations, and commands, plus `maxModelTurnsPerTask=8`. Every response
and every raw tool result was appended to one attempt-local conversation and the
entire conversation was sent again on the next provider call. A successful tool
call did not influence any progress/stuck state because no such state existed.
Equivalent searches and file ranges were executed repeatedly. Consequently, a
task could spend 22 successful calls collecting duplicate evidence, reach the
blunt ceiling before its first patch, resend hundreds of thousands of cumulative
input tokens, and finish with no changed files.

## Loop contract

The Executor now has separate bounded counters for read/search, mutation, and
validation commands. `maxToolCallsPerTask` remains the final hard safety ceiling;
it is no longer the normal convergence mechanism. Provider calls are budgeted
separately. The compatibility `maxModelTurnsPerTask` setting maps to that provider
budget when supplied.

Each normalized request has a deterministic fingerprint. Equivalent searches,
file ranges, and failed/no-progress commands are not re-executed at the same
workspace revision. The model receives a structured deduplication result. New
paths, matches, file content, changed files, and validation results reset progress
streaks. Several no-progress rounds stop with:

`Executor stalled: repeated tool activity produced no new evidence.`

Search result count, read bytes, command output, individual tool results, retained
evidence, complete provider request bytes, and estimated input tokens are all
bounded before generation. Command output keeps the relevant tail. Read/search
results retain structured paths and best matches rather than an unbounded raw
payload.

## Context and retry

Only the latest assistant/tool exchange is passed as provider conversation.
Older useful results move into a bounded, superseding evidence store; duplicate,
obsolete, and no-result evidence is dropped. The current prompt contains only the
approved task contract, relevant engineering rules, selected task context,
current progress/change state, and compact useful evidence. Full Planner context
and raw Planner history are not copied.

Target paths and symbols in the approved task are expanded through the existing
safe ContextEngine when Planner did not preload them. Permission and workspace
path enforcement remain owned by the existing tool layer.

Retry Execute creates a new attempt-local evidence session and deliberately omits
the stale Planner bundle for the failed task. It preserves workspace changes and
completed task state, rebuilds targeted context from the current workspace, and
never persists or replays the old tool conversation.

## Zero-change semantics

New plans declare `executionMode` per task. An explicit `implementation` task that
claims completion with zero changed files becomes an Executor failure, so
Validation, Review, and Repair are not run against an absent implementation. A
retry may legitimately complete without an additional write when a relevant
partial change is already present. An explicit `read_only` task may complete with
zero changes and skips mutation validation/review. Plans created before this
field existed retain their legacy zero-change behavior.

## Deterministic scenario

The no-network regression scenario uses a multi-step approved task, 30 read
requests across six evidence rounds, one patch, and a final completion. It also
references a target file that is absent from Planner's supplied bundle.

Legacy simulation (old 25-call ceiling):

- provider calls: 6
- tool calls: 25
- request context bytes by round: 3,542; 23,021; 38,910; 59,610; 80,310; 101,010
- estimated input tokens by round: 886; 5,756; 9,728; 14,903; 20,078; 25,253
- duplicate evidence removed: 0
- files changed: 0

New loop:

- provider calls: 8
- tool calls: 31 (30 read, 1 mutation)
- request context bytes by round: 6,366; 25,863; 42,299; 63,191; 72,451; 73,671; 73,915; 74,828
- estimated input tokens by round: 1,592; 6,466; 10,575; 15,798; 18,113; 18,418; 18,479; 18,707
- duplicate evidence removed: 1
- files changed: 1

The exact numbers are asserted/emitted by
`packages/core/test/executor-loop-control.test.ts`; they are deterministic fixture
measurements, not a target token quota.
