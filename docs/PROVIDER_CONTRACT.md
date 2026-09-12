# Provider contract

**Status:** Current
**Last reviewed:** 2026-09-12
**Canonical for:** Provider, model, and role boundaries

Roles are independent of providers and model names. Planner, Executor, and Reviewer each resolve an explicit provider configuration, exact requested model ID, and execution profile. Core routes through `ProviderRegistry` and `ModelProvider`; provider-specific transport remains in adapters.

Adapters may discover model capabilities, including `contextWindow` and execution controls. Exact model resolution must preserve the requested/resolved IDs. Capability provenance is provider discovery, catalog, adapter-known, or unknown; unknown/stale values must be surfaced and handled conservatively rather than guessed.

Core must not silently reroute a missing provider/model or substitute a different model after an error. Clients own local credentials (for example VS Code SecretStorage or an official CLI session); credentials are never workflow state or benchmark evidence. Provider-specific HTTP/CLI transport, timeouts, cancellation, and response normalization belong to adapters, while Core remains provider-neutral.

For proposed capability-derived budgeting and fallback policy, see [CONTEXT_MANAGEMENT](CONTEXT_MANAGEMENT.md) and [ROADMAP Phase 2](ROADMAP.md#phase-2--capability-derived-adaptive-budget). Historical incidents belong in the [archive](archive/README.md).
