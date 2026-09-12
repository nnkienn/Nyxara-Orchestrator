# Nyxara Orchestrator

Nyxara is a research alpha investigating token-efficient, provider-agnostic, local-first orchestration of long-horizon software-engineering tasks.

```text
Plan → Approve → Execute → Validate → Review → Repair
```

The research objective is to test whether orchestration can reduce expected token cost per successful task against a fair direct-agent baseline. That is a hypothesis, not a demonstrated product claim.

## Project status

- Root package: `nyxara@0.0.1-alpha.3`, private.
- CLI package: `@nyxara/cli@0.0.0`, private.
- VS Code extension: `nyxara-vscode@0.1.0-alpha.39`, local dogfood only; there is no Marketplace release.
- Workspace packages are private `0.0.0` packages under the pnpm workspace.
- License remains `TBD`; public source availability does not by itself grant permission to reuse or redistribute the project.

## What works today

The TypeScript Core coordinates Planner, Executor, deterministic Validation, Reviewer, and bounded Repair. It owns workflow state, plan approval, dependency-aware task scheduling, pause/resume/abort and permission waits. Repository tools (search, read, write, patch, Git status/diff, and permission-gated commands) run locally through the tool registry. Usage events retain provider-reported, estimated, or unavailable token/cost data without inventing missing values.

Roles are independently assigned to provider configuration IDs, exact model IDs, and execution settings. Provider adapters currently include OpenAI-compatible, Anthropic, Gemini, and subscription CLI adapters for Codex, Claude Code, and Gemini CLI. The catalog also supports configured OpenAI-compatible routes and local Ollama, LM Studio, and local OpenAI-compatible endpoints. See [Provider Contract](docs/PROVIDER_CONTRACT.md).

## Current context limitation

Context selection is bounded by fixed file/byte budgets and Executor safety limits. The current default Executor limits include 48 KiB estimated input per request, 256 KiB total estimated input per attempt, 16 provider calls, and bounded retained context. A large task can therefore stop at a hard context/total-input error. Simply raising the window or rejecting more tasks is not the intended research endpoint.

The following are not implemented: adaptive context budgeting, Context Ledger, role-specific working-view projection, checkpoint continuation across exhausted budgets, repository intelligence graph, and conditional specialist-agent routing. Multi-agent execution is not assumed to save tokens; a specialist should be enabled only when controlled benchmarks show benefit greater than coordination overhead. See [Context Management](docs/CONTEXT_MANAGEMENT.md) and [Roadmap](docs/ROADMAP.md).

## Research direction

The sole future-direction document is [docs/ROADMAP.md](docs/ROADMAP.md). It defines the D1/N0–N4 experiment sequence, capability-derived budgets, recoverable context, continuation, repository intelligence, and conditional specialists. Proposed architecture must not be read as current behavior.

## Development from source

Requirements: Node.js `>=20` and the repository's pnpm package manager (`pnpm@10.15.0`). Run commands from the repository root:

```sh
npm run build
npm test
npm run vscode:build
npm run vscode:test
```

The workspace is defined by `pnpm-workspace.yaml` and contains `apps/*` and `packages/*`. There is no public npm package to install globally; do not use `npm install -g` or `npx` for Nyxara.

## CLI

The CLI is a private source workspace package. Build it with `pnpm --filter @nyxara/cli... build`; its entrypoint is `apps/cli/dist/index.js`. The CLI uses an OpenAI-compatible adapter and reads `NYXARA_OPENAI_BASE_URL` plus `NYXARA_OPENAI_API_KEY` from the environment. Commands implemented by `apps/cli/src/index.ts` include:

```text
run [prompt] [--profile <id>]       approved plan flow
plan [prompt] [--profile <id>]      create and optionally approve a plan
execute [prompt] [--profile <id>]   execute the first ready task
inspect [prompt]                    inspect selected repository context
validate                            run local validation
review [prompt]                     review a workspace
repair [prompt]                     run repair flow
profiles                            list planning profiles
rules [id]                          list or inspect engineering rules
pause|resume|abort <workflowId>     process-local runtime controls
```

