import * as vscode from "vscode";
import { PROVIDER_DEFINITIONS, knownModelExecutionCapability, providerDefinition, type ProviderDefinition } from "@nyxara/providers";
import { PROVIDER_DEFAULT_EXECUTION, assertExecutionOptionsSupported, type ExecutionOptions } from "@nyxara/provider-sdk";
import { NyxaraSession } from "./session.js";
import { safeErrorMessage } from "./projection.js";
import { DEFAULT_PROVIDER_SETTING, LEGACY_SECRET_KEY, PROVIDER_CONFIGS_SETTING, defaultProviderId, providerSecretKey, readPersistedExecution, readProviderConfigs, roleExecutionSetting, type ProviderConfig } from "./provider-config.js";
import { NyxaraWorkspaceViewProvider } from "./webview-view.js";
import { buildWorkspaceState, type TaskHistoryViewState } from "./workspace-state.js";
import type { WebviewToExtensionMessage } from "./webview-protocol.js";
import { TaskHistoryStore } from "./task-history-store.js";
import { TERMINAL_TASK_SESSION_STATUSES, projectTaskSession, safeWorkspaceIdentity } from "./task-session.js";
import { buildSanitizedDiagnostics, buildSettingsProjection, type SettingsProjection, type SettingsSection } from "./settings-projection.js";

type Role = "planner" | "executor" | "reviewer";
const ROLES: readonly Role[] = ["planner", "executor", "reviewer"];
let activeHistoryStore: TaskHistoryStore | undefined;

export async function workspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) { void vscode.window.showErrorMessage("Open a workspace folder before using Nyxara."); return undefined; }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const selectedRoot = vscode.workspace.getConfiguration().get("nyxara.workspace.selectedRoot", "") as string;
  const selectedIndex = /^root-(\d+)$/.exec(selectedRoot)?.[1];
  if (selectedIndex !== undefined && folders[Number(selectedIndex)]) return folders[Number(selectedIndex)].uri.fsPath;
  const picked = await vscode.window.showQuickPick(folders.map((folder: any) => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: "Select the Nyxara workspace root" });
  return picked?.folder.uri.fsPath;
}

export function providerConnectionMessage(error: unknown, displayName: string): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "authentication_error") return `${displayName} authentication failed. Check your API key.`;
  if (code === "network_error") return `${displayName} could not be reached. Check your network and endpoint.`;
  if (code === "rate_limit_error") return `${displayName} rate limit reached. Try again later.`;
  if (code === "provider_not_installed") return `${displayName} CLI is not installed. Install the official CLI, sign in, then try again.`;
  if (code === "timeout_error" || /timed? out/i.test(message)) return `${displayName} timed out.`;
  if (code === "invalid_model" || /model is not available/i.test(message)) return "Configured model unavailable. Choose another model.";
  if ([404, 405, 501].includes(statusCode ?? 0)) return "Model discovery unsupported. Enter a model ID manually.";
  if (/base URL is invalid/i.test(message)) return "Invalid Base URL. Check the provider endpoint.";
  if (code === "invalid_response") return `${displayName} returned an unexpected response.`;
  if (code === "provider_error") return `${displayName} is unavailable. Try again later.`;
  return safeErrorMessage(error);
}

