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

- **OpenAI Codex (ChatGPT) — subscription:** uses the official `codex` CLI session. Choose **Sign In with Browser** to run `codex login`, or reuse an existing Codex login. **Refresh Models** reads the current account catalog and reasoning values through the official Codex App Server; exact IDs are not maintained in Nyxara. ChatGPT plan limits apply; no OpenAI API key is requested.
- **Claude Code (Claude account) — subscription:** uses the official `claude` CLI session. Choose **Sign In with Browser** to run `claude auth login`, or reuse an existing Claude Code login. **Refresh Models** performs the Claude Agent SDK `supportedModels()` initialization handshake without sending a prompt, then displays the exact account-supported selector values and provider-reported effort controls. Nyxara does not scrape Claude Code's credential store or terminal picker.
- **Gemini CLI (Google account) — subscription:** uses the official `gemini` CLI. Choose **Sign In with Browser**, complete the CLI's provider-owned browser flow, then let the task finish; Nyxara updates automatically. Google/Gemini CLI limits apply; no Gemini API key is requested.
- **OpenAI — Official Provider:** open the official API-key page or enter an existing OpenAI API key. The official endpoint is supplied automatically; normal setup never asks for a Base URL.
- **Anthropic / Claude — Official Provider:** open the official API-key page or enter an existing Anthropic API key. The official endpoint is supplied automatically; normal setup never asks for a Base URL.
- **Google Gemini — Official Provider:** open Google AI Studio or enter an existing Gemini API key. The official endpoint is supplied automatically.
- **Kimi — Official Provider:** enter a Kimi API key. **Refresh Models** calls Kimi's provider-owned OpenAI-compatible model-list endpoint and preserves every returned ID exactly.
- **GLM / Zhipu — Official Provider:** enter a GLM API key. **Refresh Models** calls GLM's provider-owned model-list endpoint and preserves every returned ID exactly.
- **OpenAI-compatible — Compatible Gateway:** optionally name the configuration, enter its Base URL, and provide an API key only if required.
- **Ollama, LM Studio, or Local OpenAI-compatible — Local Provider:** use the localhost preset or enter a local endpoint. Nyxara does not install, start, download, or expose a local runtime.

For official providers, **Open official API key page** launches the provider's own developer console in your default browser. Sign in there, create or copy a key, return to VS Code, and paste it into Nyxara. This shortcut is not OAuth: Nyxara never reads browser cookies, web sessions, desktop/CLI tokens, localStorage, or account passwords. Provider authentication is not a Nyxara account; Nyxara remains a local BYOK orchestration layer.

Subscription CLI login is different: **Sign In with Browser** launches only the documented provider CLI login command as a visible VS Code task. The official CLI opens the browser and stores/refreshes its own session. While that active attempt runs, the sidebar shows **Waiting for browser sign-in…** and **Cancel**. A successful CLI process completion is checked through the provider-owned status contract and updates Nyxara to **Connected** immediately—no sidebar or VS Code reload is required. Nyxara then opens **Models & Roles** inside the sidebar with the discovered models so you choose the model and effort/thinking setting there; it does not silently accept the first model or open a VS Code top-bar model picker. Attempts are one-time and bounded; cancellation, denial, failure, and timeout preserve the previous Nyxara configuration. Nyxara never opens CLI credential files. **Test connection** runs only `codex login status`, `claude auth status`, or `gemini --version`; it does not call a model. If a CLI is missing, use **CLI installation help** and install it explicitly—Nyxara never performs a silent global install.

CLI model turns run from a fresh temporary directory. Claude built-in tools are disabled; Codex is ephemeral/read-only and ignores project rules; Gemini runs in plan mode with no pre-approved tools. Models return tool requests to Nyxara, and Nyxara Core remains responsible for repository access, permissions, validation, and review.

