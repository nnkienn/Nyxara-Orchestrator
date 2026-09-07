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

Use **Settings → Models & Roles → Simple** to choose one provider, exact model ID, and execution setting for Planner, Executor, and Reviewer. The model dropdown shows the selected provider's entire discovered catalog without filtering by the current model. Choose **Enter model ID manually…** for an exact-ID text field; saved IDs remain selectable even if they are absent from discovery. If the catalog is empty, use **AI Providers → Refresh Models**. **Provider Default** is the normal and upgrade-safe execution setting: Nyxara sends no optional reasoning or thinking override and lets the provider apply its own behavior.

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

Completed, failed, aborted, and interrupted task cards offer **View Performance** whenever authoritative usage exists. A rejected task offers it only when real provider usage was recorded. The view stays inside Nyxara and reads only the completed Core usage projection or its bounded local history copy. Opening it does not call a provider, refresh models, scan the repository, build context, run Git, or start background polling.

Performance uses compact **Overview**, **Models & Roles**, **Latency**, **Context**, **Tools**, **Validation**, **Review**, **Repair**, and **Cost** sections. Roles that never ran and Repair without real evidence are omitted. Unknown values render as **-**, while an authoritative zero remains **0**. Measured durations can overlap, so child timings are not presented as a stacked total. No prompts, source, diffs, tool arguments/results, validation logs, provider responses, hidden reasoning, thinking signatures, credentials, or headers are stored in Performance history.

Older alpha history remains readable. When it has only the previous compact summary, Nyxara states that detailed performance was not recorded and shows only the available totals. Historical Performance keeps safe provider display metadata, so it remains readable after Disconnect, Sign Out, or provider removal.

Do not compare quality using token count alone. Token volume, latency, tool activity, and cost are factual observations rather than a quality or efficiency score. Nyxara does not auto-optimize models, reasoning, thinking, or provider routing.

# 7-Day Real Dogfood — alpha.20

This is an operational checklist and blank evidence template, not a test result. Use real repositories and real coding work, keep changes reviewable and reversible, and do not mark an item successful unless it was actually performed and observed. Never paste credentials, authorization headers, raw provider payloads, source, diffs, tool output, validation logs, hidden reasoning, or thinking signatures into this document.

## Before Day 1

- [ ] Confirm the installed extension is `nyxara-vscode@0.1.0-alpha.20` and reload VS Code.
- [ ] Choose one or more real repositories where changes can be reviewed, reverted, and tested safely.
- [ ] Record the starting Git state outside this document; do not attribute pre-existing changes to Nyxara.
- [ ] Confirm each provider/account used is authorized for dogfood and note any provider limits.
- [ ] Create a private daily log from the templates below. Keep secrets and raw payloads out of it.

## Seven-day plan

| Day | Focus |
| --- | --- |
| 1 | Basic onboarding, local request gates, and small tasks |
| 2 | Targeted bug fixes, tests, permissions, and Simple-mode switching |
| 3 | Normal feature work and Advanced role assignments |
| 4 | Validation, review, repair, abort, and failure recovery |
| 5 | Authentication, reload, history, and provider lifecycle |
| 6 | Multi-file refactor and Performance observation |
| 7 | Representative repeats and final assessment |

### Day 1 — Basic onboarding and small tasks

- [ ] Connect or verify one available browser/API/CLI-auth provider, explicitly run **Refresh Models**, and select a model in **Simple** mode.
- [ ] Submit a greeting/trivial input and an underspecified request; confirm both are handled locally and do not start an inappropriate workflow.
- [ ] Run one small real coding task and watch plan, live stage, elapsed time, streaming/fallback activity, validation, review, and terminal summary.
- [ ] Reject one unsuitable plan, verify **Rejected** is not **Failed**, choose **Edit Requirement**, and submit the revised requirement as a new task.
- [ ] Reopen the completed and rejected tasks from History; inspect historical Performance where provider usage exists.

### Day 2 — Targeted bug fixes and tests

- [ ] Fix one small real bug named by file, symbol, or narrow behavior; record whether targeted context was sufficient and bounded.
- [ ] Run one real test-writing task and assess acceptance criteria, test quality, validation status, and review quality.
- [ ] Exercise a legitimate permission prompt on a safe, reversible task; verify **Deny** and/or **Allow Once** affects only the pending action.
- [ ] Switch provider/model in **Simple** mode and run another small task; verify the displayed and executed provider/model are the selections made.
- [ ] Reopen both tasks from compact History and compare their persisted Performance without refreshing models.