The CLI does not provide a persistent cross-process workflow registry; pause/resume/abort across restarts fail rather than pretending to control a missing workflow.

## VS Code local dogfood

The extension manifest is `apps/vscode/package.json` (`0.1.0-alpha.39`). Build, package, and install the local VSIX with `npm run vscode:dogfood`, then run **Developer: Reload Window** when no workflow is active. Configure providers under **Settings → AI Providers**, assign exact models under **Settings → Models & Roles**, submit a requirement, inspect the generated plan, choose **Approve & Run**, handle Core permission cards, and inspect validation/review/repair. See [apps/vscode/README.md](apps/vscode/README.md) and [docs/DOGFOOD.md](docs/DOGFOOD.md).

## Architecture and repository layout

Current architecture is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The source layout is:

```text
apps/cli/                 private interactive CLI
apps/vscode/              local VS Code client
packages/core/            workflow, planning, execution, context, validation, review, repair
packages/provider-sdk/    provider/model contracts
packages/providers/       provider adapters and catalog
packages/tools/           permission-gated repository/Git/process tools
packages/shared/          shared workflow and usage types
tools/benchmark/          local benchmark harness and reporters
docs/                     current, proposed, and historical documentation
```

Clients render Core state; they do not own orchestration logic. Provider-specific transport stays in adapters, while Core remains provider-neutral.

## Benchmark status

Run the existing harness with `npm run benchmark:local -- --quick` or `--full`. It provides fake-provider synthetic workload scenarios, opt-in real-provider `real-plan`/`real-workflow` smoke scenarios, process/memory sampling, latency/timeline data, workflow/tool/context counters, and provider usage when available. Reports are written under `benchmark-results/<run-id>/`.

The current `compare` command compares duration and memory fields only. It does not yet execute a direct-agent D1 baseline or establish success-normalized token/monetary savings. D1, N0, N1, N2, N3, and N4 are research labels, not all implemented modes. See [tools/benchmark/README.md](tools/benchmark/README.md) and [docs/BENCHMARKING.md](docs/BENCHMARKING.md).

## Documentation map

- [Documentation index](docs/README.md)
- [Current architecture](docs/ARCHITECTURE.md)
- [Research roadmap](docs/ROADMAP.md)
- [Research method](docs/RESEARCH.md)
- [Benchmarking](docs/BENCHMARKING.md)
- [Context management](docs/CONTEXT_MANAGEMENT.md)
- [Provider contract](docs/PROVIDER_CONTRACT.md)
- [VS Code dogfood](docs/DOGFOOD.md)
- [Historical archive](docs/archive/README.md)

## Security and credentials

Model output is untrusted input. Repository writes and commands pass through the application-level permission engine; this is not an operating-system sandbox. API credentials stay in environment variables, VS Code SecretStorage, or the official provider CLI's own session store. Nyxara does not read cached CLI tokens. Do not include prompts, source, diffs, raw provider responses, authorization headers, or secrets in issues or benchmark reports. Report security problems privately before public disclosure.

## Contributing

Contributions should preserve provider neutrality, local credential ownership, deterministic validation, explicit permissions, bounded execution, and reproducible measurements. Read the [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md), and proposed [ADRs](docs/adr/README.md) before changing a boundary. Benchmark claims must include failures and identify whether usage is provider-reported, estimated, or unavailable.

## License

License: **TBD**. The project has not selected a license, and this remains a blocker before a public release or invitation to redistribute.

## Tóm tắt tiếng Việt

Nyxara hiện là research alpha mã nguồn công khai về điều phối agent local-first, độc lập provider, cho tác vụ kỹ thuật phần mềm dài hạn. Core đã có Plan/Approve/Execute/Validate/Review/Repair, nhưng adaptive context, Context Ledger, continuation và specialist routing vẫn là hướng nghiên cứu. Chưa có benchmark D1 hoàn chỉnh và chưa có bằng chứng Nyxara rẻ hơn direct agent; license vẫn TBD.
