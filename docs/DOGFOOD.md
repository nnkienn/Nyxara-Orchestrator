# Nyxara Alpha local dogfood

## Install and update

From the repository root, run the canonical local update command:

```sh
npm run vscode:dogfood
```

It builds the required packages, runs the deterministic VS Code checks, derives the VSIX name from `apps/vscode/package.json`, packages it, and installs it through the local `code` CLI with `--force`. It does not publish, open a provider connection, or require credentials. When it completes, run **Developer: Reload Window** in VS Code. Existing VS Code settings and SecretStorage entries survive a normal force-install update.

The extension manifest at `apps/vscode/package.json` is the single source of truth for the local dogfood version. **Nyxara: About** and the sidebar show that installed manifest version with the **Local Dogfood** label. Use F5 only for development/debugging in an Extension Development Host; use the VSIX for daily dogfood.

## Connect a provider

Installation and activation do not need credentials and make no network, provider, repository, workflow, Git, process, or benchmark calls. On first run the Nyxara workspace shows **Connect an AI provider to start** and an inline **Connect Provider** action. Provider setup may still use native VS Code pickers in this phase; ordinary coding tasks do not.

Choose one of the adapters currently implemented:

- **OpenAI Codex (ChatGPT) — subscription:** uses the official `codex` CLI session. Choose **Sign in with ChatGPT** to run `codex login`, or reuse an existing Codex login. ChatGPT plan limits apply; no OpenAI API key is requested.
- **Claude Code (Claude account) — subscription:** uses the official `claude` CLI session. Choose **Sign in with Claude** to run `claude auth login`, or reuse an existing Claude Code login. Claude plan limits apply; no Anthropic API key is requested.
- **Gemini CLI (Google account) — subscription:** uses the official `gemini` CLI. Choose **Sign in with Google**, complete the CLI's browser flow, then reconnect using the existing login. Google/Gemini CLI limits apply; no Gemini API key is requested.
- **OpenAI — Official Provider:** open the official API-key page or enter an existing OpenAI API key. The official endpoint is supplied automatically; normal setup never asks for a Base URL.
- **Anthropic / Claude — Official Provider:** open the official API-key page or enter an existing Anthropic API key. The official endpoint is supplied automatically; normal setup never asks for a Base URL.
- **Google Gemini — Official Provider:** open Google AI Studio or enter an existing Gemini API key. The official endpoint is supplied automatically.
- **OpenAI-compatible — Compatible Gateway:** optionally name the configuration, enter its Base URL, and provide an API key only if required.
- **Ollama, LM Studio, or Local OpenAI-compatible — Local Provider:** use the localhost preset or enter a local endpoint. Nyxara does not install, start, download, or expose a local runtime.

For official providers, **Open official API key page** launches the provider's own developer console in your default browser. Sign in there, create or copy a key, return to VS Code, and paste it into Nyxara. This shortcut is not OAuth: Nyxara never reads browser cookies, web sessions, desktop/CLI tokens, localStorage, or account passwords. Provider authentication is not a Nyxara account; Nyxara remains a local BYOK orchestration layer.

Subscription CLI login is different: Nyxara launches only the documented CLI login command in a visible VS Code terminal. The official CLI opens the browser and stores/refreshes its own session. Nyxara checks login status through official commands where available and never opens credential files. **Test connection** runs only `codex login status`, `claude auth status`, or `gemini --version`; it does not call a model. If a CLI is missing, use **CLI installation help** and install it explicitly—Nyxara never performs a silent global install.

CLI model turns run from a fresh temporary directory. Claude built-in tools are disabled; Codex is ephemeral/read-only and ignores project rules; Gemini runs in plan mode with no pre-approved tools. Models return tool requests to Nyxara, and Nyxara Core remains responsible for repository access, permissions, validation, and review.

After credentials are saved, Nyxara tests the non-generating model-list endpoint and asks for one default model. That exact provider/model selection is applied to Planner, Executor, and Reviewer. If discovery is unavailable, choose **Enter model ID manually**. Routed IDs are preserved exactly.

For a manually verified compatible-gateway example only:

```text
Provider type: OpenAI-compatible
Model ID: ha-op/gpt-5.6-sol
```

This route is not hardcoded, not a default, and not presented as official OpenAI. Never put a real API key in this file or an issue report.

## Manage providers

Use the header **Settings** button, then **AI Providers**, to connect another provider/account, switch the default, update one credential, run a non-generating connection test, edit a compatible/local endpoint, sign out/disconnect, or remove a provider. Multiple configurations—including multiple accounts for the same adapter—coexist under stable local IDs.

Credentials are stored only under provider-config-scoped VS Code SecretStorage keys. Settings contain non-secret local configuration such as display name, adapter type, Base URL, and requested model IDs. **Disconnect** for an API-key provider asks for confirmation and deletes only the selected credential Nyxara owns. **Sign Out** for an official CLI subscription marks only the Nyxara provider configuration signed out; Nyxara neither reads nor revokes the external CLI account session. Both actions preserve provider configuration, model/role references, task history, and repository files. Those role references render unavailable and are never silently rerouted. **Remove Provider** is a separate stronger confirmation that deletes the selected non-secret configuration and scoped credential while preserving task history and historical provider/model summaries. Stored secret values are never displayed or included in diagnostics.

