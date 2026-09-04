import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  commands: new Map<string, (...args: any[]) => any>(), settings: new Map<string, any>(), updates: [] as Array<[string, unknown, unknown]>, failNextUpdateKey: undefined as string | undefined, inputs: [] as Array<string | undefined>, inputOptions: [] as any[], pickIndexes: [] as Array<number | undefined>, pickCalls: [] as any[][], errors: [] as string[], info: [] as string[], infoResults: [] as Array<string | undefined>, externalUrls: [] as string[], clipboard: [] as string[], terminals: [] as Array<{ name: string; commands: string[]; shown: boolean }>, providers: [] as any[], workspaceFolders: [] as any[], warnings: [] as string[], warningResult: "Disconnect" as string | undefined, output: { appendLine: vi.fn(), dispose: vi.fn() },
}));

vi.mock("vscode", () => {
  class TreeItem { label: string; description?: string; command?: any; constructor(label: string) { this.label = label; } }
  class EventEmitter { event = vi.fn(); fire = vi.fn(); }
  return {
    TreeItem, EventEmitter, TreeItemCollapsibleState: { None: 0 }, ProgressLocation: { Notification: 15 }, Uri: { parse: (value: string) => ({ value }), joinPath: (base: any, ...parts: string[]) => ({ value: [base?.value ?? "extension", ...parts].join("/"), toString() { return this.value; } }) }, env: { openExternal: vi.fn(async (uri: { value: string }) => { mock.externalUrls.push(uri.value); return true; }), clipboard: { writeText: vi.fn(async (value: string) => { mock.clipboard.push(value); }) } },
    commands: { registerCommand: vi.fn((name: string, handler: (...args: any[]) => any) => { mock.commands.set(name, handler); return { dispose: vi.fn() }; }), executeCommand: vi.fn() },
    workspace: {
      get workspaceFolders() { return mock.workspaceFolders; },
      getConfiguration: vi.fn(() => ({ get: (key: string, fallback: any) => mock.settings.has(key) ? mock.settings.get(key) : fallback, update: async (key: string, value: unknown, target: unknown) => { if (mock.failNextUpdateKey === key) { mock.failNextUpdateKey = undefined; throw new Error("settings write failed"); } mock.updates.push([key, value, target]); mock.settings.set(key, value); } })),
    },
    window: {
      createOutputChannel: vi.fn(() => mock.output), registerWebviewViewProvider: vi.fn((_id: string, provider: any) => { mock.providers.push(provider); return { dispose: vi.fn() }; }), createTerminal: vi.fn((options: { name: string }) => { const state = { name: options.name, commands: [] as string[], shown: false }; mock.terminals.push(state); return { show: () => { state.shown = true; }, sendText: (command: string) => { state.commands.push(command); }, dispose: vi.fn() }; }),
      showQuickPick: vi.fn(async (items: any[]) => { mock.pickCalls.push(items); const index = mock.pickIndexes.length ? mock.pickIndexes.shift() : 0; return index === undefined ? undefined : items[index]; }),
      showInputBox: vi.fn(async (options: any) => { mock.inputOptions.push(options); return mock.inputs.shift(); }),
      showErrorMessage: vi.fn(async (message: string) => { mock.errors.push(message); }), showInformationMessage: vi.fn(async (message: string) => { mock.info.push(message); return mock.infoResults.shift(); }),
      showWarningMessage: vi.fn(async (message: string) => { mock.warnings.push(message); return mock.warningResult; }),
      withProgress: vi.fn(async (_options: unknown, task: () => any) => task()),
    },
  };
}, { virtual: true });

import { activate, providerConnectionMessage, workspaceRoot } from "../src/extension.js";
import { readFileSync } from "node:fs";

const EXTENSION_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function fakeSession(configured = false) {
  const core = { listModels: vi.fn(async () => [{ id: "ha-op/gpt-5.6-sol", name: "Routed" }]), listProviders: vi.fn(() => []), getModelCapabilities: vi.fn(() => undefined), listPlanningProfiles: vi.fn(() => [{ id: "default", name: "Default", outputLanguage: "en", planStyle: "balanced", riskMode: "balanced" }]), listEngineeringRules: vi.fn(() => []), configureAgent: vi.fn(), createPlan: vi.fn(), runApprovedPlan: vi.fn(), startWorkflow: vi.fn() };
  return { core, configured, validation: new Map(), validationDurations: new Map(), currentPlan: undefined as any, snapshot: undefined as any, result: undefined as any, prompt: undefined as string | undefined, reviewStatus: undefined as string | undefined, reviewFindingCount: undefined as number | undefined, repairCycle: undefined as number | undefined, onChange: undefined as (() => void) | undefined, upsertProvider: vi.fn(), removeProvider: vi.fn(), configureAgents: vi.fn(), generate: vi.fn(), regenerate: vi.fn(), approveAndRun: vi.fn(async () => ({ status: "paused" })), rejectPlan: vi.fn(), pause: vi.fn(), resume: vi.fn(), abort: vi.fn(), resolvePermission: vi.fn(), resetPresentation: vi.fn() };
}

function activateFake(session = fakeSession()) {
  const secretValues = new Map<string, string>();
  const secrets = { get: vi.fn(async (key: string) => secretValues.get(key)), store: vi.fn(async (key: string, value: string) => { secretValues.set(key, value); }), delete: vi.fn(async (key: string) => { secretValues.delete(key); }) };
  const globalState = { update: vi.fn() }; const workspaceState = { update: vi.fn() };
  const context = { subscriptions: [] as any[], secrets, globalState, workspaceState, extensionUri: { value: "extension", toString: () => "extension" }, extension: { packageJSON: { version: EXTENSION_VERSION } } };
  activate(context as any, session as any);
  return { session, context, secrets, secretValues, globalState, workspaceState };
}

function resolveRegisteredWebview() {
  const posted: any[] = [];
  let receive: ((message: unknown) => void) | undefined;
  const webview = {
    options: undefined as any,
    html: "",
    cspSource: "vscode-webview://test",
    asWebviewUri: (uri: any) => uri,
    onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return { dispose: vi.fn() }; },
    postMessage: vi.fn(async (message: unknown) => { posted.push(message); return true; }),
  };
  mock.providers[0].resolveWebviewView({ webview });
  return { posted, webview, receive: (message: unknown) => receive?.(message) };
}

