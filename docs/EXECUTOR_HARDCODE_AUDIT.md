# Executor hardcode audit

Scope: Executor execution, its tool contracts, automatic repair attempts, CLI
tool envelopes, usage accounting, and explicit Execute retry. Planner retrieval,
UI controls, and unrelated provider/model settings are intentionally unchanged.

## Executor limits and branches

| File + symbol | Current value / behavior | Consumer | Classification | Contribution before this change |
| --- | --- | --- | --- | --- |
| `executor-limits.ts` / `DEFAULT_EXECUTOR_LIMITS` | 96 total requested tools; 72 read; 16 mutation; 12 validation; 16 provider calls | `ExecutorSession`, `Executor.runInternal` | Configurable Executor setting with hard ceilings | The ceilings themselves are legitimate. Repeated/invalid requests consumed the total budget without reconcilable outcomes; provider turns also lacked a cumulative token bound. |
| `executor-limits.ts` / byte and token defaults | 24 KiB/result; 256 KiB/arguments; 64 KiB retained evidence; 192 KiB/request; 32 KiB initial-context carry-over; 48 Ki estimated tokens/request; 256 Ki estimated/reported input/attempt | Prompt construction, tool validation, session accounting | Configurable Executor setting | Before: 48 Ki tokens was per request only, so 16 rounds permitted 768 Ki tokens and the complete initial context was resent. Direct cause of 700K+ cumulative input. |
| `executor-limits.ts` / search and conversation defaults | 20 search results; 256 KiB searched file; directory depth 4; assistant carry-over 2 KiB | Dynamic tool schema, validator, conversation compactor | Configurable Executor setting | These values were duplicated in normalizers/schema and malformed values were silently clamped. Contributed to invalid-argument ambiguity and oversized/repeated evidence. |
| `executor-limits.ts` / `EXECUTOR_SAFETY_CEILINGS` | 512 tools/category; 64 provider calls; 64 KiB/result; 1 MiB/arguments; 256 KiB evidence; 512 KiB/request and total input; 128 KiB carry-over/request tokens; bounded search/depth/message/stall values | `resolveExecutorLimits` | Hard safety invariant | Prevents embedding clients from converting configuration into unlimited execution or context. |
| `executor-limits.ts` / `EXECUTOR_LIMIT_MINIMA` | Positive integer limits plus 1 KiB result/argument/evidence, 16 KiB request, 4 KiB carry-over/request/total tokens, 256-byte assistant text | `resolveExecutorLimits` | Safety invariant | Rejects nonsensical configuration rather than creating hidden fallbacks. |
| `executor-limits.ts` / `EXECUTOR_COMPACTION_POLICY` | 4 KiB minimum context, 8 KiB minimum shrink step, 1/5 diff share, 512-byte result envelope reserve, 0.7 string shrink ratio | Context/result compaction | Safety invariant / internal algorithm | Former literals were scattered through `executor.ts` and `executor-session.ts`; not the primary failure but obscured ownership. |
| `executor-session.ts` / `prepareBatch` | Exact total/category preflight; calls are validated first; duplicate fingerprints include repository revision for reads/validation | Executor tool loop | Safety invariant | Old accepted-call counting did not represent rejected batches and semantic argument errors reached tools. Tool-limit and metrics mismatch contributor. |
| `executor-session.ts` / duplicate handling | Same normalized call in a round or revision is not executed; an untruncated file already in the context actually sent this round is not reread | Executor tool loop | Safety invariant / no-progress policy | Directly addresses repeated `read_file`/`search_code` calls and duplicate evidence. Current-context refresh removes the stale “file is still present” assumption after compaction. |
| `executor-session.ts` / stuck detection | 6 consecutive no-progress calls or 3 no-progress model rounds | Executor tool loop | Configurable Executor setting | Prevents repeated calls from running until the global tool ceiling. Contributed to prior tool-limit failures. |
| `executor-session.ts` / provider accounting | At most 16 calls and at most 256 Ki estimated or provider-reported cumulative input per attempt | Executor provider loop | Configurable limit plus safety ceiling | New cumulative guard closes the 16 × 48 Ki = 768 Ki gap. |
| `executor-session.ts` / evidence store | Replacement by evidence key, 24 KiB/item, 64 KiB total, oldest-first eviction | Prompt builder | Configurable setting | Prevents raw tool history accumulation and repeated evidence. |
| `executor-session.ts` / command category words | `build`, `check`, `eslint`, `jest`, `lint`, `pytest`, `ruff`, `test`, `tsc`, `typecheck`, `vitest` | Category counter | Internal provider-neutral heuristic | Does not grow context; can only choose which configured category ceiling applies. |
| `executor.ts` / provider loop | First round may use the bounded task context; later rounds compact initial context to 32 KiB; only the latest assistant/tool exchange is carried | Provider adapters | Safety invariant / Executor policy | Direct fix for per-round replay of initial context and raw trajectory growth. |
| `executor.ts` / request preflight | Measures the complete serialized request (prompt, dynamic tools, latest exchange, execution options), drops oldest evidence, compacts regular/repair context, then rejects if it cannot fit | Provider adapters | Safety invariant | Direct fix for 700K+ growth and for repair prompts that previously could not be reduced by compacting `ContextBundle` alone. |
| `executor.ts` / final provider-turn branch | A tool batch returned on turn 16 is not executed because no response turn remains | Executor loop | Safety invariant | Can cause a provider-call-limit failure; now those non-executed requests are included in invalid/rejected accounting. |
| `executor.ts` / read-only mutation branch | Rejects the whole batch before execution | Executor loop | Safety invariant | Not a reported root cause; now accounted as requested but not executed. |
| `executor.ts` / tool metrics | `requested = executed + invalid`; `executed = successful + failed`; duplicate and guard-rejected calls are invalid/non-executed; by-name counts executed calls | Events and workflow usage | Domain contract | Direct fix for requested/executed/invalid mismatch. |
| `executor-tools.ts` / dynamic definitions + runtime schemas | Strict per-tool object schemas; unknown/additional/wrong-type/range/non-serializable/oversized arguments return `invalid_tool_arguments` without permission or execution; rejected raw arguments are not replayed | Model tool advertisement, `ExecutorSession` | Tool contract | Direct fix for invalid arguments. Replaces the accidental “object is valid enough” check and silent clamping. |
| `executor-tools.ts` / result-related defaults | Missing search/read/command/diff limits receive resolved Executor defaults; supplied invalid limits are rejected, never clamped | Tool execution | Configurable Executor setting | Removes accidental hardcodes and makes advertised/runtime behavior identical. |
| `executor.ts` / compact historical call | Write/patch bodies and any oversized argument object are replaced by byte metadata; assistant text uses configured 2 KiB bound | Provider conversation | Safety invariant | Prevents mutation payloads or malformed arguments from being replayed. |
| `task-execution-store.ts` / retention | 10 plans, 200 tasks/plan; only newest terminal task retains full result | Executor result store | Safety invariant, configurable at store construction | Does not affect provider input; prevents old execution evidence accumulating in memory. |