Use **Settings → Models & Roles → Simple** to choose one provider, exact model ID, and execution setting for Planner, Executor, and Reviewer. **Provider Default** is the normal and upgrade-safe execution setting: Nyxara sends no optional reasoning or thinking override and lets the provider apply its own behavior.

Use **Settings → Models & Roles → Advanced** only when needed. Advanced mode independently selects a configured provider, exact model ID, and execution profile for Planner, Executor, and Reviewer, validates the complete selection, then commits all roles together. Repair continues to use Executor's model and execution profile because that is the current Core capability.

Execution controls are model-specific and come from local adapter/catalog metadata or explicit discovery metadata. Known OpenAI models may expose their supported reasoning-effort values. Known Claude models expose Anthropic thinking with a bounded token budget. Known Gemini models expose either a thinking budget or Gemini-native thinking levels. Unknown models and generic OpenAI-compatible/local endpoints show **Provider Default** only; transport compatibility does not imply reasoning support. If a saved choice is no longer supported after changing a provider or model, Nyxara marks it stale and requires **Use Provider Default** or another valid selection rather than silently translating it.

Opening these settings never probes capabilities or refreshes models. Use **Refresh Models** or **Test Connection** explicitly when needed. Execution profile summaries contain no prompts, native request payloads, credentials, or hidden reasoning. Nyxara does not automatically route models or tune reasoning/thinking settings.

## Settings Center

The Settings Center stays inside the Nyxara sidebar and uses Back/Home navigation plus local keyword search. Opening it performs local projection reads only: it does not contact providers, discover models, scan the repository, build context, run Git, start a workflow, or poll. Provider testing and model discovery happen only after an explicit action.

Workflow, planning profiles, engineering rules, permission policy, context, validation, review, repair, and usage screens project existing Core behavior; they do not reimplement precedence or expose a security bypass. History retention is bounded to 20, 50, or 100 and is enforced immediately while preserving active work. Workspace labels omit absolute home paths. Privacy-safe diagnostics contain only extension/provider/model/workflow/storage metadata.

## Run a task

1. Open VS Code and a repository folder.
2. Open the Nyxara activity-bar view.
3. Type a multiline requirement in **What do you want to build?** at the bottom of the sidebar.
4. Choose the arrow **Generate Plan** action, or press Ctrl/Cmd+Enter.
5. Review the structured plan inline, including acceptance criteria, dependencies, and risks.
6. Choose **Approve & Run**, or **Reject** if the plan is unsuitable.
7. Watch execution tasks, Validation, Review, and Repair progress inline.
8. If Core requests a sensitive permission, choose **Allow Once** or **Deny** on the inline permission card.
9. Inspect the completion/failure card and Core usage totals, then choose **New Task**.

The normal task flow stays entirely inside Nyxara; the Command Palette and InputBox are retained only for accessibility, power-user commands, debugging, and exceptional setup choices. For the first run, use a small reversible task such as **“Add a small pure utility function and unit tests.”** Use the inline **Abort** action to stop an active workflow. Existing repository edits remain for inspection; abort does not discard them.

When several workspace folders are open, Nyxara asks you to choose the target before planning. With no open workspace, provider setup remains available but task submission is disabled. **New Task** resets only the current sidebar presentation after completion, failure, or abort; it does not remove providers, stored workflow history, or repository changes, and it never silently stops an active workflow.

## Local task history

The home screen shows the five most recent tasks, prioritizing the current workspace. Choose **View all** or the header **History** action to search task titles and requirements, filter by Active/Completed/Failed/Interrupted, switch between the current workspace and all local workspaces, and open a previous structured timeline. History navigation stays inside the Nyxara sidebar and never starts another provider call.

Task history is stored only in VS Code's local extension storage. It defaults to 50 sessions (with bounded 20/50/100 choices in Settings) and contains the requirement plus bounded structured summaries—not API credentials, provider responses, source files, diffs, tool output, or validation logs. Common credential-shaped fragments are redacted even when they appear inside otherwise allowed summary text. Workspace records use a display name and a stable hash instead of showing the absolute local path. There is no account, cloud sync, telemetry upload, AI title generation, or semantic search.

Use **Delete Task** in a terminal task detail to remove only that local history record. Use **Clear History** on the History screen to remove terminal records while preserving an active task. Both actions require native confirmation and never touch repository files, provider configuration, or SecretStorage.

If VS Code reloads while a workflow is non-terminal, the old projection is marked **Interrupted** because this version does not persist or fake workflow resume. Its timeline remains readable and explains that it cannot resume automatically. While an authoritative in-process workflow is active, it continues when History is open; choose the active row or **Return to Active Task** to navigate back without duplicating execution.

## Reporting issues

Record the command, workspace type, requested role model IDs, visible error, expected/actual behavior, and severity. Never include API keys, tokens, cookies, authorization headers, or secret-bearing URLs.

### Daily log template

- Date:
- Workspace type:
- Task:
- Provider/model roles:
- Outcome:
- Validation:
- Review:
- Repair cycles:
- Approx duration:
- UX issue:
- Provider issue:
- Bug:
- Severity: P0 / P1 / P2 / P3

Detailed Performance UI, Skills, MCP, Hooks, Plugins, Marketplace, cloud sync, accounts/billing, pricing and budgets, automatic routing/tuning, graph UI, parallel execution, persistent workflow resume, and remote daemons remain deferred.