### Day 3 — Feature implementation and multi-model roles

- [ ] Configure distinct Planner, Executor, and Reviewer assignments in **Advanced** mode, including execution profiles supported by those exact models.
- [ ] Implement one normal, reviewable feature with a clear user-visible outcome and repository tests.
- [ ] Verify Planner/Executor/Reviewer provider, requested/resolved model, and execution-profile attribution in Performance.
- [ ] Record plan quality, role-language consistency, reviewer strictness, and any hard-coded-feeling plan structure without changing prompts.
- [ ] Return to **Simple** mode and confirm it deliberately applies one provider/model/profile across the three configurable roles.

### Day 4 — Failure, validation, review, repair, and abort

- [ ] In a disposable branch or scratch repository, run a validation-failure exercise with a small safely seeded failing check; confirm the failure is identified without exposing raw logs.
- [ ] Run a review-finding exercise against a reversible fixture with a clear enabled engineering constraint; record the finding, or explicitly record that Review missed it.
- [ ] If validation or review triggers Repair, verify the cycle, Executor-profile reuse, revalidation, and final result; otherwise record “repair not observed” and retry on Day 7.
- [ ] Abort one active, reversible task; verify the workflow stops, partial Performance is honest, and no fake resume is offered.
- [ ] Inspect the repository and History afterward; confirm actual edits and terminal outcomes match what Nyxara reports.

### Day 5 — Auth, reload, history, and provider lifecycle

- [ ] Exercise browser or official CLI authentication where available; record cancellation/failure/retry behavior without recording credentials.
- [ ] Reload VS Code, reopen recent tasks, and confirm completed/rejected/aborted/interrupted history remains readable and compact.
- [ ] Open historical Performance before and after **Sign Out** or **Disconnect**; confirm it uses persisted data and makes no refresh/provider call.
- [ ] Reconnect the provider, explicitly run **Refresh Models**, and verify cached/current model state and the selected model remain understandable.
- [ ] If safe, remove a test provider configuration and confirm old task provider/model/profile summaries and Performance remain readable.

### Day 6 — Larger refactor and Performance observation

- [ ] Run one real multi-file refactor with explicit scope, invariants, and acceptance criteria.
- [ ] Review context mode, file count, bytes, truncation, and targeted expansions; flag context that is excessive or insufficient.
- [ ] Check live stage accuracy and provider-wait activity throughout the longer workflow; note every frozen-looking interval.
- [ ] Inspect role, latency, tool, validation, review, repair, cache, and cost data for internal consistency without assuming durations sum.
- [ ] Reopen the task from History after normal work or a VS Code reload and compare historical Performance with the terminal view.

### Day 7 — Representative repeats and final assessment

- [ ] Repeat one representative targeted task and one normal task using the most useful configuration from Days 1–6.
- [ ] Retry the highest-severity or least-observed scenario, especially validation/review/repair, permission, auth, or provider switching.
- [ ] Compare **Simple** and **Advanced** behavior only where both reflect real daily use; do not optimize from token count alone.
- [ ] Audit seven days of History, Rejected versus Failed outcomes, hidden unexecuted stages, and historical Performance trustworthiness.
- [ ] Complete the severity backlog, daily totals, unresolved-issue review, and **Final Dogfood Decision** below.

## Per-task record

Copy this block once for every real task. Use `-` for unavailable measurements and preserve an authoritative `0` as `0`.

### Task record — __________

- Task:
- Date:
- Provider / Model:
- Planner / Executor / Reviewer configuration:
- Outcome: [ ] PASS  [ ] FAIL  [ ] REJECTED  [ ] ABORTED

Planning:

- Context mode:
- Files:
- Bytes:
- Planning time:
- Planner tokens:

Execution:

- Provider calls:
- Tool calls:
- Executor tokens:
- Execution time:

Validation:

- Result:
- Duration:

Review:

- Result:
- Duration:

Repair:

- Cycles:
- Result:

Total:

- Input tokens:
- Cache read:
- Cache write:
- Output tokens:
- Processed tokens:
- Workflow duration:
- Provider-reported cost, if available:

UX notes:

- Confusing?
- Looked frozen?
- Too verbose?
- Too many clicks?
- Wrong stage?
- Wrong language?
- Plan quality?
- Reviewer quality?

- Issue severity: [ ] P0  [ ] P1  [ ] P2  [ ] P3  [ ] NONE
- Notes:

