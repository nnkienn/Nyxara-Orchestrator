import { DEFAULT_REPAIR_LIMITS, DEFAULT_REVIEW_EVIDENCE_BUDGET, DEFAULT_TASK_CONTEXT_BUDGET } from "@nyxara/core";
import { providerDefinition } from "@nyxara/providers";
import { modelExecutionCapabilityRules } from "@nyxara/providers";
import {
  PROVIDER_DEFAULT_EXECUTION,
  executionProfileSummary,
  validateExecutionOptions,
  type ExecutionOptions,
  type ExecutionProfileStatus,
  type ModelCapabilities,
  type ModelExecutionCapability,
  type ModelExecutionCapabilityRule,
  type ProviderCapabilities,
} from "@nyxara/provider-sdk";
import type { ProviderConfig } from "./provider-config.js";

export type SettingsSection = "home" | "aiProviders" | "modelsRoles" | "workflow" | "planning" | "engineeringRules" | "permissions" | "context" | "validation" | "review" | "repair" | "usage" | "taskHistory" | "workspace" | "privacy" | "advanced" | "about";
export type ProviderConnectionStatus = "Connected" | "Signed out" | "Credential missing" | "Unavailable" | "Local available" | "Connection unknown";
export interface SettingsRoleAssignment { readonly role: "planner" | "executor" | "reviewer"; readonly providerConfigId?: string; readonly providerName?: string; readonly modelId?: string; readonly available: boolean; readonly status: "Configured" | "Signed out" | "Credential missing" | "Unavailable" | "Unconfigured"; readonly executionOptions: ExecutionOptions; readonly executionCapability?: ModelExecutionCapability; readonly executionProfileStatus: ExecutionProfileStatus }
export interface ProviderConfigProjection {
  readonly id: string; readonly adapterId: string; readonly displayName: string; readonly providerName: string; readonly category: string; readonly authStrategy: ProviderConfig["authStrategy"];
  readonly endpoint: string; readonly defaultModel?: string; readonly credentialStored: boolean; readonly status: ProviderConnectionStatus; readonly isDefault: boolean;
  readonly supportsModelDiscovery: boolean; readonly supportsManualModelId: boolean; readonly lifecycleAction: "Sign Out" | "Disconnect" | "Remove Provider"; readonly createdAt?: string;
  readonly lifecycleBlocked: boolean;
  readonly executionCapabilityRules: readonly ModelExecutionCapabilityRule[];
}
export interface SettingsProjection {
  readonly version: string;
  readonly providers: readonly ProviderConfigProjection[];
  readonly defaultProviderConfigId?: string;
  readonly defaultModel?: string;
  readonly modelMode: "simple" | "advanced";
  readonly roles: readonly SettingsRoleAssignment[];
  readonly workflow: { readonly planApproval: "Required"; readonly afterApproval: "Automatic"; readonly pauseResume: "Supported"; readonly automaticRepair: "Enabled" };
  readonly planning: { readonly selectedProfileId: string; readonly profiles: readonly { readonly id: string; readonly name: string; readonly locale?: string; readonly outputLanguage: string; readonly planStyle: string; readonly riskMode: string }[] };
  readonly rules: readonly { readonly id: string; readonly name: string; readonly description: string; readonly scope: string; readonly severity: string; readonly enabled: boolean }[];
  readonly permissions: { readonly automaticallyAllowed: readonly string[]; readonly askFirst: readonly string[]; readonly denied: readonly string[] };
  readonly context: { readonly strategy: "Automatic"; readonly repositoryContext: "On demand"; readonly targetedExpansion: "Enabled"; readonly bounded: "Enabled"; readonly maxTaskFiles: number; readonly maxTaskBytes: number };
  readonly validation: { readonly failFast: true; readonly steps: readonly { readonly kind: string; readonly policy: "Required when available" }[] };
  readonly review: { readonly reviewer: SettingsRoleAssignment; readonly rulesApplied: true; readonly validationFailuresForceFail: true; readonly boundedEvidence: true; readonly targetedContextExpansion: true; readonly maxContextFiles: number };
  readonly repair: { readonly automatic: true; readonly validationFirst: true; readonly plannerReplan: false; readonly contextReuse: true; readonly usesRole: "Executor"; readonly maximumCycles: number };
  readonly usage: { readonly tokenSource: "Provider reported / estimated / unavailable"; readonly cost: "Provider reported only"; readonly historyMetrics: "Local" };
  readonly history: { readonly storage: "Local"; readonly retention: number; readonly count: number; readonly choices: readonly number[] };
  readonly workspace: { readonly available: boolean; readonly multiple: boolean; readonly currentWorkspace?: string; readonly selectedRoot?: string; readonly roots: readonly { readonly id: string; readonly label: string }[]; readonly planningProfile: string; readonly rulesCount: number };
  readonly privacy: { readonly credentials: "VS Code SecretStorage"; readonly taskHistory: "Local"; readonly cloudSync: "Off"; readonly account: "Not required"; readonly telemetry: "None"; readonly providerRequests: "Sent directly to configured providers" };
  readonly advanced: { readonly manualModelId: "Supported by provider catalog"; readonly customEndpoints: "Compatible and local providers"; readonly roleRouting: "Supported"; readonly diagnosticState: "Sanitized metadata only" };
  readonly about: { readonly product: "Nyxara Orchestrator"; readonly channel: "Local Dogfood"; readonly providerConfigurations: number; readonly taskHistory: number; readonly workflowEngine: "Ready" };
}

