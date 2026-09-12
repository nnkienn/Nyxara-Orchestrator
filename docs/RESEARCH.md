# Research method

**Status:** Proposed
**Last reviewed:** 2026-09-12
**Canonical for:** Nyxara research methodology

The [ROADMAP](ROADMAP.md) owns product phases and hypotheses. This document owns how those hypotheses are tested.

## Questions and hypotheses

Research questions RQ1–RQ5 and H1–H5 are defined in [Roadmap §5](ROADMAP.md#5-research-questions-and-hypotheses). Do not restate the roadmap phases here; link to them when a phase supplies an intervention.

## Variables and comparisons

- Independent variables: system (D1/N0–N4), context policy, model capability budget, ledger/projection policy, continuation, specialist routing, provider/model, task stratum, and permission policy.
- Dependent variables: resolved rate, Fix Rate, input/output/total tokens, outcome-adjusted token and monetary cost, repeated-input ratio, latency, context pressure, provider/tool calls, and human intervention.
- Controlled variables: repository commit, task definition, model revision, provider settings, tool permissions, environment, prompt/configuration hashes, and task order.

Baseline and ablation definitions are canonical in [Roadmap §6](ROADMAP.md#6-benchmark-contract). D1 must use the same model and permissions as its paired Nyxara run.

## Experimental validity

Use paired runs, at least three pilot repetitions and preferably ten or more for final small/medium comparisons. Report median, dispersion, and 95% intervals; use paired bootstrap/permutation intervals and paired success analysis where appropriate. Keep a holdout task set and publish failures and incomplete trajectories rather than selecting favorable seeds. Mark usage as provider-reported, estimated, or unavailable.

## Reproducibility and privacy

Retain a privacy-safe manifest containing commit, task ID, model/provider identifiers, prompt/configuration hashes, seed, tool policy, budgets, usage source, and validation outputs. Large or sensitive payloads must be redacted or referenced, never copied into public artifacts. Check benchmark and dataset licenses before reuse.

## Publication artifacts

An eventual research release should include the preregistered plan, versioned tasks, baseline/ablation tables, analysis scripts, anonymized trajectories, failure taxonomy, limitations, threats to validity, and a reproducibility appendix. The publication-paper mapping and candidate foundations are listed in [Roadmap §12](ROADMAP.md#12-research-foundations-to-study).
