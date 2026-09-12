# Nyxara architecture

**Status:** Current
**Last reviewed:** 2026-09-12
**Canonical for:** Architecture currently implemented in the repository

This document describes the running TypeScript implementation. Proposed Context Ledger, checkpoint continuation, repository intelligence graph, and specialist routing are intentionally excluded from the current architecture; they are specified in [ROADMAP](ROADMAP.md).

## Current architecture

```text
CLI / VS Code clients
          │
          ▼
     Nyxara Core
          │
  ┌───────┼────────┬──────────┐
  ▼       ▼        ▼          ▼
Planner Executor Validation Reviewer
  │       │        │          │
  └───────┴────────┴──────────┘
          │
   Repair orchestrator
          │
  Provider registry ── provider adapters ── models
          │
  Tool registry ── permissions ── workspace/Git/process
```

`NyxaraOrchestrator` owns workflow coordination. It registers providers and role assignments, builds repository context, creates and validates plans, schedules dependency-aware tasks, executes tool calls through the tool registry and permission engine, runs deterministic validation, invokes the reviewer, and performs bounded repair. CLI and VS Code are clients of this Core rather than owners of workflow state.

### Workflow and task state

`WorkflowEngine` is the authority for legal status transitions and emits typed events through `EventBus`. Plans are stored in a plan runtime store and require explicit approval on the approved-plan path. Tasks carry dependencies, acceptance criteria, role assignment, attempts, and execution/validation/review/repair summaries. Pause, resume, abort, permission waiting, and retry are explicit state transitions; terminal state is not inferred from a client view.

### Context and execution

`ContextEngine` selects repository files using prompt, Git status/diff, search, and bounded byte/file budgets. Targeted expansion can request paths or symbols. The Executor creates bounded task-specific sessions, routes model turns through the provider registry, validates tool calls, and enforces independent tool, provider-call, output, evidence, and progress limits. Validation discovers and runs configured repository commands before review. Review receives bounded diff, validation, context, and rule evidence; repair reuses the existing Executor and remains validation-first.

### Providers, roles, and credentials

`AgentModelRegistry` maps the independent Planner, Executor, and Reviewer roles to provider configuration IDs, exact model IDs, and execution options. `ProviderRegistry` resolves adapters without provider-specific workflow branches. Adapters expose model catalogs/capabilities where available, including optional `contextWindow`; unknown capability is represented as unknown rather than guessed. Clients own local credential storage and provider lifecycle; Core receives provider interfaces, never secrets.

### Persistence and telemetry

Core keeps bounded workflow/task summaries, plan runtime state, validation/review stores, and usage records in process-owned stores. Events record stage, provider generation, tool, context, validation, review, repair, permission, and workflow outcomes. Usage can contain provider-reported or estimated token/cost fields; unavailable values remain unavailable. Client history is local and privacy-bounded.

## Current constraints

- Context selection is bounded and mostly fixed by file/byte budgets; it is not an adaptive capability-derived policy.
- A provider's per-request context boundary and Core's hard safety ceilings remain enforcement points.
- Tool execution is local and permission-gated; commands are not a general sandbox.
- Approval, validation-before-review, no-progress detection, and repair limits are runtime capabilities, not arbitrary client bypasses.
- Provider discovery, credentials, endpoints, and model IDs remain provider/client configuration concerns.

## Known limitations

There is no append-only Context Ledger, lossless external evidence projection, checkpointed continuation across exhausted budgets, repository graph, direct-agent baseline, or conditional specialist-agent scheduler in the current code. Existing benchmark tooling is opt-in and does not yet establish a lower successful-task cost than direct chat. See [BENCHMARKING](BENCHMARKING.md), [CONTEXT_MANAGEMENT](CONTEXT_MANAGEMENT.md), and [ROADMAP](ROADMAP.md).

## Planned architecture

Future architecture is deliberately maintained in one place: [ROADMAP.md](ROADMAP.md). This document must be updated only when that design is implemented and verified in code.