export interface SettingsProjectionInput {
  readonly version: string; readonly providers: readonly ProviderConfig[]; readonly defaultProviderId?: string; readonly credentialStored: ReadonlyMap<string, boolean>;
  readonly roles: readonly { readonly role: "planner" | "executor" | "reviewer"; readonly providerConfigId?: string; readonly modelId?: string; readonly executionOptions?: ExecutionOptions; readonly executionMalformed?: boolean }[];
  readonly providerCapabilities?: ReadonlyMap<string, ProviderCapabilities>; readonly modelMode: "simple" | "advanced"; readonly selectedPlanningProfile: string;
  readonly modelCapabilities?: ReadonlyMap<string, ModelCapabilities>;
  readonly planningProfiles: readonly any[]; readonly engineeringRules: readonly any[]; readonly historyRetention: number; readonly historyCount: number;
  readonly workspaceFolders: readonly { readonly id: string; readonly label: string }[]; readonly selectedWorkspaceRootId?: string; readonly testedProviderIds?: ReadonlySet<string>; readonly activeProviderIds?: ReadonlySet<string>;
}

export function providerStatus(config: ProviderConfig, credentialStored: boolean, tested = false): ProviderConnectionStatus {
  if (config.signedOut) return "Signed out";
  if (config.authStrategy === "api_key" && !credentialStored) return "Credential missing";
  if (tested) return config.authStrategy === "local" ? "Local available" : "Connected";
  return "Connection unknown";
}

