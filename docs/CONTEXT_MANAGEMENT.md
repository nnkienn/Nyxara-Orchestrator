# Context management

**Status:** Current + Proposed
**Last reviewed:** 2026-09-12
**Canonical for:** Context limits, evidence projection, and migration

## Current

`ContextEngine` selects a bounded set of repository files from the requirement, search terms, Git status/diff, and targeted paths/symbols. Defaults are fixed (for example eight files, 128 KiB total, and 24 KiB per file), while Executor sessions also enforce provider-call, input, output, evidence, tool, and progress ceilings. Provider adapters can report `ModelInfo.contextWindow`, but current Executor budgeting does not yet derive its working budget from that capability.

The terminal context failure occurs when a request cannot fit the remaining cumulative input allowance. This is a hard safety guard against runaway cost, but currently acts as a capability ceiling: a long task can fail even when a safe continuation or smaller projection could proceed.

## Hard safety to retain

Keep workspace/path boundaries, permission checks, command timeouts/output bounds, file and tool argument limits, secret handling, duplicate/no-progress protection, and the selected provider's actual per-request context boundary. Unknown or stale capability data must be labeled and handled conservatively.

## Proposed cost policy and capabilities

Roadmap Phase 2 moves cumulative tokens, provider calls, retained context, and expansion count from terminal product ceilings toward adaptive policy targets. A capability-derived budget reserves output, tool schemas, provider overhead, and safety margin from the discovered context window; unknown capability uses a documented conservative estimate. This is experimental/planned, not current behavior.

## Planned Context Ledger and working view

Phase 3 proposes an append-only task-scoped ledger for observations, symbols, dependency edges, tool results, decisions, patches, validation/review evidence, checkpoints, lineage, and usage. Large payloads remain addressable outside the prompt. A deterministic projector builds role-specific working views and targeted retrieval recovers evicted evidence without destroying ground truth. See [ROADMAP §4.2–4.4](ROADMAP.md#42-context-ledger).

## Checkpoint and continuation

Phase 4 proposes checkpointing contract, repository revision, changed files, verified decisions, unresolved work, next action, evidence pointers, and usage. A fresh continuation view can proceed after a soft budget boundary while total usage remains visible. This is not implemented in the current code; current pause/resume is workflow state control, not budget continuation.

## Migration: N0 → N4

N0 freezes current fixed behavior. N1 adds capability-derived budgeting, N2 adds the ledger and projections, N3 adds checkpointed continuation, and N4 adds conditional specialists only after measured benefit. Each step is an evidence gate; details and exit criteria are canonical in [ROADMAP §7](ROADMAP.md#7-phased-implementation-roadmap).