## Adjacent contracts consumed by Executor

| File + symbol | Value / behavior | Consumer | Classification | Contribution |
| --- | --- | --- | --- | --- |
| `repair-orchestrator.ts` / `DEFAULT_REPAIR_LIMITS` | 3 repair cycles, 3 Executor attempts (hard max 5), 4 validation, 4 review, 1 context expansion, 64 KiB evidence, 48 KiB diff, 6 history entries, stuck threshold 2 | Automatic repair | Configurable repair-domain setting with hard attempt ceiling | Bounds automatic Executor attempts. It was already in the correct domain and was not moved into Executor or UI. |
| `internal/byte-limits.ts` / `EXECUTION_DIFF_MAX_BYTES` | 256 KiB complete Git evidence | Initial/final Executor Git verification and command before/after evidence | Safety invariant | Not sent as raw conversation evidence; does not cause 700K input. |
| `task-context-selector.ts` / `DEFAULT_TASK_CONTEXT_BUDGET` | 6 files, 96 KiB total, 24 KiB/file | Executor context resolver when Planner context exists | Context-domain setting | Bounds the initial source context before Executor request preflight. Left unchanged because it is shared context policy. |
| `context-engine.ts` / default budget | 8 files, 128 KiB, 24 KiB/file | Fresh context build, including Retry Execute | Context-domain setting | Ensures Retry rebuild starts bounded; Executor applies its own complete-request and cumulative bounds afterward. |
| `run-command-tool.ts` + `local-execution-runtime.ts` / command limits | Runtime defaults 30 seconds/256 KiB output; tool hard maxima 30 minutes/1 MiB output and 16 KiB executable+args | Tool domain and Executor schema | Tool-domain defaults and hard safety contracts | Executor supplies its tighter 24 KiB output default. The 16 KiB argument bound was duplicated in Executor; it is now exported once and consumed by the runtime validator and advertised schema. |
| `read-file-tool.ts`, `search-*.ts`, `list-directory-tool.ts` | Read default 64 KiB/hard 1 MiB; search default 100/hard 1000, 1 MiB/file, 240-character previews; directory default depth 1/hard 10 | General ToolRegistry callers | Tool-domain contracts | Executor intentionally supplies tighter 24 KiB/20/256 KiB/depth-4 values and bounds the complete result again. General defaults were not a 700K contributor. |
| `write-file-tool.ts`, `apply-patch-tool.ts` | Write max 1 MiB; patch max 256 KiB; large-change permission threshold 64 KiB; patch check/apply 15 seconds and 64 KiB command output | General ToolRegistry and Executor mutation calls | Tool-domain safety/permission contracts | Executor caps the complete argument envelope at 256 KiB and compacts mutation bodies before the next provider round. These legitimate limits remain in the tool domain. |
| `git-status-tool.ts`, `git-diff-tool.ts`, `git-runtime.ts` | Status 256 KiB; diff default 256 KiB/hard 1 MiB; Git command timeout 15 seconds | Git evidence collection | Tool-domain safety contracts | Executor requests 24 KiB for model-visible `git_diff`; initial/final correctness verification uses the separate 256 KiB Core execution-evidence bound and rejects truncated evidence. |
| `cli-subscription-provider.ts` / response envelope | Schema-capable CLIs emit `argumentsJson`; parser also accepts direct object `arguments`; malformed argument JSON is preserved as unknown input for Executor validation | CLI subscription providers then Executor | Provider-specific wire contract | Direct CLI assumption fix. Structural envelope errors remain provider errors; semantic tool arguments are now counted/returned by Executor. |
| `cli-subscription-provider.ts` / process limits | 180 seconds and 8 MiB output | CLI subprocess | Provider safety invariant | Bounds transport output, not Executor request context. Left in provider domain. |
| `orchestrator.ts` / Retry Execute | `retryContextTaskId` suppresses the stale Planner bundle; `resolveExecutorContext` rebuilds from current workspace; `Executor.run` creates a new attempt-local session | Explicit user retry | Recovery contract | Prevents replay of the old raw trajectory. New tests also assert no conversation and bounded rebuilt request. |

## Root causes

- Context growth: per-request but no per-attempt token ceiling, full initial context
  replayed each round, and repair evidence was not reducible through the generic
  context compactor.
- Tool arguments: only `typeof arguments === object` was checked; wrong fields,
  types, ranges, and oversized values were silently defaulted/clamped or reached
  tool permission/execution. CLI parsing also required one argument envelope
  representation.
- Metrics: `toolCalls` counted accepted requests, duplicates disappeared from all
  outcomes, rejected batches were omitted, and executed was inferred only from
  success/failure. The counters therefore described different populations.

The corrected invariants are:

```text
requested tool calls = executed tool calls + invalid/non-executed tool calls
executed tool calls  = successful tool calls + failed tool calls
estimated input per attempt <= configured cumulative limit <= hard ceiling
```