After API credentials are saved, Nyxara makes at most one explicit onboarding request to the provider-owned model-list endpoint and asks for one default model. The discovered account-specific list is cached as bounded, non-secret metadata under that provider configuration. That exact provider/model selection is applied to Planner, Executor, and Reviewer. OpenAI, Anthropic, Gemini, Kimi, GLM, compatible gateways, Ollama, and LM Studio discover from their configured provider/account endpoint; Codex subscription discovers through the official Codex App Server and Claude subscription through the official Claude Agent SDK initialization contract. If discovery is unavailable—including CLI integrations whose supported status contract does not expose a model catalog—use the official CLI's provider-managed default alias or choose **Enter model ID manually**. Routed IDs, resource prefixes, versions, snapshots, and CLI selector values are preserved exactly.

For a manually verified compatible-gateway example only:

```text
Provider type: OpenAI-compatible
Model ID: ha-op/gpt-5.6-sol
```

This route is not hardcoded, not a default, and not presented as official OpenAI. Never put a real API key in this file or an issue report.

## Manage providers

Use the header **Settings** button, then **AI Providers**, to connect another provider/account, switch the default, update one credential, run a non-generating connection test, edit a compatible/local endpoint, sign out/disconnect, or remove a provider. Multiple configurations—including multiple accounts for the same adapter—coexist under stable local IDs.

Credentials are stored only under provider-config-scoped VS Code SecretStorage keys. Settings contain non-secret local configuration such as display name, adapter type, Base URL, and requested model IDs. **Disconnect** for an API-key provider asks for confirmation and deletes only the selected credential Nyxara owns. **Sign Out** for an official CLI subscription marks only the Nyxara provider configuration signed out; Nyxara neither reads nor revokes the external CLI account session. Both actions preserve provider configuration, model/role references, task history, and repository files. Those role references render unavailable and are never silently rerouted. **Remove Provider** is a separate stronger confirmation that deletes the selected non-secret configuration and scoped credential while preserving task history and historical provider/model summaries. Stored secret values are never displayed or included in diagnostics.

Use **Settings → Models & Roles → Simple** to choose one provider, exact model ID, and execution setting for Planner, Executor, and Reviewer. The discovered choices and manual exact-ID fallback share one model input. **Provider Default** is the normal and upgrade-safe execution setting: Nyxara sends no optional reasoning or thinking override and lets the provider apply its own behavior.

Use **Settings → Models & Roles → Advanced** only when needed. Advanced mode independently selects a configured provider, exact model ID, and execution profile for Planner, Executor, and Reviewer, validates the complete selection, then commits all roles together. Simple and Advanced are real tabs; only one editor is shown at a time so model and effort controls are not duplicated. Repair continues to use Executor's model and execution profile because that is the current Core capability.

**AI Providers** contains connection state and lifecycle actions only: sign-in, credentials, test, Refresh Models, endpoint metadata, disconnect/sign-out, and removal. Model/role/execution editing lives only in **Models & Roles**. The compact model label beside the task composer is read-only and opens **Models & Roles** instead of changing configuration in place.

Execution controls are model-specific and come from explicit discovery metadata first, then versioned adapter-maintained provider-contract metadata. Known OpenAI models may expose their supported reasoning-effort values. Known Claude models expose Anthropic thinking with a bounded token budget. Known Gemini models expose either a thinking budget or Gemini-native thinking levels. The sidebar consumes this projected schema and does not define reasoning/thinking values. Unknown/new models and generic OpenAI-compatible/local endpoints remain visible but show **Provider Default** only; transport compatibility does not imply reasoning support. If a saved choice is no longer supported after changing a provider or model, Nyxara marks it stale and requires **Use Provider Default** or another valid selection rather than silently translating it.

Opening these settings never probes capabilities or refreshes models. **Refresh Models** makes one provider/account-scoped discovery request and updates the open sidebar immediately. A failed refresh preserves the last safe cache and offers manual model-ID entry. After an extension reload, cached models remain visible as **Cached** with their last refresh time, while connection status is honestly **Connection unknown** until an explicit test or refresh. There is no auth, model, capability, or provider-health polling. Execution profile summaries contain no prompts, native request payloads, credentials, or hidden reasoning. Nyxara does not automatically route models or tune reasoning/thinking settings.

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
9. Inspect the completion/failure card and choose **View Performance** for the local detailed projection, then choose **New Task**.

