import { PROVIDER_DEFINITIONS, type ProviderDefinition } from "@nyxara/providers";
import type { ProviderAuthMethod, ProviderCategory } from "@nyxara/provider-sdk";
import type { ProviderConfig } from "./provider-config.js";

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly category: ProviderCategory;
  readonly categoryLabel: string;
  readonly popular: boolean;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly supportsModelDiscovery: boolean;
  readonly supportsManualModelId: boolean;
  readonly defaultEndpoint?: string;
  readonly apiKeyHelpUrl?: string;
  readonly iconKey: string;
  readonly configured: boolean;
  readonly connected: boolean;
  readonly configurations: readonly { id: string; displayName: string; isDefault: boolean }[];
}

const CATEGORY_LABELS: Readonly<Record<ProviderCategory, string>> = {
  official: "Official Provider",
  compatible: "Compatible Gateway",
  local: "Local Provider",
  community: "Community Provider",
};

export function projectProviderCatalog(
  configs: readonly ProviderConfig[],
  defaultProviderId?: string,
  definitions: readonly ProviderDefinition[] = PROVIDER_DEFINITIONS,
): ProviderCatalogEntry[] {
  return definitions.map((definition) => {
    const matches = configs.filter((config) => (config.catalogId ?? config.type) === definition.id);
    return {
      id: definition.id,
      displayName: definition.displayName,
      category: definition.onboarding.category,
      categoryLabel: CATEGORY_LABELS[definition.onboarding.category],
      popular: definition.popular === true,
      authMethods: [...definition.onboarding.authMethods],
      supportsModelDiscovery: definition.onboarding.modelDiscovery,
      supportsManualModelId: definition.onboarding.manualModelId,
      ...(definition.onboarding.defaultEndpoint ? { defaultEndpoint: definition.onboarding.defaultEndpoint } : {}),
      ...(definition.onboarding.apiKeyHelpUrl ? { apiKeyHelpUrl: definition.onboarding.apiKeyHelpUrl } : {}),
      iconKey: definition.iconKey,
      configured: matches.length > 0,
      connected: matches.length > 0,
      configurations: matches.map((config) => ({ id: config.id, displayName: config.displayName, isDefault: config.id === defaultProviderId })),
    };
  }).sort((a, b) => Number(b.popular) - Number(a.popular) || a.displayName.localeCompare(b.displayName));
}

export function searchProviderCatalog(entries: readonly ProviderCatalogEntry[], query: string): ProviderCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => `${entry.displayName} ${entry.categoryLabel}`.toLocaleLowerCase().includes(needle));
}
