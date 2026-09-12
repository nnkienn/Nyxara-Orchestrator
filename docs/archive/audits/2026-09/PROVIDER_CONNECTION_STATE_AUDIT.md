# Provider connection state after reload

Date: 2026-09-07. Prerelease: `0.1.0-alpha.26`.

## Root cause and persistence audit

- `nyxara.providerConfigs` preserves provider identity/configuration and the explicit `signedOut` lifecycle marker. VS Code SecretStorage preserves scoped API keys, including the existing compatible-provider legacy fallback.
- The official CLI owns subscription credentials. Nyxara neither persists the tokens nor reads their files. `AuthSessionController` tracks only pending, one-time login attempts; it is not a credential store.
- `testedProviderIds` was an in-memory set lost at extension reload. `providerStatus` returned `Connection unknown` for every untested configuration, even when SecretStorage positively confirmed a key.
- Persisted model catalogs are not authentication or live-health evidence. No model-cache or discovery implementation is changed by this patch.

## Reload projection

| Local evidence | Provider status | Live network status |
| --- | --- | --- |
| Explicit local sign-out | Signed out | Not verified |
| API key found in SecretStorage | Credential present | Not verified |
| Required API key absent | Credential missing | Not verified |
| Previously confirmed supported CLI session | Session recorded | Not verified |
| CLI configuration with no saved auth evidence | CLI configured | Not verified |
| Missing CLI session at last explicit auth check | Credential missing (last-check detail) | Not verified |
| CLI unavailable at last explicit check, or adapter unregistered | Unavailable (last-check detail when available) | Not verified |
| Local/no-auth endpoint configuration only | Configured | Not verified |

CLI-local observations are stored in `globalState` under `nyxara.providerCliSessions.v1`, scoped by configuration ID and adapter. Only state and observation time are retained alongside those identifiers. No credential, account identity, raw command output, network-success flag or pending auth callback is stored. Sign-out/removal clears that configuration's evidence; explicit sign-out always wins over residual credentials or evidence.

Existing configurations without evidence deliberately do not receive a fabricated session confirmation. External CLI logout or installation changes cannot be detected without a new explicit check, so restored evidence is labeled historical and displays its observation time. No live status survives an extension-host reload.

## Explicit verification

- API **Test Connection** keeps the existing non-generating metadata request. Success promotes the current host projection to `Connected` / live verified; errors clear that badge and refresh the projection on both command and webview paths. Credential replacement invalidates the old live verification.
- Codex and Claude reuse their existing supported local auth checks through the unchanged adapter contract. Success records session evidence and shows `Session verified`; it does not claim network connectivity from local authentication or catalog metadata.
- Gemini CLI's existing `--version` check proves only executable availability. It shows `CLI available`, never fabricates session evidence, and does not become network `Connected`.
- Browser-login completion with failed metadata verification no longer sets a success badge unconditionally.

## No background work and scope

Activation/reload reads configuration, local safe evidence and (when projecting settings) SecretStorage only. There are no new provider calls, CLI invocations, discovery requests, repository scans, health checks, paid model calls, timers or polling. Existing timers for explicitly initiated browser-login attempts are unchanged.

Model discovery, Models & Roles behavior, Workflow settings, Performance and context/streaming implementations remain untouched. Pre-existing working-tree changes in those areas are preserved.

## Focused regression coverage

- Activation tests exercise real host reactivation with shared SecretStorage/Memento data: scoped and legacy API keys, Codex/Claude session evidence, sign-out, absent keys, observed CLI missing/unavailable states, Gemini's limited contract, explicit success/failure/retry and credential replacement.
- Fake-clock activation tests advance ten idle minutes and assert zero provider/generation/repository work, browser/task launches, fetches, timers, repeated secret reads or spontaneous projection updates.
- Projection/store tests cover unregistered providers, cached-model non-evidence, malformed persistence, adapter/instance isolation, sanitized metadata and separate local/live status.
- Webview tests render reload evidence and live verification independently and dispatch Test Connection only on click.

## Validation and dogfood

- `npm run build`: PASS.
- `tsc --noEmit` for all eight TypeScript projects: PASS.
- `npm test`: 70 files / 792 tests passed, including real-browser layout checks. Chrome checks required running outside the filesystem/process sandbox.
- `node --check apps/vscode/media/workspace.js` and `git diff --check`: PASS.
- `npm run vscode:dogfood`: rebuilt, passed all 445 VS Code tests, packaged and installed `nyxara.nyxara-vscode@0.1.0-alpha.26`; the script verified the installed version using the VS Code CLI.
- Artifact: `dist/vscode/nyxara-vscode-0.1.0-alpha.26.vsix`. Run **Developer: Reload Window** to activate the installed code.
- Twelve protected/pre-existing tracked-file diffs were compared with the pre-patch snapshot and remain byte-identical.

## Follow-up: configuration Proxy clone failure (alpha.27)

The running extension reported `DataCloneError: #<Object> could not be cloned` from `validateWorkflowSettingsPatch`, reached by `refreshSettingsProjection` on sidebar ready/open. VS Code returns object-valued configuration through proxies; the prior tests returned plain objects and missed this host-specific failure.

The fix replaces `structuredClone` at this boundary with detached plain-object copies of the already validated fields, including nested validation steps. No Workflow schema, limits, defaults or runtime behavior changes. The provider connection patch remains unchanged.

Seven newly added regression cases reproduced the exact error before the fix. Activation mocks now return recursive configuration proxies. After the fix, all 802 tests and eight project typechecks pass; build, JavaScript syntax and `git diff --check` pass. Dogfood packaging passes all 455 VS Code tests and installs `0.1.0-alpha.27`.

An additional isolated, real VS Code Extension Host smoke test verified both empty and nested persisted configuration proxies, reproduced the old `structuredClone` failure, confirmed the fixed result is cloneable, activated Nyxara and opened its sidebar. The Nyxara output log contains no clone/ready error. This test used temporary user data and no provider configurations or credentials, not the user's accounts.

## Follow-up: gateway API-key entry (alpha.28)

Optional-key gateways saved with `authStrategy: none` (or `local`) could not recover from authentication errors: the webview hid credential controls based on the current strategy, while the host also rejected credential updates. A 401 during new gateway setup removed the configuration entirely. Five regression cases reproduced these failures before the fix.

Key entry now follows the provider's supported auth methods. **Add API Key** / **Update API Key** opens a masked native VS Code input, persists only to scoped SecretStorage, and promotes the existing configuration to API-key auth without changing its endpoint, identity or role selections. Read-only reload projection also recognizes keys previously saved by the API-key command under a no-auth strategy. The command now uses the same save path and still performs no automatic verification.

Optional-key gateway authentication failures retain configuration and open Provider Details for correction. Cancel/empty input leaves state untouched; rejected replacement keys and failed settings writes restore the previous credential/configuration. The existing explicit credential-verification path and provider discovery implementation are unchanged. No real user gateway or credential was used in automated checks.

Regression coverage includes secure entry for no-auth/local gateways, cancellation, whitespace handling, 401 recovery/retry, persistence rollback, reload preservation, unsupported CLI/local providers, and the actual compatible adapter's Bearer header using mocked HTTP. Real-browser layout coverage asserts **Add API Key** is visible at every supported sidebar test width.

Validation: all 822 tests, eight project typechecks, build, JavaScript syntax and `git diff --check` pass. Dogfood packaging passes all 475 VS Code tests and installs `0.1.0-alpha.28`. Reload the VS Code window to activate the new key-entry controls.