export function buildSettingsProjection(input: SettingsProjectionInput): SettingsProjection {
  const providers = input.providers.map((config): ProviderConfigProjection => {
    const definition = providerDefinition(config.catalogId ?? config.type);
    const credentialStored = input.credentialStored.get(config.id) === true;
    const registered = !input.providerCapabilities || input.providerCapabilities.has(config.id);
    return {
      id: config.id, adapterId: config.type, displayName: config.displayName, providerName: definition.displayName, category: categoryLabel(definition.onboarding.category),
      authStrategy: config.authStrategy, endpoint: definition.onboarding.category === "official" ? "Official" : config.baseUrl ?? "Managed by official CLI",
      ...(config.modelId ? { defaultModel: config.modelId } : {}), credentialStored, status: config.signedOut ? "Signed out" : registered ? providerStatus(config, credentialStored, input.testedProviderIds?.has(config.id)) : "Unavailable", isDefault: config.id === input.defaultProviderId,
      supportsModelDiscovery: definition.onboarding.modelDiscovery, supportsManualModelId: definition.onboarding.manualModelId,
      lifecycleAction: config.authStrategy === "subscription" ? "Sign Out" : config.authStrategy === "api_key" ? "Disconnect" : "Remove Provider", ...(config.createdAt ? { createdAt: config.createdAt } : {}),
      lifecycleBlocked: input.activeProviderIds?.has(config.id) === true,
      executionCapabilityRules: modelExecutionCapabilityRules(config.catalogId ?? config.type),
    };
  });
  const projectedRoles = input.roles.map((assignment): SettingsRoleAssignment => {
    const provider = providers.find((candidate) => candidate.id === assignment.providerConfigId);
    const available = !!provider && !["Signed out", "Credential missing", "Unavailable"].includes(provider.status);
    const unavailableStatus = provider?.status === "Signed out" || provider?.status === "Credential missing" || provider?.status === "Unavailable" ? provider.status : "Unavailable";
    const executionOptions = assignment.executionOptions ?? PROVIDER_DEFAULT_EXECUTION;
    const cachedCapability = assignment.providerConfigId && assignment.modelId ? input.modelCapabilities?.get(`${assignment.providerConfigId}\0${assignment.modelId}`)?.execution : undefined;
    const capability = cachedCapability ?? (provider && assignment.modelId ? provider.executionCapabilityRules.find((rule) => rule.match === "exact" ? assignment.modelId!.toLocaleLowerCase() === rule.modelId.toLocaleLowerCase() : assignment.modelId!.toLocaleLowerCase().startsWith(rule.modelId.toLocaleLowerCase()))?.capability : undefined);
    const executionProfileStatus = assignment.executionMalformed ? "stale" : validateExecutionOptions(executionOptions, capability);
    return { role: assignment.role, ...(assignment.providerConfigId ? { providerConfigId: assignment.providerConfigId } : {}), ...(provider ? { providerName: provider.displayName } : {}), ...(assignment.modelId ? { modelId: assignment.modelId } : {}), available, status: !assignment.providerConfigId || !assignment.modelId ? "Unconfigured" : available ? "Configured" : unavailableStatus, executionOptions, ...(capability ? { executionCapability: capability } : {}), executionProfileStatus };
  });
  const selected = providers.find((provider) => provider.id === input.defaultProviderId);
  const roots = input.workspaceFolders.slice(0, 32);
  const selectedRoot = roots.find((root) => root.id === input.selectedWorkspaceRootId) ?? (roots.length === 1 ? roots[0] : undefined);
  const planningProfiles = input.planningProfiles.slice(0, 64).map((profile) => ({ id: String(profile.id), name: String(profile.name), ...(profile.locale ? { locale: String(profile.locale) } : {}), outputLanguage: String(profile.outputLanguage), planStyle: String(profile.planStyle), riskMode: String(profile.riskMode) }));
  const rules = input.engineeringRules.slice(0, 256).map((rule) => ({ id: String(rule.id), name: String(rule.name), description: String(rule.description), scope: String(rule.scope), severity: String(rule.severity), enabled: rule.enabled === true }));
  const reviewer = projectedRoles.find((role) => role.role === "reviewer") ?? { role: "reviewer" as const, available: false, status: "Unconfigured" as const, executionOptions: PROVIDER_DEFAULT_EXECUTION, executionProfileStatus: "unknown" as const };
  return {
    version: input.version, providers, ...(selected ? { defaultProviderConfigId: selected.id } : {}), ...(selected?.defaultModel ? { defaultModel: selected.defaultModel } : {}), modelMode: input.modelMode, roles: projectedRoles,
    workflow: { planApproval: "Required", afterApproval: "Automatic", pauseResume: "Supported", automaticRepair: "Enabled" },
    planning: { selectedProfileId: input.selectedPlanningProfile, profiles: planningProfiles }, rules,
    permissions: { automaticallyAllowed: ["Read workspace", "List and search repository", "Git status and diff", "Approved workspace edits", "Validation commands"], askFirst: ["Safe or unknown non-validation commands", "Large file writes", "Environment file writes"], denied: ["Outside workspace", "Credential file writes", "Delete workspace files", "Git push/reset/clean", "sudo", "Production deployment"] },
    context: { strategy: "Automatic", repositoryContext: "On demand", targetedExpansion: "Enabled", bounded: "Enabled", maxTaskFiles: DEFAULT_TASK_CONTEXT_BUDGET.maxFiles, maxTaskBytes: DEFAULT_TASK_CONTEXT_BUDGET.maxBytes },
    validation: { failFast: true, steps: ["Typecheck", "Lint", "Tests", "Build"].map((kind) => ({ kind, policy: "Required when available" as const })) },
    review: { reviewer, rulesApplied: true, validationFailuresForceFail: true, boundedEvidence: true, targetedContextExpansion: true, maxContextFiles: DEFAULT_REVIEW_EVIDENCE_BUDGET.maxContextFiles },
    repair: { automatic: true, validationFirst: true, plannerReplan: false, contextReuse: true, usesRole: "Executor", maximumCycles: DEFAULT_REPAIR_LIMITS.maxRepairCycles },
    usage: { tokenSource: "Provider reported / estimated / unavailable", cost: "Provider reported only", historyMetrics: "Local" },
    history: { storage: "Local", retention: input.historyRetention, count: input.historyCount, choices: [20, 50, 100] },
    workspace: { available: roots.length > 0, multiple: roots.length > 1, ...(selectedRoot ? { currentWorkspace: selectedRoot.label, selectedRoot: selectedRoot.id } : {}), roots, planningProfile: input.selectedPlanningProfile, rulesCount: rules.filter((rule) => rule.enabled).length },
    privacy: { credentials: "VS Code SecretStorage", taskHistory: "Local", cloudSync: "Off", account: "Not required", telemetry: "None", providerRequests: "Sent directly to configured providers" },
    advanced: { manualModelId: "Supported by provider catalog", customEndpoints: "Compatible and local providers", roleRouting: "Supported", diagnosticState: "Sanitized metadata only" },
    about: { product: "Nyxara Orchestrator", channel: "Local Dogfood", providerConfigurations: providers.length, taskHistory: input.historyCount, workflowEngine: "Ready" },
  };
}

export function buildSanitizedDiagnostics(projection: SettingsProjection, workflowState?: { readonly status?: string; readonly active?: boolean }): Record<string, unknown> {
  return {
    product: projection.about.product, version: projection.version, channel: projection.about.channel,
    providers: projection.providers.map((provider) => ({ providerConfigId: provider.id, displayName: provider.displayName, adapterId: provider.adapterId, status: provider.status, requestedModelId: provider.defaultModel ?? null })),
    roles: projection.roles.map((role) => ({ role: role.role, providerConfigId: role.providerConfigId ?? null, requestedModelId: role.modelId ?? null, execution: executionProfileSummary(role.executionOptions), executionProfileStatus: role.executionProfileStatus, available: role.available })),
    workflow: { status: workflowState?.status ?? "idle", active: workflowState?.active ?? false },
    storage: { credentials: projection.privacy.credentials, taskHistory: projection.privacy.taskHistory, historyCount: projection.history.count, retention: projection.history.retention },
  };
}

function categoryLabel(category: string): string {
  return category === "official" ? "Official Provider" : category === "compatible" ? "Compatible Gateway" : category === "local" ? "Local Provider" : "Community Provider";
}