The normal task flow stays entirely inside Nyxara; the Command Palette and InputBox are retained only for accessibility, power-user commands, debugging, and exceptional setup choices. For the first run, use a small reversible task such as **“Add a small pure utility function and unit tests.”** Use the inline **Abort** action to stop an active workflow. Existing repository edits remain for inspection; abort does not discard them.

Planner output remains schema-validated, but Nyxara safely normalizes common provider variations such as a JSON fence or surrounding prose, one `plan` wrapper, snake_case field names, and string-versus-array criteria before validation. Task content, acceptance criteria, unique IDs, dependency references, and an acyclic graph remain mandatory. If a model still returns an invalid plan, the failure identifies the first safe field rather than displaying a generic error, and the terminal card offers **Try Again** plus **Choose Model** without requiring the requirement to be retyped.

When several workspace folders are open, Nyxara asks you to choose the target before planning. With no open workspace, provider setup remains available but task submission is disabled. **New Task** resets only the current sidebar presentation after completion, failure, or abort; it does not remove providers, stored workflow history, or repository changes, and it never silently stops an active workflow.

## Local task history

The home screen shows the five most recent tasks, prioritizing the current workspace. Choose **View all** or the header **History** action to search task titles and requirements, filter by Active/Completed/Failed/Interrupted, switch between the current workspace and all local workspaces, and open a previous structured timeline. History navigation stays inside the Nyxara sidebar and never starts another provider call.

Task history is stored only in VS Code's local extension storage. It defaults to 50 sessions (with bounded 20/50/100 choices in Settings) and contains the requirement plus bounded structured summaries—not API credentials, provider responses, source files, diffs, tool output, or validation logs. Common credential-shaped fragments are redacted even when they appear inside otherwise allowed summary text. Workspace records use a display name and a stable hash instead of showing the absolute local path. There is no account, cloud sync, telemetry upload, AI title generation, or semantic search.

Use **Delete Task** in a terminal task detail to remove only that local history record. Use **Clear History** on the History screen to remove terminal records while preserving an active task. Both actions require native confirmation and never touch repository files, provider configuration, or SecretStorage.

If VS Code reloads while a workflow is non-terminal, the old projection is marked **Interrupted** because this version does not persist or fake workflow resume. Its timeline remains readable and explains that it cannot resume automatically. While an authoritative in-process workflow is active, it continues when History is open; choose the active row or **Return to Active Task** to navigate back without duplicating execution.

## Performance

Terminal success, failure, and aborted task cards offer **View Performance** whenever authoritative usage exists. The view stays inside Nyxara and reads only the completed Core usage projection or its bounded local history copy. Opening it does not call a provider, refresh models, scan the repository, build context, run Git, or start background polling.

Performance opens with four readable facts: total tokens, elapsed/provider time, model calls, and cost. **Models used** lists only roles that actually participated; roles that never ran do not occupy empty cards. Task breakdown, model identity/provenance, timing, context/tools, quality/repair, and token/cost provenance remain available in collapsed detail groups. Entirely unavailable groups are omitted, and unknown individual measurements remain **-** only where they add context. Measured durations can overlap, so child timings are not presented as a stacked total. No prompts, source, diffs, tool arguments/results, validation logs, provider responses, hidden reasoning, thinking signatures, credentials, or headers are stored in Performance history.

Older alpha history remains readable. When it has only the previous compact summary, Nyxara states that detailed performance was not recorded and shows only the available totals. Historical Performance keeps safe provider display metadata, so it remains readable after Disconnect, Sign Out, or provider removal.

Do not compare quality using token count alone. Token volume, latency, tool activity, and cost are factual observations rather than a quality or efficiency score. Nyxara does not auto-optimize models, reasoning, thinking, or provider routing.

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

Skills, MCP, Hooks, Plugins, Marketplace, cloud sync, accounts/billing, pricing and budgets, automatic routing/tuning, graph UI, parallel execution, persistent workflow resume, and remote daemons remain deferred.
