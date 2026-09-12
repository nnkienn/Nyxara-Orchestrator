# Nyxara for VS Code

**Status:** Research alpha / local dogfood

This extension is a thin VS Code client for the shared Nyxara Core. It is not a Marketplace product and is not production-ready. The manifest version is `0.1.0-alpha.39` in [`package.json`](package.json).

## Build and install locally

From the repository root:

```sh
npm run vscode:dogfood
```

This builds the workspace packages, runs the existing VS Code checks, packages a VSIX, and force-installs it through the local `code` CLI. Reload with **Developer: Reload Window** when no workflow is active. Use `npm run vscode:build` and `npm run vscode:test` for separate build/test checks.

## Daily workflow

Open the Nyxara activity-bar view, enter a requirement, generate and inspect the plan, choose **Approve & Run**, respond to Core permission cards, then inspect execution, validation, review, repair, changed files, and completion. Use **New Task** after a terminal outcome. History and Performance views are local bounded projections; opening them does not rerun providers or repository scans.

## Providers and roles

Supported catalog entries are:

- API providers: OpenAI, Anthropic/Claude, Google Gemini.
- OpenAI-compatible routes: Kimi, DeepSeek, GLM/Zhipu, OpenRouter, and custom gateways.
- Subscription CLI adapters: OpenAI Codex, Claude Code, and Gemini CLI.
- Local adapters: Ollama, LM Studio, and local OpenAI-compatible.

Configure a provider under **Settings → AI Providers**. Official API providers use API keys; subscription adapters use the provider-owned CLI login; local adapters use configured local endpoints. Nyxara does not install providers, read CLI token files, or silently replace a missing provider. Under **Settings → Models & Roles**, choose an exact model ID and execution setting. Simple assigns one selection to Planner, Executor, and Reviewer; Advanced assigns them independently.

## Approval, permissions, and state

Plan approval is an explicit gate before the approved-plan workflow. Repository writes and commands go through Core's application-level permission engine. This is not an operating-system sandbox. Validation runs before AI review; bounded repair can return to execution/validation/review and stops on configured limits or no-progress conditions. Pause, resume, abort, and permission waiting are current workflow controls, not persistent budget continuation.

## Credentials and connection state

API keys are stored only in VS Code SecretStorage under provider-configuration-scoped keys; non-secret provider settings remain in VS Code configuration. Official CLI credentials remain owned by the CLI. Disconnect/sign-out affects only the selected Nyxara configuration and does not revoke an external account session. After reload, connection states such as credential present, session recorded, CLI configured, signed out, unavailable, and unknown remain distinct. `unknown`/“Live status not yet verified” is intentional when no explicit verification was performed. Gemini CLI's version-only check proves installation, not authentication.

## Diagnostics and troubleshooting

Use **Test Connection**, **Refresh Models**, and the in-sidebar diagnostics/performance views explicitly; activation and reload perform no background provider, Git, process, or repository work. Record only safe error codes, status, timings, model IDs, and bounded counters. Never record prompts, source, diffs, raw provider output, headers, or credentials. For a failed task, preserve repository changes, inspect the permission/validation/review evidence, then abort or reload only when safe. See the [local dogfood guide](../../docs/DOGFOOD.md) for a concise checklist.

## Known limitations

- Adaptive context budgeting is not implemented; current context and Executor limits are fixed safety/cost controls and can stop large tasks.
- Context Ledger, role-specific working-view projection, repository intelligence graph, and checkpoint continuation are not implemented.
- Resume is in-process workflow state control, not a general persistent continuation across an exhausted context budget or process restart.
- The direct-agent D1 benchmark is incomplete; the extension does not establish that Nyxara is cheaper than direct chat or any provider.
- Conditional specialist-agent routing is not implemented, and multi-agent does not inherently reduce token use.

## More documentation

- [Current Core architecture](../../docs/ARCHITECTURE.md)
- [Research roadmap](../../docs/ROADMAP.md)
- [Benchmarking](../../docs/BENCHMARKING.md)
- [Dogfood operations](../../docs/DOGFOOD.md)
- [Provider contract](../../docs/PROVIDER_CONTRACT.md)
- [Historical audits](../../docs/archive/README.md)