const OPENAI = { id: "openai", type: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", authStrategy: "api_key" };
const GATEWAY = { id: "openai-compatible", type: "openai-compatible", displayName: "Work Gateway", baseUrl: "https://router.example/v1", authStrategy: "api_key" };
const CODEX_CLI = { id: "codex-cli", type: "codex-cli", displayName: "OpenAI Codex (ChatGPT)", authStrategy: "subscription" };
const terminalUsage = { workflowId: "terminal", planner: { role: "planner", providerConfigId: "openai", providerId: "openai", requestedModelId: "route/gpt", resolvedModelId: "gpt", executionProfileSummary: { kind: "provider_default" }, calls: 1, inputTokens: 8, outputTokens: 2, totalTokens: 10, usageSource: "provider_reported", providerDurationMs: 50 }, executor: { role: "executor", calls: 0 }, reviewer: { role: "reviewer", calls: 0 }, repair: { role: "repair", calls: 0 }, tasks: [], totalProviderCalls: 1, totalInputTokens: 8, totalOutputTokens: 2, totalTokens: 10, totalProviderDurationMs: 50, totalToolCalls: 0, usageSource: "provider_reported", providerReportedCost: null, estimatedCost: null, currency: null, costSource: "unavailable", totalDurationMs: 80, repairCycles: 0 };

describe("VS Code provider onboarding and command safety", () => {
  beforeEach(() => {
    mock.commands.clear(); mock.settings.clear(); mock.updates.length = 0; mock.failNextUpdateKey = undefined; mock.inputs.length = 0; mock.inputOptions.length = 0; mock.pickIndexes.length = 0; mock.pickCalls.length = 0; mock.errors.length = 0; mock.info.length = 0; mock.infoResults.length = 0; mock.externalUrls.length = 0; mock.clipboard.length = 0; mock.terminals.length = 0; mock.providers.length = 0; mock.workspaceFolders.length = 0; mock.warnings.length = 0; mock.warningResult = "Disconnect"; vi.clearAllMocks();
  });

  it("activation only registers UI and performs no provider, credential, repository, workflow, or timer work", () => {
    vi.useFakeTimers(); const { session, secrets } = activateFake();
    expect(mock.commands.size).toBe(19); expect(session.core.listModels).not.toHaveBeenCalled(); expect(session.core.createPlan).not.toHaveBeenCalled(); expect(session.core.runApprovedPlan).not.toHaveBeenCalled(); expect(session.core.startWorkflow).not.toHaveBeenCalled(); expect(secrets.get).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(86_400_000); expect(session.core.listModels).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  it("registers the main sidebar as a Webview without opening provider setup", () => {
    activateFake();
    expect(mock.providers).toHaveLength(1);
    expect(mock.providers[0]).toHaveProperty("resolveWebviewView");
    expect(mock.pickCalls).toHaveLength(0);
  });

  it("opening the Webview reconstructs state without provider calls, discovery, repository scans, or timers", () => {
    vi.useFakeTimers();
    const { session } = activateFake();
    const view = resolveRegisteredWebview();
    expect(view.posted[0]).toMatchObject({ type: "initialState", state: { configured: false, workspace: { available: false } } });
    expect(session.core.listModels).not.toHaveBeenCalled();
    expect(session.core.createPlan).not.toHaveBeenCalled();
    expect(session.core.startWorkflow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("opens and closes live Performance from terminal Core usage with no provider/model/repository/process/timer work", async () => {
    vi.useFakeTimers(); mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "route/gpt" }]);
    const session = fakeSession(true); session.snapshot = { workflowId: "terminal", status: "completed", tasks: [], usage: terminalUsage }; session.result = { status: "completed", changedFiles: [], durationMs: 80, repairCycles: 0, usage: terminalUsage };
    activateFake(session); const view = resolveRegisteredWebview();
    view.receive({ type: "openPerformance" }); await vi.advanceTimersByTimeAsync(0); await Promise.resolve();
    expect(view.posted.at(-1)).toMatchObject({ type: "performanceProjection", state: { performanceView: { source: "live", taskStatus: "completed", projection: { overview: { totalTokens: 10 } } } } });
    expect(session.core.listModels).not.toHaveBeenCalled(); expect(session.core.createPlan).not.toHaveBeenCalled(); expect(session.core.runApprovedPlan).not.toHaveBeenCalled(); expect(session.core.startWorkflow).not.toHaveBeenCalled(); expect(mock.pickCalls).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    view.receive({ type: "closePerformance" }); await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); expect(view.posted.at(-1)?.state.performanceView).toBeUndefined();
    vi.useRealTimers();
  });

  it("rejects an unknown historical Performance task ID without external work", async () => {
    const session = fakeSession(); activateFake(session); const view = resolveRegisteredWebview();
    view.receive({ type: "openPerformance", taskId: "../../not-a-task" }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError"));
    expect(session.core.listModels).not.toHaveBeenCalled(); expect(session.core.createPlan).not.toHaveBeenCalled(); expect(session.core.startWorkflow).not.toHaveBeenCalled();
  });

  it("opens a native provider chooser with official, compatible, and local labels", async () => {
    activateFake(); mock.pickIndexes.push(undefined); await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.pickCalls[0].map((item: any) => [item.label, item.description])).toEqual(expect.arrayContaining([["OpenAI", "Official Provider"], ["Anthropic / Claude", "Official Provider"], ["Custom OpenAI-compatible", "Compatible Gateway"], ["Ollama", "Local Provider"]]));
    expect(mock.pickCalls[0].map((item: any) => [item.label, item.description])).toEqual(expect.arrayContaining([["OpenAI Codex (ChatGPT)", "ChatGPT Subscription"], ["Claude Code (Claude account)", "Claude Subscription"], ["Gemini CLI (Google account)", "Google Account"]]));
    expect(mock.pickCalls[0].flatMap((item: any) => item.label)).not.toContain("Continue with OpenAI");
  });

  it.each([
    [0, "Use existing CLI login", "codex-cli"],
    [1, "Use existing CLI login", "claude-code-cli"],
    [2, "Use existing CLI login", "gemini-cli"],
  ])("connects subscription CLI provider %s without asking for or storing an API key", async (providerIndex, action, type) => {
    const { session, secrets } = activateFake(); mock.pickIndexes.push(providerIndex, 0); mock.infoResults.push(action);
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(session.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ id: type, type, authStrategy: "subscription" }));
    expect(session.upsertProvider.mock.calls[0]?.[0]).not.toHaveProperty("baseUrl");
    expect(secrets.store).not.toHaveBeenCalled();
    expect(mock.inputOptions).toHaveLength(0);
    for (const role of ["planner", "executor", "reviewer"]) expect(mock.settings.get(`nyxara.${role}.provider`)).toBe(type);
  });

  it.each([
    [0, "ChatGPT", "codex login"],
    [1, "Claude", "claude auth login"],
    [2, "Google", "gemini"],
  ])("starts only the official login command for subscription provider %s", async (providerIndex, account, command) => {
    const { session } = activateFake(); mock.pickIndexes.push(providerIndex); mock.infoResults.push(`Sign in with ${account}`);
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.terminals).toEqual([{ name: `Nyxara: Sign in with ${account}`, commands: [command], shown: true }]);
    expect(session.upsertProvider).not.toHaveBeenCalled();
  });

  it("opens only official CLI installation help when requested", async () => {
    activateFake(); mock.pickIndexes.push(2); mock.infoResults.push("Installation help");
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.externalUrls).toEqual(["https://www.geminicli.com/docs/get-started/installation"]);
  });

  it("OpenAI asks only for an API key, stores it in SecretStorage, and applies one exact model to all roles", async () => {
    const { session, secrets, globalState, workspaceState } = activateFake(); mock.pickIndexes.push(3, 0); mock.inputs.push("sk-fake-openai-test");
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.inputOptions.map((option) => option.prompt)).toEqual(["OpenAI API key (stored securely)"]); expect(secrets.store).toHaveBeenCalledWith("provider/openai/api-key", "sk-fake-openai-test");
    expect(JSON.stringify(mock.updates)).not.toContain("sk-fake-openai-test"); expect(globalState.update).not.toHaveBeenCalled(); expect(workspaceState.update).not.toHaveBeenCalled();
    for (const role of ["planner", "executor", "reviewer"]) { expect(mock.updates).toContainEqual([`nyxara.${role}.provider`, "openai", true]); expect(mock.updates).toContainEqual([`nyxara.${role}.model`, "ha-op/gpt-5.6-sol", true]); }
    expect(session.upsertProvider).toHaveBeenCalledWith(expect.objectContaining(OPENAI)); expect(session.configureAgents).toHaveBeenCalledTimes(2); expect(mock.info.join(" ")).toContain("Provider connected ✓");
  });

  it.each([
    [3, "OpenAI", "https://platform.openai.com/api-keys", "openai-key"],
    [4, "Anthropic / Claude", "https://console.anthropic.com/settings/keys", "anthropic-key"],
    [5, "Google Gemini", "https://aistudio.google.com/app/apikey", "gemini-key"],
  ])("offers the official API key page during %s onboarding without reading the browser session", async (providerIndex, displayName, url, key) => {
    activateFake(); mock.pickIndexes.push(providerIndex, 0); mock.infoResults.push("Open official API key page"); mock.inputs.push(key);
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.info[0]).toContain(`official ${displayName} developer console`);
    expect(mock.info[0]).toContain("does not access your browser session");
    expect(mock.externalUrls).toEqual([url]);
  });

  it("Anthropic official onboarding never asks for Base URL or offers browser auth", async () => {
    const { session, secrets } = activateFake(); mock.pickIndexes.push(4, 0); mock.inputs.push("anthropic-fake-key");
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.inputOptions.map((option) => option.prompt)).toEqual(["Anthropic / Claude API key (stored securely)"]); expect(secrets.store).toHaveBeenCalledWith("provider/anthropic/api-key", "anthropic-fake-key");
    expect(session.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ type: "anthropic", baseUrl: "https://api.anthropic.com" })); expect(mock.terminals).toHaveLength(0); expect(mock.externalUrls).toHaveLength(0);
  });

  it("compatible setup requests name and Base URL, permits no key, and preserves routed manual IDs", async () => {
    const { session, secrets } = activateFake(); mock.pickIndexes.push(10, 1); mock.inputs.push("Work Gateway", "https://router.example/v1", "", "ha-op/gpt-5.6-sol");
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(mock.inputOptions.map((option) => option.prompt)).toEqual(["Display name (optional)", "OpenAI-compatible Base URL", "API key (optional; stored securely)", "Model ID"]); expect(secrets.store).not.toHaveBeenCalled();
    expect(session.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Work Gateway", type: "openai-compatible", authStrategy: "none" }));
    for (const role of ["planner", "executor", "reviewer"]) expect(mock.settings.get(`nyxara.${role}.model`)).toBe("ha-op/gpt-5.6-sol");
  });

  it("falls back to exact manual model entry when model discovery is unsupported", async () => {
    const session = fakeSession();
    session.core.listModels.mockRejectedValueOnce(Object.assign(new Error("Not found"), { statusCode: 404 }));
    activateFake(session);
    mock.pickIndexes.push(10);
    mock.inputs.push("Gateway", "https://router.example/v1", "", "route/manual-exact");
    await mock.commands.get("nyxara.connectProvider")?.();
    for (const role of ["planner", "executor", "reviewer"]) expect(mock.settings.get(`nyxara.${role}.model`)).toBe("route/manual-exact");
    expect(mock.info.join(" ")).toContain("Model discovery is unsupported");
  });

  it("local preset requires no cloud credential and only contacts the runtime after user action", async () => {
    const { session, secrets } = activateFake(); mock.pickIndexes.push(11, 0); await mock.commands.get("nyxara.connectProvider")?.();
    expect(session.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ type: "ollama", baseUrl: "http://localhost:11434/v1", authStrategy: "local" })); expect(secrets.store).not.toHaveBeenCalled(); expect(mock.inputOptions).toHaveLength(0); expect(session.core.listModels).toHaveBeenCalledOnce();
  });

  it("preserves a compatible preset identity independently from its shared adapter type", async () => {
    const { session } = activateFake();
    mock.pickIndexes.push(6, 0);
    mock.inputs.push("Kimi", "kimi-test-key");
    await mock.commands.get("nyxara.connectProvider")?.();
    expect(session.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: "kimi", catalogId: "kimi", type: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1",
    }));
    expect(mock.settings.get("nyxara.providerConfigs")).toEqual([expect.objectContaining({ id: "kimi", catalogId: "kimi" })]);
  });

  it("multiple configs coexist and switching default does not delete either", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, GATEWAY]); mock.settings.set("nyxara.defaultProviderConfigId", "openai"); const { secrets, secretValues } = activateFake(fakeSession(true)); secretValues.set("provider/openai-compatible/api-key", "hidden"); mock.pickIndexes.push(1, 0, 0);
    await mock.commands.get("nyxara.manageProviders")?.();
    expect(mock.settings.get("nyxara.providerConfigs")).toHaveLength(2); expect(mock.settings.get("nyxara.defaultProviderConfigId")).toBe("openai-compatible"); expect(mock.settings.get("nyxara.modelMode")).toBe("simple"); expect(secrets.delete).not.toHaveBeenCalled();
  });

  it("advanced mode independently stores Planner, Executor, and Reviewer provider/model pairs", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, GATEWAY]); const { session, secretValues } = activateFake(fakeSession(true)); secretValues.set("provider/openai/api-key", "hidden-a"); secretValues.set("provider/openai-compatible/api-key", "hidden-b"); mock.pickIndexes.push(0, 0, 1, 0, 0, 0);
    await mock.commands.get("nyxara.configureRoleModels")?.();
    expect(mock.settings.get("nyxara.planner.provider")).toBe("openai"); expect(mock.settings.get("nyxara.executor.provider")).toBe("openai-compatible"); expect(mock.settings.get("nyxara.reviewer.provider")).toBe("openai"); expect(mock.settings.get("nyxara.modelMode")).toBe("advanced"); expect(session.configureAgents).toHaveBeenCalledTimes(2);
  });

  it("credential update changes only the selected provider secret", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, GATEWAY]); const { secrets } = activateFake(fakeSession(true)); mock.pickIndexes.push(1, 1); mock.inputs.push("new-gateway-key");
    await mock.commands.get("nyxara.manageProviders")?.(); expect(secrets.store).toHaveBeenCalledWith("provider/openai-compatible/api-key", "new-gateway-key"); expect(secrets.store).not.toHaveBeenCalledWith("provider/openai/api-key", expect.anything());
  });

  it("disconnect confirms and signs out only the intended provider while preserving config", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, GATEWAY]); mock.settings.set("nyxara.defaultProviderConfigId", "openai"); const { secrets } = activateFake(fakeSession(true)); mock.pickIndexes.push(0, 5);
    await mock.commands.get("nyxara.manageProviders")?.(); expect(mock.warnings[0]).toContain("stored credential"); expect(secrets.delete).toHaveBeenCalledTimes(1); expect(secrets.delete).toHaveBeenCalledWith("provider/openai/api-key"); expect(mock.settings.get("nyxara.providerConfigs")).toEqual([{ ...OPENAI, signedOut: true }, GATEWAY]);
  });

  it("describes CLI subscription sign-out without claiming to revoke the external account session", async () => {
    mock.settings.set("nyxara.providerConfigs", [CODEX_CLI]); mock.warningResult = "Sign Out"; activateFake(fakeSession(true)); const view = resolveRegisteredWebview(); view.receive({ type: "signOutProvider", providerConfigId: CODEX_CLI.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")?.[0]?.signedOut).toBe(true)); expect(mock.warnings[0]).toContain("does not store or revoke the official CLI account session"); expect(mock.warnings[0]).toContain("only this Nyxara provider configuration"); expect(mock.warnings[0]).not.toContain("removes only its stored credential");
  });

  it("opens the official API key page again from provider management", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI]); activateFake(fakeSession(true)); mock.pickIndexes.push(0, 2);
    await mock.commands.get("nyxara.manageProviders")?.();
    expect(mock.externalUrls).toEqual(["https://platform.openai.com/api-keys"]);
  });

  it("Test Connection uses only model discovery and maps safe failures", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI]); mock.settings.set("nyxara.defaultProviderConfigId", "openai"); const { session, secretValues } = activateFake(fakeSession(true)); secretValues.set("provider/openai/api-key", "hidden");
    await mock.commands.get("nyxara.testProviderConnection")?.(); expect(session.core.listModels).toHaveBeenCalledWith("openai"); expect(session.core.createPlan).not.toHaveBeenCalled(); expect(session.core.runApprovedPlan).not.toHaveBeenCalled(); expect(mock.info.join(" ")).toContain("does not generate text");
    session.core.listModels.mockRejectedValueOnce(Object.assign(new Error("raw secret should not render"), { code: "rate_limit_error" })); await mock.commands.get("nyxara.testProviderConnection")?.(); expect(mock.errors.at(-1)).toBe("OpenAI rate limit reached. Try again later.");
  });

  it("maps unavailable models without silently substituting them", () => { expect(providerConnectionMessage(Object.assign(new Error("Planner model is not available: exact/model"), { code: "invalid_model" }), "OpenAI")).toBe("Configured model unavailable. Choose another model."); });

  it.each([
    ["authentication_error", "OpenAI authentication failed. Check your API key."],
    ["network_error", "OpenAI could not be reached. Check your network and endpoint."],
    ["rate_limit_error", "OpenAI rate limit reached. Try again later."],
    ["timeout_error", "OpenAI timed out."],
    ["provider_error", "OpenAI is unavailable. Try again later."],
    ["invalid_response", "OpenAI returned an unexpected response."],
  ])("maps %s without exposing provider payloads", (code, expected) => {
    expect(providerConnectionMessage(Object.assign(new Error("raw provider payload with fake-secret"), { code }), "OpenAI")).toBe(expected);
  });

  it("maps a missing subscription CLI to an actionable installation error", () => {
    expect(providerConnectionMessage(Object.assign(new Error("spawn ENOENT"), { code: "provider_not_installed" }), "Gemini CLI (Google account)")).toBe("Gemini CLI (Google account) CLI is not installed. Install the official CLI, sign in, then try again.");
  });

  it("Generate Plan uses stored role configuration without a provider/model setup prompt", async () => {
    mock.settings.set("nyxara.providerConfigs", [GATEWAY]); mock.settings.set("nyxara.defaultProviderConfigId", GATEWAY.id); mock.settings.set("nyxara.planner.model", "ha-op/gpt-5.6-sol"); const session = fakeSession(true); activateFake(session); mock.workspaceFolders.push({ name: "root", uri: { fsPath: "/workspace" } }); mock.inputs.push("tiny task");
    await mock.commands.get("nyxara.generatePlan")?.(); expect(session.generate).toHaveBeenCalledWith("tiny task", "/workspace", "default"); expect(mock.inputOptions.map((item) => item.prompt)).toEqual(["What do you want to build?"]);
  });

  it("normal requirement entry stays inside the Webview and never opens InputBox", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...GATEWAY, modelId: "ha-op/gpt-5.6-sol" }]);
    mock.settings.set("nyxara.defaultProviderConfigId", GATEWAY.id);
    for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, GATEWAY.id); mock.settings.set(`nyxara.${role}.model`, "ha-op/gpt-5.6-sol"); }
    const session = fakeSession(true);
    const { secretValues } = activateFake(session); secretValues.set("provider/openai-compatible/api-key", "hidden");
    mock.workspaceFolders.push({ name: "root", uri: { fsPath: "/workspace" } });
    const view = resolveRegisteredWebview();
    view.receive({ type: "submitRequirement", task: "Add pagination\nand filters" });
    await vi.waitFor(() => expect(session.generate).toHaveBeenCalledWith("Add pagination\nand filters", "/workspace", "default"));
    expect(mock.inputOptions).toHaveLength(0);
  });

  it("creates Recent history and reopens the active live task without a second workflow/provider call", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...GATEWAY, modelId: "ha-op/gpt-5.6-sol" }]); mock.settings.set("nyxara.defaultProviderConfigId", GATEWAY.id);
    for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, GATEWAY.id); mock.settings.set(`nyxara.${role}.model`, "ha-op/gpt-5.6-sol"); }
    const session = fakeSession(true);
    session.generate.mockImplementation(async (task: string) => { session.prompt = task; session.snapshot = { workflowId: "workflow-live", status: "executing", updatedAt: "now", tasks: [] }; session.onChange?.(); });
    activateFake(session); mock.workspaceFolders.push({ name: "Private Project", uri: { fsPath: "/home/person/private/project" } });
    const view = resolveRegisteredWebview(); view.receive({ type: "submitRequirement", task: "Refactor auth" });
    await vi.waitFor(() => expect(session.generate).toHaveBeenCalledOnce());
    const recentState = [...view.posted].reverse().find((message) => message.state?.history?.recentTasks?.length)?.state;
    expect(recentState.history.recentTasks[0]).toMatchObject({ title: "Refactor auth", status: "executing", workspaceIdentity: { label: "Private Project" } });
    expect(JSON.stringify(recentState.history.recentTasks[0])).not.toContain("/home/person/private/project");
    const taskId = recentState.history.recentTasks[0].id;
    view.receive({ type: "openHistory" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.screen).toBe("history"));
    view.receive({ type: "openTask", taskId }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.screen).toBe("workspace"));
    expect(session.generate).toHaveBeenCalledOnce();
    expect(session.core.startWorkflow).not.toHaveBeenCalled();
  });

  it("confirms Delete Task and Clear History while leaving provider settings and credentials untouched", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...GATEWAY, modelId: "route/model" }]); mock.settings.set("nyxara.defaultProviderConfigId", GATEWAY.id);
    const session = fakeSession(true);
    session.generate.mockImplementation(async (task: string) => { session.prompt = task; session.snapshot = { workflowId: "done", status: "completed", updatedAt: "now", tasks: [], usage: { totalTokens: 10, totalProviderCalls: 2, totalToolCalls: 3, totalDurationMs: 40, repairCycles: 0 } }; session.onChange?.(); });
    const { secrets } = activateFake(session); mock.workspaceFolders.push({ name: "Project", uri: { fsPath: "/project" } });
    const view = resolveRegisteredWebview(); view.receive({ type: "submitRequirement", task: "Completed task" });
    await vi.waitFor(() => expect(session.generate).toHaveBeenCalledOnce());
    const taskId = [...view.posted].reverse().find((message) => message.state?.history?.recentTasks?.length)?.state.history.recentTasks[0].id;
    mock.warningResult = "Delete Task"; view.receive({ type: "deleteTask", taskId });
    await vi.waitFor(() => expect(mock.warnings.some((message) => message.includes("Repository files"))).toBe(true));
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.recentTasks).toHaveLength(0));
    mock.warningResult = "Clear History"; view.receive({ type: "clearHistory" });
    await vi.waitFor(() => expect(mock.warnings.some((message) => message.includes("credentials are preserved"))).toBe(true));
    expect(secrets.delete).not.toHaveBeenCalled(); expect(secrets.store).not.toHaveBeenCalled();
    expect(mock.settings.get("nyxara.providerConfigs")).toEqual([{ ...GATEWAY, modelId: "route/model" }]);
  });

  it("requires confirmation before delete or clear mutates local history", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...GATEWAY, modelId: "route/model" }]); mock.settings.set("nyxara.defaultProviderConfigId", GATEWAY.id);
    const session = fakeSession(true);
    session.generate.mockImplementation(async (task: string) => { session.prompt = task; session.snapshot = { workflowId: "done", status: "completed", updatedAt: "now", tasks: [] }; session.onChange?.(); });
    activateFake(session); mock.workspaceFolders.push({ name: "Project", uri: { fsPath: "/project" } });
    const view = resolveRegisteredWebview(); view.receive({ type: "submitRequirement", task: "Keep this task" });
    await vi.waitFor(() => expect(session.generate).toHaveBeenCalledOnce());
    const original = [...view.posted].reverse().find((message) => message.state?.history?.recentTasks?.length)?.state.history.recentTasks[0];
    mock.warningResult = undefined;
    view.receive({ type: "deleteTask", taskId: original.id });
    await vi.waitFor(() => expect(mock.warnings).toHaveLength(1));
    view.receive({ type: "openHistory" });
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.tasks.some((task: any) => task.id === original.id)).toBe(true));
    view.receive({ type: "clearHistory" });
    await vi.waitFor(() => expect(mock.warnings).toHaveLength(2));
    view.receive({ type: "openHistory" });
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.tasks.some((task: any) => task.id === original.id)).toBe(true));
  });

  it("runs the local Task 1 completion to Task 2 active/history/reopen flow without network or duplicate execution", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...GATEWAY, modelId: "route/model" }]); mock.settings.set("nyxara.defaultProviderConfigId", GATEWAY.id);
    for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, GATEWAY.id); mock.settings.set(`nyxara.${role}.model`, "route/model"); }
    const session = fakeSession(true);
    let workflowNumber = 0;
    session.generate.mockImplementation(async (task: string) => {
      workflowNumber += 1;
      session.prompt = task;
      session.currentPlan = { id: `plan-${workflowNumber}`, objective: task, tasks: [{ id: "one", title: "Implement", description: "", acceptanceCriteria: ["Pass"], dependencies: [] }], risks: [] };
      session.snapshot = { workflowId: `workflow-${workflowNumber}`, status: workflowNumber === 1 ? "awaiting_plan_approval" : "executing", updatedAt: "now", tasks: [] };
      session.onChange?.();
    });
    session.approveAndRun.mockImplementation(async () => {
      session.snapshot = { workflowId: "workflow-1", status: "completed", updatedAt: "now", tasks: [], usage: { totalTokens: 100, totalProviderCalls: 3, totalToolCalls: 2, totalDurationMs: 1000, repairCycles: 0 } };
      session.onChange?.();
      return { status: "completed" };
    });
    session.resetPresentation.mockImplementation(() => { session.prompt = undefined; session.currentPlan = undefined; session.snapshot = undefined; session.onChange?.(); });
    activateFake(session); mock.workspaceFolders.push({ name: "Project", uri: { fsPath: "/project" } });
    const view = resolveRegisteredWebview();

    view.receive({ type: "submitRequirement", task: "Task 1" });
    await vi.waitFor(() => expect(session.generate).toHaveBeenCalledTimes(1));
    view.receive({ type: "approvePlan" });
    await vi.waitFor(() => expect(session.approveAndRun).toHaveBeenCalledOnce());
    const taskOne = [...view.posted].reverse().find((message) => message.state?.history?.recentTasks?.[0]?.status === "completed")?.state.history.recentTasks[0];
    expect(taskOne).toMatchObject({ title: "Task 1", status: "completed" });

    view.receive({ type: "newTask" });
    await vi.waitFor(() => expect(session.resetPresentation).toHaveBeenCalledOnce());
    view.receive({ type: "submitRequirement", task: "Task 2" });
    await vi.waitFor(() => expect(session.generate).toHaveBeenCalledTimes(2));
    view.receive({ type: "openHistory" });
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.screen).toBe("history"));
    expect(view.posted.at(-1)?.state.history.tasks.map((task: any) => task.title)).toEqual(["Task 2", "Task 1"]);
    view.receive({ type: "openTask", taskId: taskOne.id });
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.selectedTask?.id).toBe(taskOne.id));
    view.receive({ type: "returnToActiveTask" });
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.screen).toBe("workspace"));
    expect(session.generate).toHaveBeenCalledTimes(2);
    expect(session.core.startWorkflow).not.toHaveBeenCalled();
    expect(session.core.listModels).not.toHaveBeenCalled();
  });

  it("runs a deterministic multi-role workflow projection through completion, history, and reopen with identical Performance and no network", async () => {
    const providers = [
      { id: "claude", type: "anthropic", displayName: "Claude", modelId: "claude-sonnet", authStrategy: "api_key" },
      { id: "openai", type: "openai", displayName: "OpenAI", modelId: "gpt-5.6-sol", authStrategy: "api_key" },
      { id: "gemini", type: "gemini", displayName: "Gemini", modelId: "gemini-pro", authStrategy: "api_key" },
    ];
    mock.settings.set("nyxara.providerConfigs", providers); mock.settings.set("nyxara.defaultProviderConfigId", "openai");
    const session = fakeSession(true);
    const usage: any = {
      ...terminalUsage, workflowId: "performance-workflow",
      planner: { ...terminalUsage.planner, providerConfigId: "claude", providerId: "anthropic", requestedModelId: "claude-sonnet", resolvedModelId: "claude-sonnet", executionProfileSummary: { kind: "provider_default" }, totalTokens: 100 },
      executor: { ...terminalUsage.planner, role: "executor", providerConfigId: "openai", providerId: "openai", requestedModelId: "route/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, totalTokens: 200 },
      reviewer: { ...terminalUsage.planner, role: "reviewer", providerConfigId: "gemini", providerId: "gemini", requestedModelId: "gemini-pro", resolvedModelId: "gemini-pro", executionProfileSummary: { kind: "gemini_thinking_level", value: "high" }, totalTokens: 80 },
      repair: { ...terminalUsage.planner, role: "repair", providerConfigId: "openai", providerId: "openai", requestedModelId: "route/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, totalTokens: 20 },
      tasks: [{ taskId: "task-1", executorCalls: 1, inputTokens: 160, outputTokens: 40, totalTokens: 200, usageSource: "provider_reported", providerDurationMs: 60, toolCalls: 2, toolDurationMs: 10, contextBytes: 500 }],
      totalProviderCalls: 4, totalInputTokens: 320, totalOutputTokens: 80, totalTokens: 400, totalProviderDurationMs: 200, totalToolCalls: 2,
      modelRequestedToolCalls: 2, executedToolCalls: 2, successfulToolCalls: 2, failedToolCalls: 0, invalidToolCalls: 0, toolCallsByName: { read_file: 1, apply_patch: 1 }, toolDurationMs: 10,
      totalDurationMs: 300, repairCycles: 1, repairSummary: { cycles: 1, calls: 1, providerDurationMs: 50, totalDurationMs: 70, tokens: 20 },
      validation: { status: "passed", durationMs: 20, steps: [{ name: "tests", status: "passed", durationMs: 20 }] }, review: { status: "passed", calls: 1, providerDurationMs: 50, totalDurationMs: 60 },
      contextFiles: 3, contextBytes: 500, contextTruncated: false, targetedExpansions: 1, localOrchestrationDurationMs: 70,
    };
    session.generate.mockImplementation(async (task: string) => {
      session.prompt = task; session.currentPlan = { id: "plan", objective: task, tasks: [{ id: "task-1", title: "Implement", description: "", acceptanceCriteria: ["Pass"], dependencies: [] }], risks: [] };
      session.snapshot = { workflowId: "performance-workflow", status: "completed", tasks: [{ taskId: "task-1", executionStatus: "completed" }], usage };
      session.result = { status: "completed", changedFiles: ["src/a.ts"], durationMs: 300, repairCycles: 1, usage }; session.validation = new Map([["tests", "passed"]]); session.validationDurations = new Map([["tests", 20]]); session.reviewStatus = "passed"; session.onChange?.();
    });
    activateFake(session); mock.workspaceFolders.push({ name: "Project", uri: { fsPath: "/project" } }); const view = resolveRegisteredWebview();
    view.receive({ type: "submitRequirement", task: "Mocked performance flow" }); await vi.waitFor(() => expect(session.generate).toHaveBeenCalledOnce());
    const task = [...view.posted].reverse().find((message) => message.state?.history?.recentTasks?.[0]?.performanceSummary)?.state.history.recentTasks[0];
    expect(task.performanceSummary.roles.map((role: any) => [role.role, role.providerName, role.executionProfileLabel])).toEqual([["planner", "Claude", "Provider Default"], ["executor", "OpenAI", "Reasoning · Medium"], ["reviewer", "Gemini", "Thinking Level · High"], ["repair", "OpenAI", "Reasoning · Medium"]]);
    view.receive({ type: "openPerformance" }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("performanceProjection")); const live = view.posted.at(-1).state.performanceView.projection;
    view.receive({ type: "closePerformance" }); view.receive({ type: "openHistory" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.screen).toBe("history"));
    view.receive({ type: "openTask", taskId: task.id }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.selectedTask?.id).toBe(task.id));
    view.receive({ type: "openPerformance", taskId: task.id }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.performanceView?.source).toBe("history"));
    expect(view.posted.at(-1).state.performanceView.projection).toEqual(live);
    expect(session.core.listModels).not.toHaveBeenCalled(); expect(session.core.createPlan).not.toHaveBeenCalled(); expect(session.core.runApprovedPlan).not.toHaveBeenCalled(); expect(session.core.startWorkflow).not.toHaveBeenCalled();
  });

  it("inline plan decisions delegate to the existing session/Core adapter", async () => {
    const session = fakeSession(true);
    activateFake(session);
    const view = resolveRegisteredWebview();
    view.receive({ type: "approvePlan" });
    await vi.waitFor(() => expect(session.approveAndRun).toHaveBeenCalledOnce());
    view.receive({ type: "rejectPlan" });
    await vi.waitFor(() => expect(session.rejectPlan).toHaveBeenCalledOnce());
  });

  it("inline permission decisions validate and forward the exact pending Core request", async () => {
    const session = fakeSession(true);
    session.snapshot = { workflowId: "w", status: "waiting_for_permission", updatedAt: "now", tasks: [], pendingPermission: { id: "request/exact", workflowId: "w", planId: "p", taskId: "t", capability: "write", reason: "test", requestedAt: "now" } };
    activateFake(session);
    const view = resolveRegisteredWebview();
    view.receive({ type: "allowPermission", requestId: "stale" });
    await Promise.resolve();
    expect(session.resolvePermission).not.toHaveBeenCalled();
    view.receive({ type: "denyPermission", requestId: "request/exact" });
    await vi.waitFor(() => expect(session.resolvePermission).toHaveBeenCalledWith("request/exact", "deny"));
    expect(mock.pickCalls).toHaveLength(0);
  });

  it("switches between already configured provider/model pairs inside the Webview", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "openai/model" }, { ...GATEWAY, modelId: "route/model" }]);
    mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id);
    mock.settings.set("nyxara.planner.provider", OPENAI.id);
    mock.settings.set("nyxara.planner.model", "openai/model");
    const session = fakeSession(true);
    const { secretValues } = activateFake(session); secretValues.set("provider/openai-compatible/api-key", "hidden");
    const view = resolveRegisteredWebview();
    view.receive({ type: "selectModel", providerConfigId: GATEWAY.id, modelId: "route/model" });
    await vi.waitFor(() => expect(mock.settings.get("nyxara.defaultProviderConfigId")).toBe(GATEWAY.id));
    expect(mock.settings.get("nyxara.providerConfigs")).toContainEqual(expect.objectContaining({ id: GATEWAY.id, modelId: "route/model" }));
    expect(mock.pickCalls).toHaveLength(0);
  });

  it.each([["nyxara.allowOnce", "allow"], ["nyxara.denyPermission", "deny"]] as const)("%s forwards the exact permission request", async (command, decision) => { const session = fakeSession(); session.snapshot = { status: "waiting_for_permission", tasks: [], pendingPermission: { id: "request/exact", capability: "write", reason: "test" } }; activateFake(session); await mock.commands.get(command)?.(); expect(session.resolvePermission).toHaveBeenCalledWith("request/exact", decision); });
  it("no-workspace is safe and multi-root requires selection", async () => { await expect(workspaceRoot()).resolves.toBeUndefined(); const first = { name: "a", uri: { fsPath: "/a" } }; const second = { name: "b", uri: { fsPath: "/b" } }; mock.workspaceFolders.push(first, second); mock.pickIndexes.push(1); await expect(workspaceRoot()).resolves.toBe("/b"); });
  it("reuses the opaque Settings-selected multi-root workspace without exposing or reprompting for its path", async () => { mock.workspaceFolders.push({ name: "a", uri: { fsPath: "/private/a" } }, { name: "b", uri: { fsPath: "/private/b" } }); mock.settings.set("nyxara.workspace.selectedRoot", "root-1"); await expect(workspaceRoot()).resolves.toBe("/private/b"); expect(mock.pickCalls).toHaveLength(0); });

  it("opens authoritative Settings in the Webview without provider, workflow, repository, Git, context, or timer work", async () => {
    vi.useFakeTimers(); mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-safe" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id);
    const { session, secretValues } = activateFake(fakeSession(true)); secretValues.set("provider/openai/api-key", "sk-hidden-settings-test"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.advanceTimersByTimeAsync(0); await Promise.resolve();
    expect(view.posted.at(-1)).toMatchObject({ type: "settingsProjection", state: { settings: { section: "home", projection: { version: EXTENSION_VERSION, providers: [{ id: "openai", credentialStored: true }] } } } });
    expect(JSON.stringify(view.posted.at(-1))).not.toContain("sk-hidden-settings-test"); expect(session.core.listModels).not.toHaveBeenCalled(); expect(session.core.createPlan).not.toHaveBeenCalled(); expect(session.core.startWorkflow).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  it("disconnect removes only one scoped credential and preserves config, models, role references, and other providers", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-a" }, { ...GATEWAY, modelId: "route-b" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id);
    for (const role of ["planner", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, OPENAI.id); mock.settings.set(`nyxara.${role}.model`, "gpt-a"); }
    mock.settings.set("nyxara.executor.provider", GATEWAY.id); mock.settings.set("nyxara.executor.model", "route-b");
    const { secretValues, secrets } = activateFake(fakeSession(true)); secretValues.set("provider/openai/api-key", "secret-a"); secretValues.set("provider/openai-compatible/api-key", "secret-b"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); mock.warningResult = "Disconnect"; view.receive({ type: "signOutProvider", providerConfigId: OPENAI.id });
    await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")?.[0]?.signedOut).toBe(true));
    expect(secrets.delete).toHaveBeenCalledWith("provider/openai/api-key"); expect(secretValues.get("provider/openai-compatible/api-key")).toBe("secret-b"); expect(mock.settings.get("nyxara.planner.provider")).toBe(OPENAI.id); expect(mock.settings.get("nyxara.planner.model")).toBe("gpt-a"); expect(mock.settings.get("nyxara.providerConfigs")).toHaveLength(2);
    await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings.projection.roles.find((role: any) => role.role === "planner")?.status).toBe("Signed out"));
  });

  it("credential update cancellation preserves the old credential and successful update never projects it", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-a" }]); const { secretValues, secrets } = activateFake(fakeSession(true)); secretValues.set("provider/openai/api-key", "old-secret"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); mock.inputs.push(undefined); view.receive({ type: "updateCredential", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(mock.inputOptions.at(-1)?.prompt).toContain("new API key")); expect(secretValues.get("provider/openai/api-key")).toBe("old-secret"); expect(secrets.store).not.toHaveBeenCalled();
    mock.inputs.push("new-secret"); view.receive({ type: "updateCredential", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(secretValues.get("provider/openai/api-key")).toBe("new-secret")); expect(JSON.stringify(view.posted)).not.toContain("new-secret");
  });

  it("Remove Provider is separately confirmed, clears explicit live role references, and leaves unrelated providers and secrets", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, GATEWAY]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id); mock.settings.set("nyxara.planner.provider", OPENAI.id); mock.settings.set("nyxara.planner.model", "gpt-a");
    const session = fakeSession(true); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "secret-a"); secretValues.set("provider/openai-compatible/api-key", "secret-b"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); mock.warningResult = "Remove Provider"; view.receive({ type: "removeProvider", providerConfigId: OPENAI.id });
    await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")).toEqual([GATEWAY])); expect(mock.settings.get("nyxara.planner.provider")).toBe(""); expect(mock.settings.get("nyxara.planner.model")).toBe(""); expect(secretValues.get("provider/openai-compatible/api-key")).toBe("secret-b"); expect(session.removeProvider).toHaveBeenCalledWith(OPENAI.id); expect(mock.warnings[0]).toContain("role assignments will become unconfigured");
  });

  it("keeps historical tasks readable with persisted provider/model summaries after sign out and removal", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-history" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id); for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, OPENAI.id); mock.settings.set(`nyxara.${role}.model`, "gpt-history"); }
    const session = fakeSession(true); session.generate.mockImplementation(async (task: string) => { session.prompt = task; session.snapshot = { workflowId: "history-done", status: "completed", tasks: [], usage: { ...terminalUsage, workflowId: "history-done", planner: { ...terminalUsage.planner, requestedModelId: "gpt-history", resolvedModelId: "gpt-history" } } }; session.onChange?.(); }); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "hidden"); mock.workspaceFolders.push({ name: "Project", uri: { fsPath: "/workspace" } }); const view = resolveRegisteredWebview(); view.receive({ type: "submitRequirement", task: "Preserve historical provider summary" }); await vi.waitFor(() => expect(session.generate).toHaveBeenCalledOnce());
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings?.projection.history.count).toBe(1)); mock.warningResult = "Disconnect"; view.receive({ type: "signOutProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")?.[0]?.signedOut).toBe(true)); expect(view.posted.at(-1)?.state.settings.projection.history.count).toBe(1);
    mock.warningResult = "Remove Provider"; view.receive({ type: "removeProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")).toEqual([])); expect(view.posted.at(-1)?.state.settings.projection.history.count).toBe(1); view.receive({ type: "closeSettings" }); view.receive({ type: "openHistory" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.history.tasks).toHaveLength(1)); const task = view.posted.at(-1).state.history.tasks[0]; expect(task.providerSummary).toEqual({ provider: "OpenAI", model: "gpt-history" }); expect(task.performanceSummary.roles[0]).toMatchObject({ providerConfigId: "openai", providerName: "OpenAI", requestedModelId: "gpt-history", resolvedModelId: "gpt-history" }); view.receive({ type: "openPerformance", taskId: task.id }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.performanceView?.projection?.roles?.[0]?.providerName).toBe("OpenAI"));
  });

  it("blocks sign out and removal while an assigned provider participates in an active workflow", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI]); mock.settings.set("nyxara.planner.provider", OPENAI.id); mock.settings.set("nyxara.planner.model", "gpt-a"); const session = fakeSession(true); session.snapshot = { workflowId: "active", status: "executing", tasks: [] };
    const { secrets } = activateFake(session); const view = resolveRegisteredWebview(); view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); view.receive({ type: "signOutProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError")); expect(view.posted.at(-1)?.message).toContain("active workflow"); expect(secrets.delete).not.toHaveBeenCalled(); expect(mock.warnings).toHaveLength(0);
  });

  it("copies only sanitized structured diagnostics", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-a" }]); const session = fakeSession(true); session.prompt = "private prompt source"; const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "sk-diagnostic-secret"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); view.receive({ type: "copyDiagnostics" }); await vi.waitFor(() => expect(mock.clipboard).toHaveLength(1)); expect(mock.clipboard[0]).toContain(EXTENSION_VERSION); for (const forbidden of ["sk-diagnostic-secret", "private prompt source", "Authorization", "providerRawResponse", "toolOutput"]) expect(mock.clipboard[0]).not.toContain(forbidden);
  });

  it("creates a second official account with a stable ID and distinct display name", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI]); const { secretValues } = activateFake(fakeSession(true)); secretValues.set("provider/openai/api-key", "first-secret"); mock.pickIndexes.push(3, 0); mock.inputs.push("OpenAI Personal", "second-secret"); await mock.commands.get("nyxara.connectProvider")?.(); const configs = mock.settings.get("nyxara.providerConfigs"); expect(configs.map((config: any) => [config.id, config.displayName])).toEqual([["openai", "OpenAI"], ["openai-2", "OpenAI Personal"]]); expect(secretValues.get("provider/openai-2/api-key")).toBe("second-secret"); expect(secretValues.get("provider/openai/api-key")).toBe("first-secret");
  });

  it("updates default provider and Simple mode through typed Settings operations without deleting other providers", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "old" }, { ...GATEWAY, modelId: "route-old" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id); const session = fakeSession(true); const { secretValues } = activateFake(session); secretValues.set("provider/openai-compatible/api-key", "hidden"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); view.receive({ type: "setDefaultProvider", providerConfigId: GATEWAY.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.defaultProviderConfigId")).toBe(GATEWAY.id)); expect(mock.settings.get("nyxara.providerConfigs")).toHaveLength(2);
    view.receive({ type: "setDefaultModel", providerConfigId: GATEWAY.id, modelId: "ha-op/gpt-5.6-sol" }); await vi.waitFor(() => expect(mock.settings.get("nyxara.reviewer.model")).toBe("ha-op/gpt-5.6-sol")); expect(mock.settings.get("nyxara.modelMode")).toBe("simple"); for (const role of ["planner", "executor", "reviewer"]) expect([mock.settings.get(`nyxara.${role}.provider`), mock.settings.get(`nyxara.${role}.model`)]).toEqual([GATEWAY.id, "ha-op/gpt-5.6-sol"]); expect(session.configureAgents).toHaveBeenCalled();
  });

  it("does not partially switch the Simple-mode default when the target credential is missing", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-old" }, { ...GATEWAY, modelId: "route-old" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id); mock.settings.set("nyxara.modelMode", "simple"); for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, OPENAI.id); mock.settings.set(`nyxara.${role}.model`, "gpt-old"); }
    activateFake(fakeSession(true)); const view = resolveRegisteredWebview(); view.receive({ type: "setDefaultProvider", providerConfigId: GATEWAY.id }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError")); expect(mock.settings.get("nyxara.defaultProviderConfigId")).toBe(OPENAI.id); expect(mock.settings.get("nyxara.executor.provider")).toBe(OPENAI.id); expect(mock.settings.get("nyxara.executor.model")).toBe("gpt-old");
  });

  it("blocks a known tool-incompatible provider from Simple mode before writing settings", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-text" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id); const session = fakeSession(true); session.core.listProviders.mockReturnValue([{ id: OPENAI.id, capabilities: { textGeneration: true, toolCalling: false } }]); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "hidden"); const view = resolveRegisteredWebview(); mock.updates.length = 0;
    view.receive({ type: "setDefaultModel", providerConfigId: OPENAI.id, modelId: "gpt-text" }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError")); expect(view.posted.at(-1)?.message).toContain("incompatible with the executor role"); expect(mock.updates).toHaveLength(0);
  });

  it("keeps the workflow-start provider protected after mutable role settings change", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, { ...GATEWAY, authStrategy: "none" }]); mock.settings.set("nyxara.planner.provider", OPENAI.id); mock.settings.set("nyxara.planner.model", "gpt-a"); const session = fakeSession(true); session.snapshot = { workflowId: "active", status: "executing", tasks: [] }; const { secrets } = activateFake(session); const view = resolveRegisteredWebview(); mock.settings.set("nyxara.planner.provider", GATEWAY.id);
    view.receive({ type: "signOutProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError")); expect(view.posted.at(-1)?.message).toContain("active workflow"); expect(secrets.delete).not.toHaveBeenCalled();
  });

  it("atomically saves mixed-provider advanced roles and blocks known incompatible executor adapters", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, { ...GATEWAY, authStrategy: "none" }]); const session = fakeSession(true); session.core.listProviders.mockReturnValue([{ id: OPENAI.id, capabilities: { textGeneration: true, toolCalling: true } }, { id: GATEWAY.id, capabilities: { textGeneration: true, toolCalling: true } }]); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "hidden"); const view = resolveRegisteredWebview();
    const assignments = [{ role: "planner", providerConfigId: OPENAI.id, modelId: "plan-model", executionOptions: { kind: "provider_default" } }, { role: "executor", providerConfigId: GATEWAY.id, modelId: "exec-model", executionOptions: { kind: "provider_default" } }, { role: "reviewer", providerConfigId: OPENAI.id, modelId: "review-model", executionOptions: { kind: "provider_default" } }]; view.receive({ type: "updateRoleAssignments", assignments }); await vi.waitFor(() => expect(mock.settings.get("nyxara.modelMode")).toBe("advanced")); expect(mock.settings.get("nyxara.executor.model")).toBe("exec-model"); expect(mock.settings.get("nyxara.reviewer.model")).toBe("review-model");
    mock.updates.length = 0; session.core.listProviders.mockReturnValue([{ id: OPENAI.id, capabilities: { textGeneration: true, toolCalling: false } }, { id: GATEWAY.id, capabilities: { textGeneration: true, toolCalling: false } }]); view.receive({ type: "updateRoleAssignments", assignments }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError")); expect(view.posted.at(-1)?.message).toContain("incompatible"); expect(mock.updates).toHaveLength(0);
  });

  it("migrates alpha.8 roles to Provider Default and opens Models & Roles without discovery or timers", async () => {
    vi.useFakeTimers(); mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-5.1" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id);
    for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, OPENAI.id); mock.settings.set(`nyxara.${role}.model`, "gpt-5.1"); }
    const session = fakeSession(true); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "hidden"); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettingsSection", section: "modelsRoles" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings?.projection).toBeDefined());
    expect(view.posted.at(-1).state.settings.projection.roles.every((role: any) => role.executionOptions.kind === "provider_default")).toBe(true);
    expect(session.core.listModels).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  it("atomically persists independent mixed execution profiles and rolls back on storage failure", async () => {
    const anthropic = { id: "anthropic", type: "anthropic", displayName: "Claude", baseUrl: "https://api.anthropic.com", authStrategy: "api_key" };
    const gemini = { id: "gemini", type: "gemini", displayName: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", authStrategy: "api_key" };
    mock.settings.set("nyxara.providerConfigs", [OPENAI, anthropic, gemini]); const session = fakeSession(true); session.core.listProviders.mockReturnValue([OPENAI, anthropic, gemini].map((provider) => ({ id: provider.id, capabilities: { textGeneration: true, toolCalling: true } })));
    const { secretValues } = activateFake(session); for (const id of ["openai", "anthropic", "gemini"]) secretValues.set(`provider/${id}/api-key`, "hidden"); const view = resolveRegisteredWebview();
    const assignments = [
      { role: "planner", providerConfigId: "anthropic", modelId: "claude-sonnet-4-5", executionOptions: { kind: "anthropic_thinking", enabled: true, budgetTokens: 2048 } },
      { role: "executor", providerConfigId: "openai", modelId: "gpt-5.1", executionOptions: { kind: "openai_reasoning", effort: "medium" } },
      { role: "reviewer", providerConfigId: "gemini", modelId: "gemini-3-flash", executionOptions: { kind: "gemini_thinking_level", level: "high" } },
    ];
    view.receive({ type: "updateRoleAssignments", assignments }); await vi.waitFor(() => expect(mock.settings.get("nyxara.modelMode")).toBe("advanced"));
    expect(mock.settings.get("nyxara.planner.execution")).toEqual(assignments[0].executionOptions); expect(mock.settings.get("nyxara.executor.execution")).toEqual(assignments[1].executionOptions); expect(mock.settings.get("nyxara.reviewer.execution")).toEqual(assignments[2].executionOptions);
    const before = new Map(mock.settings); mock.failNextUpdateKey = "nyxara.reviewer.execution";
    const changed = assignments.map((assignment) => ({ ...assignment, modelId: `${assignment.modelId}-changed` })); view.receive({ type: "updateRoleAssignments", assignments: changed });
    await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("safeError"));
    for (const [key, value] of before) expect(mock.settings.get(key)).toEqual(value);
  });

  it("preserves execution profiles across sign out/reconnect and clears them only with provider removal", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "gpt-5.1" }]); mock.settings.set("nyxara.defaultProviderConfigId", OPENAI.id);
    for (const role of ["planner", "executor", "reviewer"]) { mock.settings.set(`nyxara.${role}.provider`, OPENAI.id); mock.settings.set(`nyxara.${role}.model`, "gpt-5.1"); mock.settings.set(`nyxara.${role}.execution`, { kind: "openai_reasoning", effort: "low" }); }
    const session = fakeSession(true); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "hidden"); const view = resolveRegisteredWebview(); mock.warningResult = "Disconnect";
    view.receive({ type: "signOutProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")[0].signedOut).toBe(true));
    expect(mock.settings.get("nyxara.executor.execution")).toEqual({ kind: "openai_reasoning", effort: "low" });
    mock.inputs.push("replacement-key"); view.receive({ type: "updateCredential", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")[0].signedOut).toBe(false));
    expect(mock.settings.get("nyxara.executor.execution")).toEqual({ kind: "openai_reasoning", effort: "low" });
    mock.warningResult = "Remove Provider"; view.receive({ type: "removeProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(mock.settings.get("nyxara.providerConfigs")).toEqual([]));
    for (const role of ["planner", "executor", "reviewer"]) expect([mock.settings.get(`nyxara.${role}.provider`), mock.settings.get(`nyxara.${role}.model`), mock.settings.get(`nyxara.${role}.execution`)]).toEqual(["", "", { kind: "provider_default" }]);
  });

  it("delegates explicit connection testing only to model discovery and updates profile/history/workspace settings", async () => {
    mock.settings.set("nyxara.providerConfigs", [{ ...OPENAI, modelId: "ha-op/gpt-5.6-sol" }]); const session = fakeSession(true); const { secretValues } = activateFake(session); secretValues.set("provider/openai/api-key", "hidden"); mock.workspaceFolders.push({ name: "One", uri: { fsPath: "/private/one" } }, { name: "Two", uri: { fsPath: "/private/two" } }); const view = resolveRegisteredWebview();
    view.receive({ type: "openSettings" }); await vi.waitFor(() => expect(view.posted.at(-1)?.state.settings).toBeDefined()); expect(JSON.stringify(view.posted.at(-1))).not.toContain("/private/"); view.receive({ type: "testProvider", providerConfigId: OPENAI.id }); await vi.waitFor(() => expect(session.core.listModels).toHaveBeenCalledWith(OPENAI.id)); expect(session.core.createPlan).not.toHaveBeenCalled();
    view.receive({ type: "updatePlanningProfile", profileId: "default" }); await vi.waitFor(() => expect(mock.settings.get("nyxara.planningProfile")).toBe("default")); view.receive({ type: "updateHistoryRetention", retention: 20 }); await vi.waitFor(() => expect(mock.settings.get("nyxara.history.retention")).toBe(20)); view.receive({ type: "selectWorkspaceRoot", rootId: "root-1" }); await vi.waitFor(() => expect(mock.settings.get("nyxara.workspace.selectedRoot")).toBe("root-1"));
  });

  it("edits only compatible provider names/endpoints and rejects official endpoint overrides", async () => {
    mock.settings.set("nyxara.providerConfigs", [OPENAI, { ...GATEWAY, authStrategy: "none" }]); const session = fakeSession(true); activateFake(session); const view = resolveRegisteredWebview(); view.receive({ type: "updateProviderMetadata", providerConfigId: GATEWAY.id, displayName: "Router Work", endpoint: "https://new.example/v1/" }); await vi.waitFor(() => expect(view.posted.at(-1)?.type).toBe("providerConfigs")); expect(mock.settings.get("nyxara.providerConfigs")[1].baseUrl).toBe("https://new.example/v1"); const before = view.posted.length; view.receive({ type: "updateProviderMetadata", providerConfigId: OPENAI.id, displayName: "Bad", endpoint: "https://evil.example" }); await vi.waitFor(() => expect(view.posted.slice(before).some((message) => message.type === "safeError")).toBe(true)); expect(mock.settings.get("nyxara.providerConfigs")[0]).toEqual(OPENAI);
  });
});