export function activate(context: vscode.ExtensionContext, injectedSession?: NyxaraSession): void {
  const output = vscode.window.createOutputChannel("Nyxara");
  const setting = <T>(key: string, fallback: T): T => vscode.workspace.getConfiguration().get(key, fallback);
  let providerConfigs = readProviderConfigs(setting);
  let selectedProviderId = defaultProviderId(providerConfigs, setting(DEFAULT_PROVIDER_SETTING, ""));
  const session = injectedSession ?? new NyxaraSession(context, output, providerConfigs);
  const version = (context as any).extension?.packageJSON?.version ?? "unknown";
  const selectedProvider = () => providerConfigs.find((config) => config.id === selectedProviderId);
  const roleExecution = (role: Role) => readPersistedExecution(setting<unknown>(roleExecutionSetting(role), undefined));
  const agentSetting = (key: string): unknown => key.endsWith(".execution") ? setting<unknown>(key, undefined) : setting(key, "");
  const configuredRetention = setting("nyxara.history.retention", 50);
  const historyStore = new TaskHistoryStore(context.globalStorageUri?.fsPath, [20, 50, 100].includes(configuredRetention) ? configuredRetention : 50, (message) => output.appendLine(message));
  activeHistoryStore = historyStore;
  const authoritativeSnapshot = session.snapshot;
  const authoritativeWorkflowIds = new Set<string>();
  if (authoritativeSnapshot && !["completed", "failed", "aborted"].includes(authoritativeSnapshot.status)) authoritativeWorkflowIds.add(authoritativeSnapshot.workflowId);
  let currentTaskSessionId = authoritativeSnapshot
    ? historyStore.list({ allWorkspaces: true }).find((task) => task.workflowId === authoritativeSnapshot.workflowId)?.id
    : undefined;
  const interruptedCount = historyStore.markInterrupted(authoritativeWorkflowIds);
  output.appendLine(`Task history loaded: ${historyStore.list({ allWorkspaces: true }).length} sessions in ${historyStore.loadDurationMs.toFixed(1)} ms${interruptedCount ? `; ${interruptedCount} marked interrupted` : ""}`);
  let historyScreen: TaskHistoryViewState["screen"] = "workspace";
  let historyQuery = "";
  let historyFilter: TaskHistoryViewState["filter"] = "all";
  let historyScope: TaskHistoryViewState["scope"] = "current";
  let selectedHistoryTaskId: string | undefined;
  let settingsSection: SettingsSection | undefined;
  let selectedSettingsProviderId: string | undefined;
  let settingsProjection: SettingsProjection | undefined;
  let settingsDiagnostics: Readonly<Record<string, unknown>> | undefined;
  let selectedWorkspaceRootId = setting("nyxara.workspace.selectedRoot", "");
  const testedProviderIds = new Set<string>();
  const activeWorkflowProviderIds = new Set<string>();
  if (authoritativeSnapshot && !["completed", "failed", "aborted"].includes(authoritativeSnapshot.status)) {
    for (const role of ROLES) {
      const providerId = setting(`nyxara.${role}.provider`, "");
      if (providerId) activeWorkflowProviderIds.add(providerId);
    }
  }

  const identityForRoot = (root: string) => {
    const folder = (vscode.workspace.workspaceFolders ?? []).find((candidate: any) => candidate.uri.fsPath === root);
    return safeWorkspaceIdentity(folder?.name ?? "Workspace", root);
  };
  const currentWorkspaceIdentity = () => {
    const current = currentTaskSessionId ? historyStore.get(currentTaskSessionId)?.workspaceIdentity : undefined;
    if (current) return current;
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length === 1 ? safeWorkspaceIdentity(folders[0].name, folders[0].uri.fsPath) : undefined;
  };
  const activeTaskId = () => {
    if (!currentTaskSessionId || !session.snapshot || ["completed", "failed", "aborted"].includes(session.snapshot.status)) return undefined;
    return currentTaskSessionId;
  };
  const storeStatus = (): "active" | "completed" | "failed" | "interrupted" | undefined => historyFilter === "all" ? undefined : historyFilter;
  const historyState = (): TaskHistoryViewState => {
    const workspace = currentWorkspaceIdentity();
    const allWorkspaces = historyScope === "all" || !workspace;
    const status = storeStatus();
    const filter = { allWorkspaces, query: historyQuery, ...(workspace ? { workspaceId: workspace.id } : {}), ...(status ? { status } : {}) };
    const tasks = historyStore.list(filter);
    const active = activeTaskId();
    return {
      screen: historyScreen,
      recentTasks: historyStore.list({ allWorkspaces: true, ...(workspace ? { workspaceId: workspace.id } : {}) }).slice(0, 5),
      tasks,
      query: historyQuery,
      filter: historyFilter,
      scope: allWorkspaces ? "all" : "current",
      ...(workspace ? { currentWorkspaceId: workspace.id } : {}),
      ...(active ? { activeTaskId: active } : {}),
      ...(selectedHistoryTaskId && historyStore.get(selectedHistoryTaskId) ? { selectedTask: historyStore.get(selectedHistoryTaskId)! } : {}),
    };
  };
  const workspaceState = () => buildWorkspaceState({
    version, configured: session.configured, folders: (vscode.workspace.workspaceFolders ?? []).length,
    providers: providerConfigs, ...(selectedProviderId ? { defaultProviderId: selectedProviderId } : {}),
    roles: ROLES.map((role) => { const providerId = setting(`nyxara.${role}.provider`, ""); const modelId = setting(`nyxara.${role}.model`, ""); const providerName = providerConfigs.find((config) => config.id === providerId)?.displayName; return { role, ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}), ...(providerName ? { providerName } : {}) }; }),
    ...(session.prompt ? { prompt: session.prompt } : {}), ...(session.currentPlan ? { plan: session.currentPlan } : {}), ...(session.snapshot ? { snapshot: session.snapshot } : {}), validation: session.validation,
    validationDurations: session.validationDurations,
    ...(session.reviewStatus ? { reviewStatus: session.reviewStatus } : {}),
    ...(session.reviewFindingCount !== undefined ? { reviewFindingCount: session.reviewFindingCount } : {}),
    ...(session.repairCycle ? { repairCycle: session.repairCycle } : {}), ...(session.result ? { result: session.result } : {}),
    history: historyState(),
    ...(settingsSection && settingsProjection ? { settings: { section: settingsSection, ...(selectedSettingsProviderId ? { providerConfigId: selectedSettingsProviderId } : {}), projection: settingsProjection, ...(settingsDiagnostics ? { diagnostics: settingsDiagnostics } : {}) } } : {}),
  });
  const refreshSettingsProjection = async (): Promise<void> => {
    const credentials = new Map<string, boolean>();
    await Promise.all(providerConfigs.map(async (config) => {
      if (config.authStrategy !== "api_key") { credentials.set(config.id, false); return; }
      const scoped = await context.secrets.get(providerSecretKey(config.id));
      const legacy = !scoped && config.id === "openai-compatible" ? await context.secrets.get(LEGACY_SECRET_KEY) : undefined;
      credentials.set(config.id, Boolean(scoped || legacy));
    }));
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder: any, index: number) => ({ id: `root-${index}`, label: String(folder.name || `Workspace ${index + 1}`).slice(0, 100) }));
    const pairs = ROLES.map((role) => `${setting(`nyxara.${role}.provider`, "")}\0${setting(`nyxara.${role}.model`, "")}`).filter((pair) => pair !== "\0");
    const configuredMode = setting<string>("nyxara.modelMode", "");
    settingsProjection = buildSettingsProjection({
      version, providers: providerConfigs, ...(selectedProviderId ? { defaultProviderId: selectedProviderId } : {}), credentialStored: credentials,
      roles: ROLES.map((role) => { const execution = roleExecution(role); return { role, ...(setting(`nyxara.${role}.provider`, "") ? { providerConfigId: setting(`nyxara.${role}.provider`, "") } : {}), ...(setting(`nyxara.${role}.model`, "") ? { modelId: setting(`nyxara.${role}.model`, "") } : {}), executionOptions: execution.executionOptions, ...(execution.malformed ? { executionMalformed: true } : {}) }; }),
      providerCapabilities: new Map(session.core.listProviders().map((provider: any) => [provider.id, provider.capabilities])),
      modelCapabilities: new Map(ROLES.flatMap((role) => { const providerId = setting(`nyxara.${role}.provider`, ""); const modelId = setting(`nyxara.${role}.model`, ""); if (!providerId || !modelId || typeof (session.core as any).getModelCapabilities !== "function") return []; const capabilities = session.core.getModelCapabilities(providerId, modelId); return capabilities ? [[`${providerId}\0${modelId}`, capabilities] as const] : []; })),
      modelMode: configuredMode === "advanced" || (configuredMode !== "simple" && new Set(pairs).size > 1) ? "advanced" : "simple",
      selectedPlanningProfile: setting("nyxara.planningProfile", "default"), planningProfiles: session.core.listPlanningProfiles(), engineeringRules: typeof (session.core as any).listEngineeringRules === "function" ? (session.core as any).listEngineeringRules() : [],
      historyRetention: historyStore.retention, historyCount: historyStore.list({ allWorkspaces: true }).length, workspaceFolders: folders,
      ...(selectedWorkspaceRootId ? { selectedWorkspaceRootId } : {}), testedProviderIds,
      ...(session.snapshot && !["completed", "failed", "aborted"].includes(session.snapshot.status) ? { activeProviderIds: activeWorkflowProviderIds } : {}),
    });
  };
  const syncCurrentTask = (): void => {
    if (!currentTaskSessionId) return;
    historyStore.update(currentTaskSessionId, (task) => projectTaskSession(task, workspaceState()));
  };
  const providerSummary = () => {
    const selected = selectedProvider();
    if (!selected) return undefined;
    const pairs = ROLES.map((role) => `${setting(`nyxara.${role}.provider`, "")}\0${setting(`nyxara.${role}.model`, "")}`).filter((pair) => pair !== "\0");
    if (new Set(pairs).size > 1) return { provider: "Advanced routing" };
    const model = selected.modelId || (setting("nyxara.planner.provider", "") === selected.id ? setting("nyxara.planner.model", "") : "");
    return { provider: selected.displayName, ...(model ? { model } : {}) };
  };
  let planningRequestActive = false;
  const startRequirement = async (task: string, root: string, profile: string): Promise<void> => {
    if (planningRequestActive || (session.snapshot && !["completed", "failed", "aborted"].includes(session.snapshot.status))) throw new Error("Finish or abort the active workflow before starting a new task.");
    planningRequestActive = true;
    activeWorkflowProviderIds.clear();
    for (const role of ROLES) {
      const providerId = setting(`nyxara.${role}.provider`, "");
      if (providerId) activeWorkflowProviderIds.add(providerId);
    }
    const created = historyStore.create({ requirement: task, workspaceIdentity: identityForRoot(root), providerSummary: providerSummary() });
    currentTaskSessionId = created.id;
    selectedHistoryTaskId = undefined;
    historyScreen = "workspace";
    try {
      await session.generate(task, root, profile);
      syncCurrentTask();
    } catch (error) {
      syncCurrentTask();
      const projected = historyStore.get(created.id);
      if (projected && !TERMINAL_TASK_SESSION_STATUSES.has(projected.status)) historyStore.update(created.id, { ...projected, status: "failed", updatedAt: new Date().toISOString(), failureSummary: { stage: "Planning", message: safeErrorMessage(error) } });
      throw error;
    } finally {
      planningRequestActive = false;
    }
  };
  const webview = new NyxaraWorkspaceViewProvider(context.extensionUri, workspaceState, async (message: WebviewToExtensionMessage) => {
    try { switch (message.type) {
      case "ready": if (settingsSection) await refreshSettingsProjection(); webview.refresh(settingsSection ? "settingsProjection" : "initialState"); return;
      case "openProviderSetup": await connectProvider(); webview.refresh("providerState"); return;
      case "openSettings": settingsSection = "home"; selectedSettingsProviderId = undefined; settingsDiagnostics = undefined; await refreshSettingsProjection(); webview.refresh("settingsProjection"); return;
      case "closeSettings": settingsSection = undefined; selectedSettingsProviderId = undefined; settingsDiagnostics = undefined; webview.refresh("providerState"); return;
      case "openSettingsSection": settingsSection = message.section; selectedSettingsProviderId = message.providerConfigId; settingsDiagnostics = undefined; await refreshSettingsProjection(); webview.refresh("settingsProjection"); return;
      case "searchSettings": return;
      case "connectProvider": await connectProvider(); await refreshSettingsProjection(); webview.refresh("providerConfigs"); return;
      case "testProvider": { const config = requireProviderConfig(message.providerConfigId); await testProvider(config); await refreshSettingsProjection(); webview.refresh("providerStatusChanged"); return; }
      case "updateCredential": await updateProviderCredential(requireProviderConfig(message.providerConfigId)); await refreshSettingsProjection(); webview.refresh("providerStatusChanged"); return;
      case "updateProviderMetadata": {
        const config = requireProviderConfig(message.providerConfigId); const definition = providerDefinition(config.catalogId ?? config.type);
        if (definition.onboarding.category === "official" || definition.cli) throw new Error("Official provider endpoints cannot be overridden.");
        let endpoint: URL; try { endpoint = new URL(message.endpoint); } catch { throw new Error("Invalid endpoint."); }
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error("Invalid endpoint. Use HTTP or HTTPS.");
        const edited = { ...config, displayName: message.displayName, baseUrl: endpoint.toString().replace(/\/$/, "") };
        const nextProviders = providerConfigs.map((candidate) => candidate.id === config.id ? edited : candidate); await update(PROVIDER_CONFIGS_SETTING, nextProviders); providerConfigs = nextProviders; session.upsertProvider(edited); testedProviderIds.delete(config.id); await refreshSettingsProjection(); webview.refresh("providerConfigs"); return;
      }
      case "signOutProvider": await signOutProvider(requireProviderConfig(message.providerConfigId)); await refreshSettingsProjection(); webview.refresh("providerStatusChanged"); return;
      case "removeProvider": await removeProvider(requireProviderConfig(message.providerConfigId)); selectedSettingsProviderId = undefined; settingsSection = "aiProviders"; await refreshSettingsProjection(); webview.refresh("providerConfigs"); return;
      case "setDefaultProvider": await setDefaultProvider(requireProviderConfig(message.providerConfigId)); await refreshSettingsProjection(); webview.refresh("providerConfigs"); return;
      case "setDefaultModel": await applySimpleModel(requireProviderConfig(message.providerConfigId).id, message.modelId, message.executionOptions); await refreshSettingsProjection(); webview.refresh("roleAssignmentsChanged"); return;
      case "updateRoleAssignments": await applyRoleAssignments(message.assignments); await refreshSettingsProjection(); webview.refresh("roleAssignmentsChanged"); return;
      case "updatePlanningProfile": {
        if (!session.core.listPlanningProfiles().some((profile: any) => profile.id === message.profileId)) throw new Error("Selected planning profile is unavailable.");
        await update("nyxara.planningProfile", message.profileId); await refreshSettingsProjection(); webview.refresh("planningProfiles"); return;
      }
      case "updateHistoryRetention": historyStore.setRetention(message.retention); await update("nyxara.history.retention", message.retention); await historyStore.flush(); await refreshSettingsProjection(); webview.refresh("historySettings"); return;
      case "selectWorkspaceRoot": {
        const roots = (vscode.workspace.workspaceFolders ?? []).map((_folder: any, index: number) => `root-${index}`);
        if (!roots.includes(message.rootId)) throw new Error("Selected workspace root is unavailable.");
        selectedWorkspaceRootId = message.rootId; await update("nyxara.workspace.selectedRoot", message.rootId); await refreshSettingsProjection(); webview.refresh("workspaceSettings"); return;
      }
      case "requestDiagnostics": settingsDiagnostics = settingsProjection ? buildSanitizedDiagnostics(settingsProjection, session.snapshot) : undefined; webview.refresh("diagnostics"); return;
      case "copyDiagnostics": {
        if (!settingsProjection) throw new Error("Open Settings before copying diagnostics.");
        settingsDiagnostics = buildSanitizedDiagnostics(settingsProjection, session.snapshot);
        await vscode.env.clipboard.writeText(JSON.stringify(settingsDiagnostics, null, 2)); webview.refresh("diagnostics"); return;
      }
      case "selectModel": {
        const config = providerConfigs.find((candidate) => candidate.id === message.providerConfigId);
        const knownModel = config?.modelId ?? (setting("nyxara.planner.provider", "") === config?.id ? setting("nyxara.planner.model", "") : "");
        if (!config || knownModel !== message.modelId) throw new Error("Selected provider or model is no longer configured.");
        await applySimpleModel(message.providerConfigId, message.modelId); webview.refresh("modelState"); return;
      }
      case "submitRequirement": {
        if (!session.configured) throw new Error("Connect an AI provider and choose a model first.");
        const root = await workspaceRoot(); if (!root) return;
        const profiles = session.core.listPlanningProfiles();
        const profile = setting("nyxara.planningProfile", "default");
        if (!profiles.some((candidate: any) => candidate.id === profile)) throw new Error("Configured planning profile is unavailable.");
        await startRequirement(message.task, root, profile); webview.refresh("historyUpdated"); return;
      }
      case "approvePlan": await session.approveAndRun(); return;
      case "rejectPlan": session.rejectPlan(); return;
      case "allowPermission": { const pending = session.snapshot?.pendingPermission; if (!pending || pending.id !== message.requestId) throw new Error("Permission request is no longer pending."); await session.resolvePermission(message.requestId, "allow"); return; }
      case "denyPermission": { const pending = session.snapshot?.pendingPermission; if (!pending || pending.id !== message.requestId) throw new Error("Permission request is no longer pending."); await session.resolvePermission(message.requestId, "deny"); return; }
      case "abortWorkflow": session.abort(); return;
      case "pauseWorkflow": session.pause(); return;
      case "resumeWorkflow": await session.resume(); return;
      case "newTask": session.resetPresentation(); currentTaskSessionId = undefined; selectedHistoryTaskId = undefined; historyScreen = "workspace"; webview.refresh("recentTasks"); return;
      case "openHistory": historyScreen = "history"; selectedHistoryTaskId = undefined; webview.refresh("taskHistory"); return;
      case "listTasks": historyScope = message.scope; historyScreen = "history"; webview.refresh("taskHistory"); return;
      case "searchTasks": historyQuery = message.query; historyScreen = "history"; webview.refresh("historySearchResults"); return;
      case "filterTasks": historyFilter = message.filter; historyScreen = "history"; webview.refresh("taskHistory"); return;
      case "openTask": {
        const task = historyStore.get(message.taskId); if (!task) throw new Error("That local task is no longer available.");
        if (message.taskId === activeTaskId()) { historyScreen = "workspace"; selectedHistoryTaskId = undefined; webview.refresh("workflowSnapshot"); return; }
        selectedHistoryTaskId = task.id; historyScreen = "historical"; webview.refresh("historicalTaskLoaded"); return;
      }
      case "returnToActiveTask": {
        if (!activeTaskId()) throw new Error("There is no active task to return to.");
        selectedHistoryTaskId = undefined; historyScreen = "workspace"; webview.refresh("workflowSnapshot"); return;
      }
      case "deleteTask": {
        const task = historyStore.get(message.taskId); if (!task) throw new Error("That local task is no longer available.");
        if (message.taskId === activeTaskId()) throw new Error("The active task cannot be deleted.");
        const confirmed = await vscode.window.showWarningMessage(`Delete local history for “${task.title}”? Repository files, provider settings, and credentials are not affected.`, { modal: true }, "Delete Task");
        if (confirmed !== "Delete Task") return;
        historyStore.delete(task.id); await historyStore.flush(); selectedHistoryTaskId = undefined; historyScreen = "history"; webview.refresh("historyUpdated"); return;
      }
      case "clearHistory": {
        const confirmed = await vscode.window.showWarningMessage("Clear terminal Nyxara task history? The active task, repository files, provider settings, and credentials are preserved.", { modal: true }, "Clear History");
        if (confirmed !== "Clear History") return;
        historyStore.clear(); await historyStore.flush(); selectedHistoryTaskId = undefined; if (!settingsSection) historyScreen = "history";
        if (settingsSection) { await refreshSettingsProjection(); webview.refresh("historySettings"); } else webview.refresh("historyCleared"); return;
      }
      default: return;
    } } catch (error) {
      output.appendLine(`sidebar ${message.type}: ${safeErrorMessage(error)}`);
      throw error;
    }
  });
  session.onChange = () => {
    syncCurrentTask();
    if (session.snapshot && ["completed", "failed", "aborted"].includes(session.snapshot.status)) activeWorkflowProviderIds.clear();
    if (settingsSection) void refreshSettingsProjection().then(() => webview.refresh()); else webview.refresh();
  };
  context.subscriptions.push(output, vscode.window.registerWebviewViewProvider("nyxara.sidebar", webview));

  const update = (key: string, value: unknown) => vscode.workspace.getConfiguration().update(key, value, true);
  const updateSettingsAtomic = async (entries: readonly (readonly [string, unknown])[]): Promise<void> => {
    const previous = entries.map(([key]) => [key, setting<unknown>(key, undefined)] as const);
    let committed = 0;
    try {
      for (const [key, value] of entries) { await update(key, value); committed += 1; }
    } catch (error) {
      for (let index = committed - 1; index >= 0; index -= 1) await update(previous[index]![0], previous[index]![1]);
      throw error;
    }
  };
  const persistProviders = async (): Promise<void> => { await updateSettingsAtomic([[PROVIDER_CONFIGS_SETTING, providerConfigs], [DEFAULT_PROVIDER_SETTING, selectedProviderId ?? ""]]); };
  const providerCapabilities = (providerId: string) => session.core.listProviders().find((provider: any) => provider.id === providerId)?.capabilities;
  const assertRoleCompatibility = (config: ProviderConfig, role: Role): void => {
    const capabilities = providerCapabilities(config.id);
    if (capabilities && (!capabilities.textGeneration || (role === "executor" && !capabilities.toolCalling))) throw new Error(`${config.displayName} is incompatible with the ${role} role.`);
  };
  const applySimpleModel = async (providerId: string, modelId: string, executionOptions: ExecutionOptions = PROVIDER_DEFAULT_EXECUTION): Promise<void> => {
    const config = requireProviderConfig(providerId); const normalizedModel = modelId.trim();
    if (!normalizedModel) throw new Error("A model ID is required.");
    if (config.signedOut) throw new Error(`${config.displayName} is signed out.`);
    if (config.authStrategy === "api_key" && !(await context.secrets.get(providerSecretKey(config.id))) && !(config.id === "openai-compatible" && await context.secrets.get(LEGACY_SECRET_KEY))) throw new Error(`${config.displayName} credential is missing.`);
    for (const role of ROLES) assertRoleCompatibility(config, role);
    const modelCapabilities = typeof (session.core as any).getModelCapabilities === "function" ? session.core.getModelCapabilities(providerId, normalizedModel) : undefined;
    assertExecutionOptionsSupported(executionOptions, modelCapabilities?.execution ?? knownModelExecutionCapability(config.catalogId ?? config.type, normalizedModel));
    const nextProviders = providerConfigs.map((candidate) => candidate.id === providerId ? { ...candidate, modelId: normalizedModel } : candidate);
    await updateSettingsAtomic([[PROVIDER_CONFIGS_SETTING, nextProviders], [DEFAULT_PROVIDER_SETTING, providerId], ["nyxara.modelMode", "simple"], ...ROLES.flatMap((role) => [[`nyxara.${role}.provider`, providerId], [`nyxara.${role}.model`, normalizedModel], [roleExecutionSetting(role), executionOptions]] as const), ["nyxara.provider", config.type]]);
    providerConfigs = nextProviders; selectedProviderId = providerId;
    session.configureAgents(agentSetting);
  };
  const setDefaultProvider = async (config: ProviderConfig): Promise<void> => {
    if (config.signedOut) throw new Error(`${config.displayName} is signed out.`);
    if (setting("nyxara.modelMode", "simple") === "simple") {
      if (!config.modelId) throw new Error(`Choose a model for ${config.displayName} before setting it as the Simple-mode default.`);
      await applySimpleModel(config.id, config.modelId);
      return;
    }
    selectedProviderId = config.id;
    try { await persistProviders(); }
    catch (error) { selectedProviderId = defaultProviderId(providerConfigs, setting(DEFAULT_PROVIDER_SETTING, "")); throw error; }
  };
  const requireProviderConfig = (providerConfigId: string): ProviderConfig => {
    const config = providerConfigs.find((candidate) => candidate.id === providerConfigId);
    if (!config) throw new Error("That provider configuration is no longer available.");
    return config;
  };
  const providerUsedByRoles = (providerConfigId: string): Role[] => ROLES.filter((role) => setting(`nyxara.${role}.provider`, "") === providerConfigId);
  const assertProviderNotInActiveWorkflow = (config: ProviderConfig): void => {
    const active = session.snapshot && !["completed", "failed", "aborted"].includes(session.snapshot.status);
    if (active && activeWorkflowProviderIds.has(config.id)) throw new Error(`${config.displayName} is in use by the active workflow. Abort or finish it before signing out or removing it.`);
  };
  const updateProviderCredential = async (config: ProviderConfig): Promise<void> => {
    const definition = providerDefinition(config.catalogId ?? config.type);
    if (config.authStrategy === "subscription") {
      if (!(await confirmCliLogin(definition))) return;
      const reconnected = { ...config, signedOut: false };
      providerConfigs = providerConfigs.map((candidate) => candidate.id === config.id ? reconnected : candidate);
      session.upsertProvider(reconnected); testedProviderIds.delete(config.id); await persistProviders(); session.configureAgents(agentSetting); return;
    }
    if (config.authStrategy !== "api_key") throw new Error("This provider does not use a stored credential.");
    const credential = await vscode.window.showInputBox({ prompt: `${config.displayName} new API key (stored securely)`, password: true, ignoreFocusOut: true });
    if (credential === undefined) return;
    if (!credential.trim()) throw new Error("A non-empty credential is required.");
    await context.secrets.store(providerSecretKey(config.id), credential.trim());
    const reconnected = { ...config, signedOut: false };
    providerConfigs = providerConfigs.map((candidate) => candidate.id === config.id ? reconnected : candidate);
    session.upsertProvider(reconnected); testedProviderIds.delete(config.id); await persistProviders();
    session.configureAgents(agentSetting);
  };
  const signOutProvider = async (config: ProviderConfig): Promise<void> => {
    if (config.authStrategy === "local" || config.authStrategy === "none") throw new Error("Local and no-auth providers can be removed, not signed out.");
    assertProviderNotInActiveWorkflow(config);
    const label = config.authStrategy === "subscription" ? "Sign Out" : "Disconnect";
    const used = providerUsedByRoles(config.id);
    const roleText = used.length ? `\n\nCurrently used by: ${used.map((role) => role[0]!.toUpperCase() + role.slice(1)).join(", ")}. These assignments will be marked unavailable.` : "";
    const explanation = config.authStrategy === "subscription"
      ? "Nyxara does not store or revoke the official CLI account session. This signs out only this Nyxara provider configuration."
      : "This removes only its stored credential.";
    const confirmed = await vscode.window.showWarningMessage(`${label} of ${config.displayName}? ${explanation} Provider settings, model configuration, task history, and repository files remain.${roleText}`, { modal: true }, label);
    if (confirmed !== label) return;
    await context.secrets.delete(providerSecretKey(config.id));
    if (config.id === "openai-compatible") await context.secrets.delete(LEGACY_SECRET_KEY);
    testedProviderIds.delete(config.id); providerConfigs = providerConfigs.map((candidate) => candidate.id === config.id ? { ...candidate, signedOut: true } : candidate);
    await persistProviders();
    if (used.length) session.configureAgents(agentSetting, new Set(providerConfigs.filter((candidate) => !candidate.signedOut && candidate.id !== config.id).map((candidate) => candidate.id)));
  };
  const removeProvider = async (config: ProviderConfig): Promise<void> => {
    assertProviderNotInActiveWorkflow(config);
    const used = providerUsedByRoles(config.id);
    const roleText = used.length ? ` Currently used by: ${used.map((role) => role[0]!.toUpperCase() + role.slice(1)).join(", ")}. These role assignments will become unconfigured.` : "";
    const confirmed = await vscode.window.showWarningMessage(`Remove ${config.displayName}? This deletes only this provider configuration and its scoped credential.${roleText} Task history, repository files, other providers, and unrelated credentials remain.`, { modal: true }, "Remove Provider");
    if (confirmed !== "Remove Provider") return;
    const nextProviders = providerConfigs.filter((candidate) => candidate.id !== config.id);
    const nextDefault = selectedProviderId === config.id ? nextProviders[0]?.id : selectedProviderId;
    const roleUpdates = used.flatMap((role) => [[`nyxara.${role}.provider`, ""], [`nyxara.${role}.model`, ""], [roleExecutionSetting(role), PROVIDER_DEFAULT_EXECUTION]] as const);
    await updateSettingsAtomic([[PROVIDER_CONFIGS_SETTING, nextProviders], [DEFAULT_PROVIDER_SETTING, nextDefault ?? ""], ...roleUpdates]);
    await context.secrets.delete(providerSecretKey(config.id));
    if (config.id === "openai-compatible") await context.secrets.delete(LEGACY_SECRET_KEY);
    providerConfigs = nextProviders; selectedProviderId = nextDefault; testedProviderIds.delete(config.id); session.removeProvider(config.id); session.configureAgents(agentSetting);
  };
  const applyRoleAssignments = async (assignments: readonly { readonly role: Role; readonly providerConfigId: string; readonly modelId: string; readonly executionOptions: ExecutionOptions }[]): Promise<void> => {
    if (assignments.length !== ROLES.length || new Set(assignments.map((assignment) => assignment.role)).size !== ROLES.length) throw new Error("Role configuration is incomplete.");
    for (const assignment of assignments) {
      const config = requireProviderConfig(assignment.providerConfigId);
      if (config.signedOut || !assignment.modelId.trim()) throw new Error(`${config.displayName} is signed out or the model ID is missing.`);
      if (config.authStrategy === "api_key" && !(await context.secrets.get(providerSecretKey(config.id))) && !(config.id === "openai-compatible" && await context.secrets.get(LEGACY_SECRET_KEY))) throw new Error(`${config.displayName} credential is missing.`);
      assertRoleCompatibility(config, assignment.role);
      const modelCapabilities = typeof (session.core as any).getModelCapabilities === "function" ? session.core.getModelCapabilities(config.id, assignment.modelId.trim()) : undefined;
      assertExecutionOptionsSupported(assignment.executionOptions, modelCapabilities?.execution ?? knownModelExecutionCapability(config.catalogId ?? config.type, assignment.modelId.trim()));
    }
    await updateSettingsAtomic([...assignments.flatMap((assignment) => [[`nyxara.${assignment.role}.provider`, assignment.providerConfigId], [`nyxara.${assignment.role}.model`, assignment.modelId.trim()], [roleExecutionSetting(assignment.role), assignment.executionOptions]] as const), ["nyxara.modelMode", "advanced"]]);
    session.configureAgents(agentSetting);
  };
  const makeProviderId = (catalogId: string): string => {
    if (!providerConfigs.some((config) => config.id === catalogId)) return catalogId;
    let suffix = 2;
    while (providerConfigs.some((config) => config.id === `${catalogId}-${suffix}`)) suffix += 1;
    return `${catalogId}-${suffix}`;
  };
  const openApiKeyPage = async (definition: ProviderDefinition): Promise<void> => {
    const url = definition.onboarding.apiKeyHelpUrl;
    if (!url) return;
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) throw new Error(`Could not open the ${definition.displayName} API key page.`);
  };
  const offerApiKeyPage = async (definition: ProviderDefinition): Promise<void> => {
    if (!definition.onboarding.apiKeyHelpUrl) return;
    const action = await vscode.window.showInformationMessage(
      `Sign in to the official ${definition.displayName} developer console to create an API key. Nyxara does not access your browser session.`,
      "Open official API key page",
      "Enter existing API key",
    );
    if (action === "Open official API key page") await openApiKeyPage(definition);
  };
  const openCliLogin = (definition: ProviderDefinition): void => {
    if (!definition.cli) return;
    const terminal = vscode.window.createTerminal({ name: `Nyxara: Sign in with ${definition.cli.accountLabel}` });
    terminal.show();
    terminal.sendText(definition.cli.loginCommand.join(" "));
    void vscode.window.showInformationMessage(`Complete ${definition.cli.accountLabel} sign-in in the terminal/browser, then run Connect Provider again.`);
  };
  const confirmCliLogin = async (definition: ProviderDefinition): Promise<boolean> => {
    if (!definition.cli) return true;
    const action = await vscode.window.showInformationMessage(
      `${definition.displayName} uses the official ${definition.cli.command} CLI and its existing account session. Nyxara never reads the cached token.`,
      "Use existing CLI login",
      `Sign in with ${definition.cli.accountLabel}`,
      "Installation help",
    );
    if (action === `Sign in with ${definition.cli.accountLabel}`) { openCliLogin(definition); return false; }
    if (action === "Installation help") { await vscode.env.openExternal(vscode.Uri.parse(definition.cli.installUrl)); return false; }
    return action === "Use existing CLI login";
  };
  const pickManualModel = async (): Promise<string | undefined> => {
    const value = await vscode.window.showInputBox({ prompt: "Model ID", placeHolder: "Enter the exact provider model ID", ignoreFocusOut: true });
    return value?.trim() || undefined;
  };
  const discoverAndPickModel = async (config: ProviderConfig): Promise<string | undefined> => {
    const definition = providerDefinition(config.catalogId ?? config.type);
    if (!definition.onboarding.modelDiscovery) return definition.onboarding.manualModelId ? pickManualModel() : undefined;
    void vscode.window.showInformationMessage(`Testing ${config.displayName}... This uses model discovery and does not generate text.`);
    try {
      const models = await session.core.listModels(config.id);
      if (models.length === 0) return definition.onboarding.manualModelId ? pickManualModel() : undefined;
      const picked = await vscode.window.showQuickPick([...models.map((model: any) => ({ label: model.name || model.id, description: model.id, modelId: model.id })), ...(definition.onboarding.manualModelId ? [{ label: "Enter model ID manually", description: "Preserve the exact requested ID", manual: true }] : [])], { placeHolder: "Choose one default model (used for all roles)" });
      if (!picked) return undefined;
      return picked.manual ? pickManualModel() : picked.modelId;
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
      if ([404, 405, 501].includes(statusCode ?? 0) && definition.onboarding.manualModelId) { void vscode.window.showInformationMessage("Model discovery is unsupported. Enter a model ID manually."); return pickManualModel(); }
      throw error;
    }
  };
  const testProvider = async (config: ProviderConfig): Promise<void> => {
    testedProviderIds.delete(config.id);
    if (config.signedOut) throw new Error(`${config.displayName} is signed out. Reconnect it before testing.`);
    if (config.authStrategy === "api_key" && !(await context.secrets.get(providerSecretKey(config.id))) && !(config.id === "openai-compatible" && await context.secrets.get(LEGACY_SECRET_KEY))) throw Object.assign(new Error("Provider credential is missing"), { code: "authentication_error" });
    void vscode.window.showInformationMessage(`Testing ${config.displayName}... This uses model discovery and does not generate text.`);
    const models = await session.core.listModels(config.id);
    const configuredModel = config.modelId || (setting("nyxara.planner.provider", "") === config.id ? setting("nyxara.planner.model", "") : "");
    if (configuredModel && !models.some((model: any) => model.id === configuredModel)) throw Object.assign(new Error(`Configured model is not available: ${configuredModel}`), { code: "invalid_model" });
    testedProviderIds.add(config.id);
    void vscode.window.showInformationMessage(`Connected to ${config.displayName}. ${models.length} model${models.length === 1 ? "" : "s"} available.`);
  };
  const connectProvider = async (): Promise<void> => {
    const picked = await vscode.window.showQuickPick(PROVIDER_DEFINITIONS.map((definition) => ({ label: definition.displayName, description: definition.description, definition })), { placeHolder: "Choose AI provider" });
    if (!picked) return;
    const definition: ProviderDefinition = picked.definition;
    if (!(await confirmCliLogin(definition))) return;
    let displayName = definition.displayName;
    const existingInstances = providerConfigs.filter((config) => (config.catalogId ?? config.type) === definition.id).length;
    if (existingInstances > 0) {
      const name = await vscode.window.showInputBox({ prompt: "Provider configuration name", value: `${definition.displayName} ${existingInstances + 1}`, ignoreFocusOut: true });
      if (name === undefined) return;
      displayName = name.trim() || `${definition.displayName} ${existingInstances + 1}`;
    }
    if (existingInstances === 0 && (definition.onboarding.category === "compatible" || definition.type === "local-openai-compatible")) {
      const name = await vscode.window.showInputBox({ prompt: "Display name (optional)", value: displayName, ignoreFocusOut: true });
      if (name === undefined) return;
      displayName = name.trim() || displayName;
    }
    let baseUrl = definition.onboarding.defaultEndpoint;
    if (!baseUrl && !definition.cli) {
      const entered = await vscode.window.showInputBox({ prompt: definition.onboarding.category === "local" ? "Local OpenAI-compatible Base URL" : "OpenAI-compatible Base URL", placeHolder: "https://provider.example/v1", ignoreFocusOut: true });
      if (!entered?.trim()) return;
      baseUrl = entered.trim();
    }
    let apiKey: string | undefined;
    if (definition.onboarding.authMethods.includes("api_key")) {
      await offerApiKeyPage(definition);
      apiKey = await vscode.window.showInputBox({ prompt: definition.onboarding.category === "official" ? `${definition.displayName} API key (stored securely)` : "API key (optional; stored securely)", password: true, ignoreFocusOut: true });
      if (definition.onboarding.category === "official" && !apiKey) return;
      if (apiKey === undefined) return;
    }
    const id = makeProviderId(definition.id);
    if (!baseUrl && !definition.cli) return;
    const config: ProviderConfig = {
      id,
      ...(definition.id !== definition.type ? { catalogId: definition.id } : {}),
      type: definition.type,
      displayName,
      ...(baseUrl ? { baseUrl } : {}),
      authStrategy: definition.cli ? "subscription" : definition.onboarding.category === "official" || apiKey ? "api_key" : definition.onboarding.category === "local" ? "local" : "none",
      createdAt: new Date().toISOString(),
    };
    if (apiKey) await context.secrets.store(providerSecretKey(id), apiKey);
    let modelId: string | undefined;
    try {
      session.upsertProvider(config);
      providerConfigs = [...providerConfigs, config];
      selectedProviderId = id;
      await persistProviders();
      modelId = await discoverAndPickModel(config);
      testedProviderIds.add(config.id);
    }
    catch (error) {
      providerConfigs = providerConfigs.filter((candidate) => candidate.id !== id);
      selectedProviderId = defaultProviderId(providerConfigs, "");
      await context.secrets.delete(providerSecretKey(id));
      await persistProviders();
      throw error;
    }
    if (!modelId) return;
    await applySimpleModel(id, modelId);
    void vscode.window.showInformationMessage("Provider connected ✓ Model configured ✓ Start your first task.");
  };
  const configureRoleModels = async (): Promise<void> => {
    if (providerConfigs.length === 0) { await connectProvider(); return; }
    const selections: Array<{ role: Role; providerConfigId: string; modelId: string; executionOptions: ExecutionOptions }> = [];
    for (const role of ROLES) {
      const providerPick = await vscode.window.showQuickPick(providerConfigs.map((config) => ({ label: config.displayName, description: providerDefinition(config.catalogId ?? config.type).description, config })), { placeHolder: `${role[0]?.toUpperCase()}${role.slice(1)} provider` });
      if (!providerPick) return;
      const modelId = await discoverAndPickModel(providerPick.config);
      if (!modelId) return;
      selections.push({ role, providerConfigId: providerPick.config.id, modelId, executionOptions: PROVIDER_DEFAULT_EXECUTION });
    }
    await applyRoleAssignments(selections);
    void vscode.window.showInformationMessage("Advanced role models saved.");
  };
  const chooseDefaultModel = async (): Promise<void> => {
    const config = selectedProvider();
    if (!config) { await connectProvider(); return; }
    const modelId = await discoverAndPickModel(config);
    if (modelId) await applySimpleModel(config.id, modelId);
  };
  const manageProviders = async (): Promise<void> => {
    if (providerConfigs.length === 0) { await connectProvider(); return; }
    const picked = await vscode.window.showQuickPick([...providerConfigs.map((config) => ({ label: config.displayName, description: `${providerDefinition(config.catalogId ?? config.type).description}${config.id === selectedProviderId ? " · Default" : ""}`, config })), { label: "Connect another provider", description: "Add a local provider configuration", connect: true }, { label: "Configure models by role", description: "Advanced", roles: true }], { placeHolder: "Manage Providers" });
    if (!picked) return;
    if (picked.connect) { await connectProvider(); return; }
    if (picked.roles) { await configureRoleModels(); return; }
    const config: ProviderConfig = picked.config;
    const definition = providerDefinition(config.catalogId ?? config.type);
    const action = await vscode.window.showQuickPick([{ label: "Use as default", action: "default" }, ...(definition.onboarding.authMethods.includes("api_key") ? [{ label: "Update credential", description: "Stored securely; current value is never shown", action: "credential" }] : []), ...(definition.onboarding.apiKeyHelpUrl ? [{ label: "Open official API key page", description: "Sign in with your browser, then return to Nyxara", action: "api-key-page" }] : []), ...(definition.cli ? [{ label: `Sign in with ${definition.cli.accountLabel}`, description: "Uses the official CLI login flow", action: "cli-login" }, { label: "CLI installation help", action: "cli-install" }] : []), { label: "Test connection", description: definition.cli ? "Checks CLI installation and login without generating" : "Does not generate text", action: "test" }, ...(!definition.cli && definition.onboarding.category !== "official" ? [{ label: "Edit name and endpoint", action: "edit" }] : []), { label: "Configure models by role", description: "Advanced", action: "roles" }, ...(config.authStrategy === "api_key" || config.authStrategy === "subscription" ? [{ label: config.authStrategy === "subscription" ? "Sign Out" : "Disconnect", description: "Keeps provider settings, models, roles, and history", action: "signout" }] : []), { label: "Remove Provider", description: "Deletes this provider configuration and scoped credential", action: "remove" }], { placeHolder: config.displayName });
    if (!action) return;
    if (action.action === "default") {
      const modelId = await discoverAndPickModel(config); if (!modelId) return;
      await applySimpleModel(config.id, modelId);
      void vscode.window.showInformationMessage(`${config.displayName} is now the default provider.`);
    } else if (action.action === "credential") {
      await updateProviderCredential(config);
    } else if (action.action === "api-key-page") {
      await openApiKeyPage(definition);
    } else if (action.action === "cli-login") {
      openCliLogin(definition);
    } else if (action.action === "cli-install") {
      if (definition.cli) await vscode.env.openExternal(vscode.Uri.parse(definition.cli.installUrl));
    } else if (action.action === "test") await testProvider(config);
    else if (action.action === "edit") {
      const name = await vscode.window.showInputBox({ prompt: "Display name", value: config.displayName, ignoreFocusOut: true }); if (!name?.trim()) return;
      const baseUrl = await vscode.window.showInputBox({ prompt: "Base URL", value: config.baseUrl, ignoreFocusOut: true }); if (!baseUrl?.trim()) return;
      const edited = { ...config, displayName: name.trim(), baseUrl: baseUrl.trim() };
      session.upsertProvider(edited); providerConfigs = providerConfigs.map((candidate) => candidate.id === config.id ? edited : candidate); await persistProviders();
    } else if (action.action === "roles") await configureRoleModels();
    else if (action.action === "signout") await signOutProvider(config);
    else if (action.action === "remove") await removeProvider(config);
  };

  const register = (name: string, handler: () => Promise<void> | void) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { await handler(); webview.refresh(); }
    catch (error) {
      const message = providerConnectionMessage(error, selectedProvider()?.displayName ?? "Provider");
      output.appendLine(`${name}: ${message}`);
      if (message === "Configured model unavailable. Choose another model.") {
        const action = await vscode.window.showErrorMessage(message, "Choose another model");
        if (action === "Choose another model") void vscode.commands.executeCommand("nyxara.chooseDefaultModel");
      } else void vscode.window.showErrorMessage(message);
    }
  }));
  session.configureAgents(agentSetting);
  register("nyxara.open", () => vscode.commands.executeCommand("workbench.view.extension.nyxara"));
  register("nyxara.connectProvider", connectProvider);
  register("nyxara.configureProvider", connectProvider);
  register("nyxara.manageProviders", manageProviders);
  register("nyxara.configureRoleModels", configureRoleModels);
  register("nyxara.chooseDefaultModel", chooseDefaultModel);
  register("nyxara.changeProvider", manageProviders);
  register("nyxara.about", () => { void vscode.window.showInformationMessage(`Nyxara v${version} · Local Dogfood`); });
  register("nyxara.testProviderConnection", async () => { const config = selectedProvider(); if (!config) throw new Error("No AI provider connected."); await testProvider(config); });
  register("nyxara.generatePlan", async () => {
    if (!session.configured) { void vscode.window.showInformationMessage("Connect a provider and choose a model first."); return; }
    const root = await workspaceRoot(); if (!root) return;
    const prompt = await vscode.window.showInputBox({ prompt: "What do you want to build?", ignoreFocusOut: true }); if (!prompt?.trim()) return;
    const profiles = session.core.listPlanningProfiles();
    const profilePick = await vscode.window.showQuickPick(profiles.map((profile: any) => ({ label: profile.name, description: profile.id, profile })), { placeHolder: "Select planning profile" });
    const profile = profilePick?.profile.id ?? setting("nyxara.planningProfile", "default");
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Nyxara: generating plan" }, () => startRequirement(prompt.trim(), root, profile));
  });
  register("nyxara.regenerate", async () => { const root = await workspaceRoot(); if (!root || !session.prompt || session.snapshot?.status !== "awaiting_plan_approval") return; await session.regenerate(session.prompt, root, setting("nyxara.planningProfile", "default")); });
  register("nyxara.approveAndRun", async () => { const outcome = await session.approveAndRun(); if (outcome.status === "waiting_for_permission") void vscode.window.showInformationMessage("Nyxara is waiting for permission."); });
  register("nyxara.rejectPlan", () => { session.rejectPlan(); void vscode.window.showInformationMessage("Plan rejected."); });
  register("nyxara.pause", () => session.pause());
  register("nyxara.resume", async () => { await session.resume(); });
  register("nyxara.abort", () => { session.abort(); void vscode.window.showInformationMessage("Workflow aborted; existing repository changes remain."); });
  register("nyxara.allowOnce", async () => { const pending = session.snapshot?.pendingPermission; if (pending) await session.resolvePermission(pending.id, "allow"); });
  register("nyxara.denyPermission", async () => { const pending = session.snapshot?.pendingPermission; if (pending) await session.resolvePermission(pending.id, "deny"); });
  register("nyxara.setApiKey", async () => { const config = selectedProvider(); if (!config) { await connectProvider(); return; } const value = await vscode.window.showInputBox({ prompt: `${config.displayName} API key (stored securely)`, password: true, ignoreFocusOut: true }); if (value) await context.secrets.store(providerSecretKey(config.id), value); });
  output.appendLine("Nyxara extension activated");
}

export async function deactivate(): Promise<void> { await activeHistoryStore?.flush(); activeHistoryStore = undefined; }
