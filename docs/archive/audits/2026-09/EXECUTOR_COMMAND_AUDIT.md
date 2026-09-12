# Executor command execution — alpha.32

## Observed failure

The local September 7, 2026 task `5359a38b-cadd-47de-90ed-1b857601096b`
failed at T1, “Capture baseline metrics using planet-compare.py”. Its Executor
made two provider calls and requested one tool. The historical record does not
retain that tool's name or output; it cannot establish which call failed.

The repository does establish a capability mismatch: Executor advertised eight
file/search/Git tools, but not `run_command`, although the default Core registry
already implements that tool, its process runtime, and permission policy. A task
requiring a local script could not use this existing capability. No provider or
model change can add a tool missing from the advertised Executor toolset.

Separately, the target monorepo's root `package.json` declares pnpm but has no
scripts. Validation discovers supported root scripts only. The real run skipped
all four steps and failed in Core; History incorrectly inferred “passed” from
the presence of step rows. `apps/web/package.json` has lint/build scripts, but
Core does not automatically select that package or recursively validate it.

## Changes

- Expose the existing `run_command` to Executor and repair turns. Use separate
  executable/argv, workspace-root cwd, `shell: false`, and existing permissions.
- Validate inputs before command permission or process execution. Reject unknown
  fields, invalid strings/argv, NUL, non-integer/non-finite limits, timeouts above
  30 minutes, output above 1 MiB, and executable/argv JSON above 16 KiB. The
  existing defaults remain 30 seconds and 256 KiB; longer scripts must explicitly
  request a timeout within the bound.
- Preserve allow/ask/deny policy, plan approval, cancellation, pause/resume, task
  limits, and repair limits. Do not add retries or bypass denied operations.
- Show executable, all arguments, and cwd in the transient permission card.
  Allow Once applies to the exact pending operation. A command is a local process,
  **not an OS sandbox**; approving an interpreter or script can permit effects
  beyond the workspace. Never treat cwd as filesystem isolation.
- Compare bounded Git evidence before/after command calls, including already-dirty
  tracked files. Do not attribute pre-existing unrelated changes to the command.
  Refuse command execution when complete bounded Git evidence is unavailable.
- Treat nonzero command exit as a tool failure, not successful completion. A
  different successful command cannot erase that failure. Preserve tool metrics
  for structured failed Executor results and safe command/validation outcome logs.
- Surface concrete pipeline failure information instead of only “Task failed”.
  Use authoritative validation status in live and reloaded History; skipped-only
  legacy records without authoritative status are unavailable, not passed.

## Boundaries and remaining limitations

No credentials, provider routes, models, execution profiles, workflow settings,
or files in the user's target project are changed by this fix. No real task is
approved or retried, no provider request is needed for tests, and no workflow
stage or validation gate is removed.

The target workspace still needs deliberate validation setup: root scripts for
the intended package, an appropriate package workspace, or explicit Core
validation-command configuration through a host that supports it. This release
does **not** guess monorepo commands or mark missing validation as successful.
The current VS Code Workflow UI does not expose custom command arrays.

Command output remains bounded tool evidence, not persisted history. Full
command argv appears only in the current permission projection, not task-history
summaries or safe logs. Git-derived change evidence does not inspect ignored
artifacts, prove changes to existing untracked-file contents, or isolate concurrent
user edits. No new guarantee of OS/process sandboxing is introduced.

Deterministic tests cover command advertisement/execution, real workflow permission
waiting/one-time continuation, denied/dangerous commands, malformed input, nonzero
exit, unrelated-success masking, generated/dirty-file Git evidence, validation
failure reporting, reload correction, and literal command-card rendering.
