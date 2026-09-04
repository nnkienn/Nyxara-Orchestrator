import { describe, expect, it } from "vitest";
import { MAX_HISTORY_SEARCH, MAX_TASK_INPUT, parseWebviewMessage } from "../src/webview-protocol.js";

describe("webview message boundary", () => {
  it("accepts known messages and normalizes task and model input", () => {
    expect(parseWebviewMessage({ type: "submitRequirement", task: "  small task  " })).toEqual({ type: "submitRequirement", task: "small task" });
    expect(parseWebviewMessage({ type: "selectModel", providerConfigId: " gateway ", modelId: " routed/exact " })).toEqual({ type: "selectModel", providerConfigId: "gateway", modelId: "routed/exact" });
    expect(parseWebviewMessage({ type: "ready", unexpected: "ignored" })).toEqual({ type: "ready" });
  });

  it("rejects unknown, empty, malformed, and oversized payloads", () => {
    expect(parseWebviewMessage({ type: "unknown" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "submitRequirement", task: " ".repeat(3) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "submitRequirement", task: "x".repeat(MAX_TASK_INPUT + 1) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "selectModel", providerConfigId: 123, modelId: "x" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "allowPermission", requestId: "x".repeat(2_049) })).toBeUndefined();
  });

  it("accepts bounded local history actions and rejects malformed IDs and searches", () => {
    expect(parseWebviewMessage({ type: "openHistory" })).toEqual({ type: "openHistory" });
    expect(parseWebviewMessage({ type: "listTasks", scope: "current" })).toEqual({ type: "listTasks", scope: "current" });
    expect(parseWebviewMessage({ type: "filterTasks", filter: "interrupted" })).toEqual({ type: "filterTasks", filter: "interrupted" });
    expect(parseWebviewMessage({ type: "searchTasks", query: "  paging  " })).toEqual({ type: "searchTasks", query: "paging" });
    expect(parseWebviewMessage({ type: "openTask", taskId: "task/exact" })).toEqual({ type: "openTask", taskId: "task/exact" });
    expect(parseWebviewMessage({ type: "deleteTask", taskId: " " })).toBeUndefined();
    expect(parseWebviewMessage({ type: "openTask", taskId: "x".repeat(201) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "searchTasks", query: "x".repeat(MAX_HISTORY_SEARCH + 1) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "openPerformance" })).toEqual({ type: "openPerformance" });
    expect(parseWebviewMessage({ type: "openPerformance", taskId: " history/exact " })).toEqual({ type: "openPerformance", taskId: "history/exact" });
    expect(parseWebviewMessage({ type: "openPerformance", taskId: " " })).toBeUndefined();
    expect(parseWebviewMessage({ type: "closePerformance" })).toEqual({ type: "closePerformance" });
  });

  it("validates every mutating Settings message and rejects allow-all or partial role payloads", () => {
    expect(parseWebviewMessage({ type: "openSettingsSection", section: "review" })).toEqual({ type: "openSettingsSection", section: "review" });
    expect(parseWebviewMessage({ type: "signOutProvider", providerConfigId: " work " })).toEqual({ type: "signOutProvider", providerConfigId: "work" });
    expect(parseWebviewMessage({ type: "updateHistoryRetention", retention: 20 })).toEqual({ type: "updateHistoryRetention", retention: 20 });
    expect(parseWebviewMessage({ type: "updateHistoryRetention", retention: "unlimited" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "disablePermissions", allowAll: true })).toBeUndefined();
    expect(parseWebviewMessage({ type: "updateProviderMetadata", providerConfigId: "p", displayName: "Work", endpoint: "https://example.test/v1" })).toEqual({ type: "updateProviderMetadata", providerConfigId: "p", displayName: "Work", endpoint: "https://example.test/v1" });
    expect(parseWebviewMessage({ type: "updateRoleAssignments", assignments: [{ role: "planner", providerConfigId: "p", modelId: "m" }] })).toBeUndefined();
    const assignments = [{ role: "planner", providerConfigId: "p1", modelId: "m1", executionOptions: { kind: "provider_default" } }, { role: "executor", providerConfigId: "p2", modelId: "m2", executionOptions: { kind: "openai_reasoning", effort: "medium" } }, { role: "reviewer", providerConfigId: "p3", modelId: "m3", executionOptions: { kind: "gemini_thinking_level", level: "high" } }];
    expect(parseWebviewMessage({ type: "updateRoleAssignments", assignments })).toEqual({ type: "updateRoleAssignments", assignments });
    expect(parseWebviewMessage({ type: "updateRoleAssignments", assignments: assignments.map((item, index) => index === 1 ? { ...item, executionOptions: { kind: "provider_default", apiKey: "secret" } } : item) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "setDefaultModel", providerConfigId: "p", modelId: "m", executionOptions: { kind: "anthropic_thinking", enabled: true, budgetTokens: Number.NaN } })).toBeUndefined();
  });
});