## Severity rules

### P0 — Stop dogfood and secure the workspace

- Data loss.
- Credential or security leak.
- Workspace escape.
- Destructive action without the correct permission.
- Unrecoverable corruption.

### P1 — Core capability blocker

- Core workflow cannot complete.
- Authentication is unusable.
- Wrong provider or model executes.
- Approval or permission handling is broken.
- Frequent crash or hang.
- Severe incorrect context behavior.

### P2 — Meaningful but recoverable problem

- UX friction or misleading status.
- Unnecessarily high token/context usage.
- History or Performance inconsistency.
- Recoverable provider issue.

### P3 — Polish

- Wording, visual spacing, or minor inconvenience.

Use **NONE** when no issue was observed. Record evidence even when the task itself succeeds.

## Feature freeze

During these seven days, do not implement Skills, MCP, Hooks, Plugins, automatic routing, model recommendations, automatic optimization, a pricing engine, Marketplace features, or unrelated product work.

Allowed fixes are P0, P1, and a very small obvious P2 only when it blocks meaningful dogfood. Keep every allowed fix narrow, add a regression test, and rerun the affected scenario. Put all other observations into **Dogfood Findings / Backlog**; do not “fix” Agent Language/Hard-Coded Behavior by adding more hard-coded prompts during dogfood.

## Special things to watch

### A. Context efficiency

- Check that small tasks do not unexpectedly consume the full `8 files / 128 KB` context budget.
- Record excessive context, missing relevant context, unnecessary targeted expansions, and truncation that harms the task.

### B. Plan quality

- Record too many/few tasks, wrong dependencies, irrelevant files, vague acceptance criteria, excessive verbosity, and rigidity inappropriate for the task type.

### C. Agent language / hard-coded behavior

- Record plan language that does not match the user, inconsistent reviewer language, wrong-language executor/user summaries, overly hard-coded plan formats, inappropriate reviewer strictness, and cases where Planner detail should differ.
- Collect evidence for the future Agent Behavior Profiles phase. Do not add hard-coded prompt fixes during this run.

### D. Live UX

- Check stage accuracy, elapsed timer behavior, visible streaming/fallback activity, and every provider wait that looks frozen.

### E. Tokens

- Check token fields for internal consistency. For Claude especially, verify that cache read/write values look plausible and distinguish unavailable from zero.

### F. Reject / History

- Verify Rejected is distinct from Failed, unexecuted stages stay hidden, rows stay compact, and old tasks reopen correctly.

### G. Performance

- Record whether Performance is understandable, internally consistent, useful, and not overwhelming. Never treat overlapping durations as an exact sum or infer cost from tokens.

## Daily summary

Complete one copy at the end of each day.

### Day ___ summary

- Tasks run:
- Successful:
- Failed:
- Rejected:
- Aborted:
- P0:
- P1:
- P2:
- P3:
- Worst UX issue:
- Highest-token task:
- Slowest task:
- Best workflow:
- Unexpected behavior:

## Dogfood Findings / Backlog

Do not include secrets or raw payloads. Link to a private issue with sanitized reproduction steps when more detail is needed.

| Date | Task | Severity | Finding and evidence | Disposition |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Reporting issues

Record the command, workspace type, requested role model IDs, visible error, expected/actual behavior, and severity. Never include API keys, tokens, cookies, authorization headers, or secret-bearing URLs.

Skills, MCP, Hooks, Plugins, Marketplace, cloud sync, accounts/billing, pricing and budgets, automatic routing/tuning, graph UI, parallel execution, persistent workflow resume, and remote daemons remain deferred.

# Final Dogfood Decision

- [ ] Any P0 unresolved?
- [ ] Any P1 unresolved?
- [ ] Any credential/security concern?
- [ ] Any workspace safety issue?
- [ ] Any provider/model correctness issue?
- [ ] Any workflow blocker?
- [ ] Context usage reasonable?
- [ ] Planner quality acceptable?
- [ ] Review quality acceptable?
- [ ] Repair useful?
- [ ] History trustworthy?
- [ ] Performance trustworthy?
- [ ] UX understandable without developer knowledge?
- [ ] Would I personally use Nyxara daily?

DOGFOOD RESULT: __________ (`PASS` / `FAIL`)

READY FOR AGENT BEHAVIOR PROFILES: __________ (`YES` / `NO`)

READY FOR MARKETPLACE READINESS: __________ (`YES` / `NO`)
