# Provider / role assignment integrity audit

> [!WARNING]
> Historical document retained for engineering and research provenance.
>
> This document describes a previous Nyxara alpha baseline. It is not the
> current product direction or the canonical architecture specification.
> See `../../../ARCHITECTURE.md` and `../../../ROADMAP.md`.

**Status:** Historical

## Root cause and evidence

The pre-patch `apps/vscode/src/extension.ts` contained multiple callers of
`applySimpleModel`, which wrote the selected provider's `modelId`,
`nyxara.defaultProviderConfigId`, `nyxara.modelMode`, and all three roles'
provider/model/execution settings together:

| Former caller | Trigger | Previous value | New value source | Explicit role assignment? |
| --- | --- | --- | --- | --- |
| `setDefaultProvider` | Set default provider while Simple mode was selected **or unset** | Independent saved role pairs | Selected config ID and its `modelId` | No: default-provider action only |
| `manageProviders` default branch | “Use as default” | Independent saved role pairs | Provider picker and `discoverAndPickModel` | No: default-provider action only |
| Webview `selectModel` handler | Legacy composer message, even though the selector was removed | Independent saved role pairs | Message provider/model, checked against provider default or planner model | No Models & Roles Apply |
| `chooseDefaultModel` | Command-palette model selection | Independent saved role pairs | Default provider and model quick pick | Model selection, but not explicit all-role Apply |
| `configureRoleModels` | Role quick-pick sequence | Saved role pairs | Three quick-pick results | Yes, but a second persistence entry point |

Selecting 9router with `modelId = ntha/gpt-6-astra` through the first two
paths produces exactly the reported all-role overwrite. A legacy composer
message can produce the same result. The repository proves these writers;
it does not contain an incident-time settings-write trace identifying which
trigger actually fired. No migration hardcodes 9router or that model.

## Current writer inventory

All VS Code configuration updates reside in `extension.ts`, through `update`
and `updateSettingsAtomic`. Role persistence has one owner,
`persistRoleAssignments`; unauthorized role provider/model/execution writes
are rejected. Development/test diagnostics include reason, role, previous
pair and next pair, with sanitization and no credentials.

| Symbol | Trigger / authorization | Previous → new value | Roles affected |
| --- | --- | --- | --- |
| `applySimpleModel` → `persistRoleAssignments` | Explicit Models & Roles “Apply to Planner, Executor & Reviewer”; host checks active section | Saved pairs → submitted pair; provider `modelId` and default → submitted pair; mode → simple | All three, explicitly |
| `applyRoleAssignments` → `persistRoleAssignments` | Explicit Models & Roles “Apply Role Assignments”; host checks active section | Saved pairs → independently submitted pairs; mode → advanced | Three independent assignments |
| `setDefaultProvider` | Provider settings / “Use as default” | Saved default → explicitly selected config ID | None |
| `persistProviders` | Connect, reconnect, credential update, sign-out, confirmed provider edit, or rollback | Provider configuration array → edited array | None; no default write |
| `editProvider` webview handler | Explicit name/endpoint save | Existing config → edited name/endpoint | None; existing `modelId` retained |
| `removeProvider` | Confirmed removal | Array → array without removed config; removed default → empty, otherwise unchanged | Saved references retained as unavailable |
| `updateSettingsAtomic` rollback | Failed settings write | Successfully changed keys → prior values at the same configuration scope | Only restores the failed explicit transaction |

Provider connect/auth completion does not select a default or a model.
Discovery no longer copies a discovered model into provider configuration.
The old composer protocol variant and host handler are removed; there is no
composer provider/model state or message sender. The obsolete model quick
picker is removed. Both model commands now open Models & Roles only.

## Read paths and scope

- `refreshSettingsProjection`, `workspaceState`, `buildSettingsProjection`
  and webview rendering project saved roles without persisting them.
- Simple/Advanced tabs change only the local UI draft. Simple projects the
  saved Planner pair, not the default provider or first discovered model.
- `refreshProviderModels`, `modelDiscovery.onChange`, connection tests and
  provider refresh update catalog/capability/verification caches, not roles
  or provider `modelId`.
- `readProviderConfigs` retains an alpha.1 in-memory legacy-provider adapter;
  `readPersistedExecution` handles missing execution settings in memory.
  Neither migration writes role settings.
- Activation/reload calls `session.configureAgents` using saved role pairs.
  There is no workspace/global role synchronization writer or reload repair.
  Explicit Apply writes Global settings; workspace overrides remain separate.
  Rollback uses `inspect` at the target scope, not merged effective values.
- Default-provider fallback when no default is set is a read-only provider
  projection, not a role-resolution source. A saved unavailable default is
  not replaced by the first provider.
- Removed/signed-out providers retain saved role references. Undiscovered
  model IDs stay selected and are labeled “Saved / not in discovered catalog”.
  A loaded catalog missing the saved ID displays an explicit unverified
  availability warning; catalog absence alone does not prove invalidity.
- The compatible provider preserves HTTP 502 and annotates the error with
  the actual request's provider configuration ID and model. It does not
  retry on another provider/model.

## Regression coverage

`apps/vscode/test/fixtures/corrupted-role-settings.ts` captures the reported
9router state. Activation tests preserve it and independently stale roles
across chat ready/close, Planning, Workflow, Models & Roles, AI Providers,
Performance, History, discovery, connection refresh, legacy composer messages
and reload. Further tests cover default-provider separation, rejected writes
from unrelated sections, explicit Simple/Advanced Apply, independent roles,
rollback, provider removal, and preservation after 502. Webview runtime tests
cover passive rendering, tabs, unselected/undiscovered models and explicit
Apply. Provider tests assert a real 502 makes exactly one request and includes
the provider/model identity.

No automatic recovery of the previous Codex pair is attempted: its original
model is not recoverable from the corrupted settings. Restore it through an
explicit Models & Roles Apply after identifying the intended saved values.

## Validation result

- `npm run build`: passed (all seven TypeScript projects).
- `npm run vscode:test`: 532 passed, 1 failed.
- `npm test`: 1035 passed, 1 failed.
- `git diff --check`: passed.
- Both suites fail only on the existing execution-retry activation test:
  its mock lacks `workflowStageEvidence`, accessed by the pre-existing
  uncommitted workflow-progress change in `extension.ts`. This is outside
  assignment integrity and was deliberately not modified. Browser tests
  pass when run outside the sandbox.
- Overall release gate: FAIL until that unrelated regression is resolved.
