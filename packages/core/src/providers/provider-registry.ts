import type { ModelCapabilities, ModelProvider, ProviderInfo } from "@nyxara/provider-sdk";

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

  replace(provider: ModelProvider): void {
    if (!this.providers.has(provider.id)) {
      throw new ProviderRegistryError("unknown_provider", provider.id, `Provider is not registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId.trim());
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
      ...(provider.providerId ? { providerId: provider.providerId } : {}),
      displayName: provider.displayName,
      capabilities: { ...provider.capabilities() },
    }));
  }

  modelCapabilities(providerConfigId: string, modelId: string): ModelCapabilities | undefined {
    return this.get(providerConfigId).modelCapabilities?.(modelId);
  }
}
