import type { ModelProvider, ProviderInfo } from "@nyxara/provider-sdk";

export type ProviderRegistryErrorCode =
  | "duplicate_provider"
  | "unknown_provider"
  | "invalid_provider";

export class ProviderRegistryError extends Error {
  constructor(
    readonly code: ProviderRegistryErrorCode,
    readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (provider.id.trim().length === 0) {
      throw new ProviderRegistryError(
        "invalid_provider",
        provider.id,
        "Provider ID must not be empty",
      );
    }

    if (this.providers.has(provider.id)) {
      throw new ProviderRegistryError(
        "duplicate_provider",
        provider.id,
        `Provider already registered: ${provider.id}`,
      );
    }

    this.providers.set(provider.id, provider);
  }

  get(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);

    if (!provider) {
      throw new ProviderRegistryError(
        "unknown_provider",
        providerId,
        `Provider is not registered: ${providerId}`,
      );
    }

    return provider;
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      capabilities: { ...provider.capabilities() },
    }));
  }
}

