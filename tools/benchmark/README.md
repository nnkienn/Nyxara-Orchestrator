# Nyxara benchmark harness

**Status:** Engineering benchmark (research instrumentation)

This harness measures local orchestration behavior and resource retention. It is not an end-to-end product-quality benchmark and does not prove token or monetary savings.

## What it runs

The default provider mode is `fake`. Synthetic workloads model context, planning, execution, validation, review, repair, and long-run retention without contacting a provider. Available scenarios in source are:

| Scenario | What it exercises |
| --- | --- |
| `idle` | Core idle memory baseline |
| `plan-only` | Context and draft planning without approval |
| `workflow` | Synthetic multi-stage workflow |
| `long-run`, `long-run-normal`, `long-run-mixed` | Repeated workflows and retention trend |
| `provider-matrix` | Fake role/provider capability matrix |
| `extension-idle` | Best-effort sampling of an already running VS Code Extension Host |
| `real-plan` | One real provider structured-plan smoke call |
| `real-workflow` | Real planner, executor tool call, fixture validation, and reviewer smoke calls |

`--realistic` selects the workload-oriented synthetic path; it does not turn fake providers into real agents. Real-provider scenarios require `--provider-mode real`, explicit provider/model configuration, and may incur provider usage or cost.

## Commands

Build and run from the repository root:

```sh
npm run benchmark:local -- --quick
npm run benchmark:local -- --full
node tools/benchmark/dist/cli.js run --scenario workflow --profile normal
node tools/benchmark/dist/cli.js run --realistic --profile repair-heavy --scenario repair-heavy
node tools/benchmark/dist/cli.js run --provider-mode real --scenario real-plan --planner-model <model-id> --yes
node tools/benchmark/dist/cli.js extension --quick
node tools/benchmark/dist/cli.js compare before/report.json after/report.json
```

Common flags include `--quick`, `--full`, `--realistic`, `--profile light|normal|heavy|repair-heavy`, `--scenario`, `--provider-mode fake|real`, `--planner-provider`, `--executor-provider`, `--reviewer-provider`, matching `--planner-model`, `--executor-model`, and `--reviewer-model` flags, `--label`, `--output`, `--keep-fixture`, `--quiet`, and `--yes`. Real mode prompts for confirmation unless `--yes` is supplied.

## Reports and metrics

Each run writes `benchmark-results/<benchmarkRunId>/report.json`, `report.csv`, `report.md`, `samples.csv`, and `environment.json` (or the directory supplied by `--output`). Reports contain scenario status, latency distributions, phase timelines, process/self or process-tree memory samples, repository classification, workload profile, provider/tool/context counters, validation/review/repair counters, plan approvals and permission counters, requested/resolved model metadata, and token usage where available. Fake runs label token usage `synthetic`; real runs preserve provider-reported usage or `unavailable`.

The generated Markdown report summarizes duration, RSS, environment, repository class, workload profile, real-provider smoke status, timelines, and warnings. It is not a quality score. Synthetic provider latency and synthetic tokens must not be compared with real-provider cost.

## Compare behavior

`compare <before> <after>` reads two JSON reports and returns deltas for:

- scenario duration median and p95;
- harness duration median;
- peak RSS, process-tree RSS, stabilized RSS, and retained RSS.

It warns about workload-profile and fake-versus-real provider-mode mismatches. It does not compare resolved-task success, Fix Rate, input/output/total token cost, repeated-input ratio, or monetary cost.

## Provenance and privacy

Reports include runner version (`10B.2`), timestamp, configuration, environment, repository statistics, scenario definitions, and warning/status metadata. Prompts, source contents, diffs, provider response bodies, tool arguments, and credentials are intentionally excluded. Real mode uses the public provider adapter and a temporary deterministic fixture; fixture cleanup is the default. Treat model IDs, endpoints, and usage as potentially sensitive before sharing reports.

## Research boundaries

This is the current engineering harness, not the proposed D1/N0–N4 evaluation. D1 (direct single-agent) is not implemented here; N0 is the current Nyxara baseline, while N1 adaptive budget, N2 Context Ledger, N3 continuation, and N4 conditional specialists are research targets, not available scenario modes. The harness also does not establish end-to-end production workflow quality or that Nyxara is cheaper than a direct agent. See [docs/BENCHMARKING.md](../../docs/BENCHMARKING.md) and [docs/ROADMAP.md](../../docs/ROADMAP.md).
