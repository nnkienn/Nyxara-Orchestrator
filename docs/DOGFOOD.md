# Nyxara Alpha local dogfood

## Install and update

From the repository root, run:

```sh
npm run vscode:package
code --install-extension dist/vscode/nyxara-vscode-0.1.0-alpha.1.vsix --force
```

Then run **Developer: Reload Window**. Repeating those commands builds and updates the locally installed dogfood version; uninstall is not normally required. You can instead choose Extensions, the `...` menu, **Install from VSIX...**, and select the file under `dist/vscode/`.

Use F5 only for development and debugging in an Extension Development Host. Use the VSIX for ordinary daily dogfood.

## Configure and run

Installation and activation do not need an API key and safely show **Provider: Not configured**. To start:

1. Open VS Code and a repository folder.
2. Open the Nyxara activity-bar view and choose **Configure Provider**.
3. Enter the user-provided OpenAI-compatible base URL and API key.
4. Enter independent Planner, Executor, and Reviewer model IDs.
5. Run **Nyxara: Test Provider Connection**. This calls the provider's model-listing endpoint over the network, but does not generate text or start a workflow.
6. Choose **New Task: Generate Plan**, enter a task, and review the structured plan.
7. Choose **Approve & Run**, or **Reject Plan** if the plan is unsuitable.

The base URL and role model IDs are ordinary VS Code user settings. The API key is stored only in VS Code SecretStorage; it is not written to `settings.json`, workspace/global state, logs, workflow snapshots, or the VSIX. A routed ID such as `ha-op/gpt-5.6-sol` has been manually verified with an OpenAI-compatible setup, but it is only an example and is not a default.

For the first run, use a small, reversible task: **“Add a small pure utility function and unit tests.”** Avoid migrations, deployments, authentication changes, and destructive work until the basic flow is trusted.

Use **Nyxara: Abort** to stop an active workflow. Existing repository edits remain for inspection; abort does not discard them.

## Reporting issues

Record the daily log below and attach the exact Nyxara command, workspace type, role model IDs, visible error, expected behavior, actual behavior, and severity to the project issue report. Never include API keys or authorization headers. Include a minimal reproduction when practical.

## Daily log template

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

## Seven-day checklist

- [ ] Day 1: small source edit
- [ ] Day 2: multi-file task
- [ ] Day 3: test failure and repair scenario
- [ ] Day 4: existing larger repository
- [ ] Day 5: permission-sensitive action
- [ ] Day 6: different model/provider if available
- [ ] Day 7: longer session plus extension reload/restart

## Severity

- P0: data loss, security failure, workspace escape, or credential leak
- P1: unusable workflow, repeated crash, or invalid permission handling
- P2: important UX or provider compatibility issue
- P3: polish

Marketplace release requires zero open P0 and zero open P1 findings. Documented P2 findings may remain. Marketplace publishing, Open VSX, other IDEs, graph and full chat UI, parallel execution, budgets, routing/pricing, cloud accounts, telemetry, automatic updates, remote daemon, and new persistence are deferred.
