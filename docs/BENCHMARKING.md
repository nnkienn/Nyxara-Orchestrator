# Benchmarking

**Status:** Current + Planned
**Last reviewed:** 2026-09-12
**Canonical for:** Benchmark inventory and benchmark contract

## Benchmark currently in the repository

The repository contains an opt-in local harness under [`tools/benchmark/`](../tools/benchmark/), invoked with `npm run benchmark:local`. Its current reports and fixtures focus on local orchestration measurements such as duration, memory, workflow/tool activity, and provider usage available from the configured run. It is useful infrastructure, but it does not yet execute a direct-agent D1 baseline, normalize success-adjusted cost, or prove that Nyxara is cheaper than direct chat. Missing provider usage must remain missing, not be replaced with zero.

## Planned benchmark contract

Every controlled comparison uses the same task, repository commit, model/provider, permissions, environment, and task order:

| ID | System | Purpose |
| --- | --- | --- |
| D1 | Direct single-agent | No-Nyxara baseline with identical model and tools |
| N0 | Current Nyxara | Fixed-budget control |
| N1 | Adaptive model budget | Capability-budget ablation |
| N2 | N1 + Context Ledger | Projection/recoverability ablation |
| N3 | N2 + continuation | Long-horizon continuation |
| N4 | N3 + conditional specialists | Measured multi-agent value |

Required metrics: resolved rate; input, output, and total tokens; outcome-adjusted token cost; monetary cost per successful task; repeated-input ratio; Fix Rate; latency; context pressure; provider and tool calls; and human intervention. Also report expansions, compactions, checkpoints, continuations, no-progress/coordination failures, time to first useful change, and unrelated-change rate. Never report raw token savings without resolved rate.

Task strata should cover localized bugs, multi-file features, preserving refactors, upgrades, exploration-heavy tasks, and repair-heavy tasks. The full experimental discipline and invalid-comparison rules live in [ROADMAP §6](ROADMAP.md#6-benchmark-contract); methods and validity are in [RESEARCH](RESEARCH.md).
