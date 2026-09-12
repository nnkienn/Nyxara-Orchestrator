# Local dogfood guide

**Status:** Current
**Last reviewed:** 2026-09-12
**Canonical for:** Local VS Code dogfood operations

## Install, package, reload

From the repository root run:

```sh
npm run vscode:dogfood
```

The script builds the packages, runs the existing VS Code checks, packages the VSIX, and installs it locally. It does not publish or install providers. When it finishes, use **Developer: Reload Window** when no workflow is active. The extension manifest in `apps/vscode/package.json` supplies the installed version; do not edit package versions for dogfood.

## Configure and smoke test

1. Open the Nyxara sidebar and connect a provider through **Settings → AI Providers**. API keys belong in VS Code SecretStorage; subscription CLIs own their own login. Never paste credentials into diagnostics.
2. Choose an exact model and execution setting in **Settings → Models & Roles**. Keep Planner, Executor, and Reviewer assignments explicit; Nyxara does not silently reroute a missing provider.
3. Run a small task with a clear acceptance check, then inspect approval, permissions, validation, review, repair, and final status.
4. Run one context-heavy multi-file or regression task. Record safe observations (status, timings, token fields when authoritative, error codes, and changed-file counts), not prompts, source, diffs, raw provider output, or secrets.

## Safety and recovery checks

- Confirm permission cards before writes or commands and verify denied actions do not run.
- Confirm deterministic validation precedes review, and that repair stops at configured limits or no-progress conditions.
- Verify provider/model identity and exact endpoint choices in the UI; do not infer connectivity from cached metadata.
- If the extension misbehaves, finish or abort the workflow, reload, and preserve the repository for inspection. To roll back, install a previously built local VSIX or uninstall the extension through VS Code; this does not delete repository changes or provider SecretStorage.

For alpha incident evidence, use the [archive](archive/README.md), not this guide.
