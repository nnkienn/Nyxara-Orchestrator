import type { WorkspaceViewState } from "./workspace-state.js";
import type { SettingsSection } from "./settings-projection.js";
import { PROVIDER_DEFAULT_EXECUTION, parseExecutionOptions, type ExecutionOptions } from "@nyxara/provider-sdk";

export const MAX_TASK_INPUT = 20_000;
export const MAX_FIELD_INPUT = 2_048;
export const MAX_HISTORY_SEARCH = 200;

export type WebviewToExtensionMessage =
  | { readonly type: "ready" }
  | { readonly type: "submitRequirement"; readonly task: string }
  | { readonly type: "selectModel"; readonly providerConfigId: string; readonly modelId: string }
  | { readonly type: "openProviderSetup" }
  | { readonly type: "openSettings" }
  | { readonly type: "closeSettings" }
  | { readonly type: "openSettingsSection"; readonly section: SettingsSection; readonly providerConfigId?: string }
  | { readonly type: "searchSettings"; readonly query: string }
  | { readonly type: "connectProvider" }
  | { readonly type: "testProvider"; readonly providerConfigId: string }
  | { readonly type: "updateCredential"; readonly providerConfigId: string }
  | { readonly type: "updateProviderMetadata"; readonly providerConfigId: string; readonly displayName: string; readonly endpoint: string }
  | { readonly type: "signOutProvider"; readonly providerConfigId: string }
  | { readonly type: "removeProvider"; readonly providerConfigId: string }
  | { readonly type: "setDefaultProvider"; readonly providerConfigId: string }
  | { readonly type: "setDefaultModel"; readonly providerConfigId: string; readonly modelId: string; readonly executionOptions: ExecutionOptions }
  | { readonly type: "updateRoleAssignments"; readonly assignments: readonly { readonly role: "planner" | "executor" | "reviewer"; readonly providerConfigId: string; readonly modelId: string; readonly executionOptions: ExecutionOptions }[] }
  | { readonly type: "updatePlanningProfile"; readonly profileId: string }
  | { readonly type: "updateHistoryRetention"; readonly retention: 20 | 50 | 100 }
  | { readonly type: "selectWorkspaceRoot"; readonly rootId: string }
  | { readonly type: "requestDiagnostics" }
  | { readonly type: "copyDiagnostics" }
  | { readonly type: "approvePlan" }
  | { readonly type: "rejectPlan" }
  | { readonly type: "allowPermission"; readonly requestId: string }
  | { readonly type: "denyPermission"; readonly requestId: string }
  | { readonly type: "abortWorkflow" }
  | { readonly type: "pauseWorkflow" }
  | { readonly type: "resumeWorkflow" }
  | { readonly type: "newTask" }
  | { readonly type: "openHistory" }
  | { readonly type: "listTasks"; readonly scope: "current" | "all" }
  | { readonly type: "searchTasks"; readonly query: string }
  | { readonly type: "filterTasks"; readonly filter: "all" | "active" | "completed" | "failed" | "interrupted" }
  | { readonly type: "openTask"; readonly taskId: string }
  | { readonly type: "deleteTask"; readonly taskId: string }
  | { readonly type: "clearHistory" }
  | { readonly type: "returnToActiveTask" };

export type StateMessageType =
  | "initialState"
  | "providerState"
  | "modelState"
  | "planningStarted"
  | "planReady"
  | "workflowSnapshot"
  | "permissionRequired"
  | "validationUpdated"
  | "reviewUpdated"
  | "repairUpdated"
  | "workflowCompleted"
  | "workflowFailed"
  | "recentTasks"
  | "taskHistory"
  | "historySearchResults"
  | "historicalTaskLoaded"
  | "historyUpdated"
  | "historyCleared"
  | "settingsProjection"
  | "providerConfigs"
  | "providerStatusChanged"
  | "roleAssignmentsChanged"
  | "planningProfiles"
  | "rulesProjection"
  | "permissionPolicyProjection"
  | "validationProjection"
  | "repairProjection"
  | "historySettings"
  | "workspaceSettings"
  | "diagnostics";

export type ExtensionToWebviewMessage =
  | { readonly type: StateMessageType; readonly state: WorkspaceViewState }
  | { readonly type: "safeError"; readonly message: string };

export function parseWebviewMessage(value: unknown): WebviewToExtensionMessage | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined;
  const text = (key: string, max = MAX_FIELD_INPUT): string | undefined => typeof value[key] === "string" && value[key].length <= max ? value[key] as string : undefined;
  switch (value.type) {
    case "ready": case "approvePlan": case "rejectPlan": case "abortWorkflow": case "pauseWorkflow": case "resumeWorkflow": case "newTask": case "openProviderSetup": case "openSettings": case "closeSettings": case "connectProvider": case "openHistory": case "clearHistory": case "returnToActiveTask": case "requestDiagnostics": case "copyDiagnostics": return { type: value.type };
    case "openSettingsSection": {
      const section = text("section", 40) as SettingsSection | undefined;
      const sections: SettingsSection[] = ["home", "aiProviders", "modelsRoles", "workflow", "planning", "engineeringRules", "permissions", "context", "validation", "review", "repair", "usage", "taskHistory", "workspace", "privacy", "advanced", "about"];
      const providerConfigId = text("providerConfigId", 200)?.trim();
      return section && sections.includes(section) ? { type: value.type, section, ...(providerConfigId ? { providerConfigId } : {}) } : undefined;
    }
    case "searchSettings": { const query = text("query", MAX_HISTORY_SEARCH); return query !== undefined ? { type: value.type, query: query.trim() } : undefined; }
    case "testProvider": case "updateCredential": case "signOutProvider": case "removeProvider": case "setDefaultProvider": {
      const providerConfigId = text("providerConfigId", 200)?.trim(); return providerConfigId ? { type: value.type, providerConfigId } : undefined;
    }
    case "setDefaultModel": { const providerConfigId = text("providerConfigId", 200)?.trim(); const modelId = text("modelId")?.trim(); const executionOptions = value.executionOptions === undefined ? PROVIDER_DEFAULT_EXECUTION : parseExecutionOptions(value.executionOptions); return providerConfigId && modelId && executionOptions ? { type: value.type, providerConfigId, modelId, executionOptions } : undefined; }
    case "updateProviderMetadata": { const providerConfigId = text("providerConfigId", 200)?.trim(); const displayName = text("displayName", 100)?.trim(); const endpoint = text("endpoint")?.trim(); return providerConfigId && displayName && endpoint ? { type: value.type, providerConfigId, displayName, endpoint } : undefined; }
    case "updatePlanningProfile": { const profileId = text("profileId", 100)?.trim(); return profileId ? { type: value.type, profileId } : undefined; }
    case "updateHistoryRetention": return [20, 50, 100].includes(Number(value.retention)) ? { type: value.type, retention: Number(value.retention) as 20 | 50 | 100 } : undefined;
    case "selectWorkspaceRoot": { const rootId = text("rootId", 100)?.trim(); return rootId ? { type: value.type, rootId } : undefined; }
    case "updateRoleAssignments": {
      if (!Array.isArray(value.assignments) || value.assignments.length !== 3) return undefined;
      const assignments = value.assignments.flatMap((item): Array<{ role: "planner" | "executor" | "reviewer"; providerConfigId: string; modelId: string; executionOptions: ExecutionOptions }> => {
        if (!record(item) || !["planner", "executor", "reviewer"].includes(String(item.role))) return [];
        const providerConfigId = typeof item.providerConfigId === "string" ? item.providerConfigId.trim() : "";
        const modelId = typeof item.modelId === "string" ? item.modelId.trim() : "";
        const executionOptions = parseExecutionOptions(item.executionOptions);
        return providerConfigId && providerConfigId.length <= MAX_FIELD_INPUT && modelId && modelId.length <= MAX_FIELD_INPUT && executionOptions ? [{ role: item.role as "planner" | "executor" | "reviewer", providerConfigId, modelId, executionOptions }] : [];
      });
      return assignments.length === 3 && new Set(assignments.map((item) => item.role)).size === 3 ? { type: value.type, assignments } : undefined;
    }
    case "selectModel": { const providerConfigId = text("providerConfigId"); const modelId = text("modelId"); return providerConfigId?.trim() && modelId?.trim() ? { type: value.type, providerConfigId: providerConfigId.trim(), modelId: modelId.trim() } : undefined; }
    case "submitRequirement": { const task = text("task", MAX_TASK_INPUT); return task?.trim() ? { type: value.type, task: task.trim() } : undefined; }
    case "allowPermission": case "denyPermission": { const requestId = text("requestId"); return requestId ? { type: value.type, requestId } : undefined; }
    case "listTasks": return value.scope === "current" || value.scope === "all" ? { type: value.type, scope: value.scope } : undefined;
    case "searchTasks": { const query = text("query", MAX_HISTORY_SEARCH); return query !== undefined ? { type: value.type, query: query.trim() } : undefined; }
    case "filterTasks": return ["all", "active", "completed", "failed", "interrupted"].includes(String(value.filter)) ? { type: value.type, filter: value.filter as "all" | "active" | "completed" | "failed" | "interrupted" } : undefined;
    case "openTask": case "deleteTask": { const taskId = text("taskId", 200); return taskId?.trim() ? { type: value.type, taskId: taskId.trim() } : undefined; }
    default: return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
