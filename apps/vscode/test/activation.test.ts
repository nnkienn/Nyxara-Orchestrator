import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  commands: new Map<string, (...args: any[]) => any>(),
  settings: new Map<string, string>(),
  updates: [] as Array<[string, unknown, unknown]>,
  inputs: [] as Array<string | undefined>,
  picks: [] as any[],
  errors: [] as string[],
  info: [] as string[],
  providers: [] as any[],
  workspaceFolders: [] as any[],
  output: { appendLine: vi.fn(), dispose: vi.fn() },
}));

vi.mock("vscode", () => {
  class TreeItem {
    label: string;
    description?: string;
    command?: any;
    constructor(label: string) { this.label = label; }
  }
  class EventEmitter {
    event = vi.fn();
    fire = vi.fn();
  }
  return {
    TreeItem,
    EventEmitter,
    TreeItemCollapsibleState: { None: 0 },
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: vi.fn((name: string, handler: (...args: any[]) => any) => { mock.commands.set(name, handler); return { dispose: vi.fn() }; }),
      executeCommand: vi.fn(),
    },
    workspace: {
      get workspaceFolders() { return mock.workspaceFolders; },
      getConfiguration: vi.fn(() => ({
        get: (key: string, fallback: string) => mock.settings.get(key) ?? fallback,
        update: async (key: string, value: unknown, target: unknown) => { mock.updates.push([key, value, target]); mock.settings.set(key, String(value)); },
      })),
    },
    window: {
      createOutputChannel: vi.fn(() => mock.output),
      registerTreeDataProvider: vi.fn((_id: string, provider: any) => { mock.providers.push(provider); return { dispose: vi.fn() }; }),
      showQuickPick: vi.fn(async (items: any[]) => mock.picks.length ? mock.picks.shift() : items[0]),
      showInputBox: vi.fn(async () => mock.inputs.shift()),
      showErrorMessage: vi.fn(async (message: string) => { mock.errors.push(message); }),
      showInformationMessage: vi.fn(async (message: string) => { mock.info.push(message); }),
      withProgress: vi.fn(async (_options: unknown, task: () => any) => task()),
    },
  };
}, { virtual: true });

import { activate, workspaceRoot } from "../src/extension.js";

function fakeSession() {
  const core = {
    listModels: vi.fn(async () => [{ id: "ha-op/gpt-5.6-sol", name: "Routed" }]),
    listProviders: vi.fn(() => [{ id: "openai-compatible", displayName: "OpenAI-compatible" }]),
    listPlanningProfiles: vi.fn(() => [{ id: "default", name: "Default" }]),
    configureAgent: vi.fn(),
    createPlan: vi.fn(), runApprovedPlan: vi.fn(), startWorkflow: vi.fn(),
  };
  return {
    core,
    configured: false,
    validation: new Map(),
    currentPlan: undefined as any,
    snapshot: undefined as any,
    result: undefined,
    prompt: undefined,
    onChange: undefined as (() => void) | undefined,
    configureAgents: vi.fn(), generate: vi.fn(), regenerate: vi.fn(), approveAndRun: vi.fn(async () => ({ status: "paused" })), rejectPlan: vi.fn(), pause: vi.fn(), resume: vi.fn(), abort: vi.fn(), resolvePermission: vi.fn(),
  };
}

function activateFake(session = fakeSession()) {
  const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };
  const globalState = { update: vi.fn() };
  const workspaceState = { update: vi.fn() };
  const context = { subscriptions: [] as any[], secrets, globalState, workspaceState };
  activate(context as any, session as any);
  return { session, context, secrets, globalState, workspaceState };
}

describe("VS Code activation and command safety", () => {
  beforeEach(() => {
    mock.commands.clear(); mock.settings.clear(); mock.updates.length = 0; mock.inputs.length = 0; mock.picks.length = 0;
    mock.errors.length = 0; mock.info.length = 0; mock.providers.length = 0; mock.workspaceFolders.length = 0;
    vi.clearAllMocks();
  });

  it("activation only registers UI and performs no provider, repository, context, workflow, or process work", () => {
    vi.useFakeTimers();
    const { session } = activateFake();
    expect(mock.commands.size).toBe(13);
    expect(session.core.listModels).not.toHaveBeenCalled();
    expect(session.core.createPlan).not.toHaveBeenCalled();
    expect(session.core.runApprovedPlan).not.toHaveBeenCalled();
    expect(session.core.startWorkflow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(session.core.listModels).not.toHaveBeenCalled();
    expect(session.core.createPlan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("configuration stores only non-secrets in settings and the API key only in SecretStorage", async () => {
    const { session, secrets, globalState, workspaceState } = activateFake();
    mock.inputs.push("https://router.example/v1", "fake-secret-for-test", "planner/exact", "executor/exact", "reviewer/exact");
    await mock.commands.get("nyxara.configureProvider")?.();
    expect(mock.updates).toContainEqual(["nyxara.openaiCompatible.baseUrl", "https://router.example/v1", true]);
    expect(mock.updates).toContainEqual(["nyxara.planner.model", "planner/exact", true]);
    expect(mock.updates).toContainEqual(["nyxara.executor.model", "executor/exact", true]);
    expect(mock.updates).toContainEqual(["nyxara.reviewer.model", "reviewer/exact", true]);
    expect(JSON.stringify(mock.updates)).not.toContain("fake-secret-for-test");
    expect(secrets.store).toHaveBeenCalledWith("openai-compatible.apiKey", "fake-secret-for-test");
    expect(globalState.update).not.toHaveBeenCalled();
    expect(workspaceState.update).not.toHaveBeenCalled();
    expect(mock.output.appendLine.mock.calls.flat().join(" ")).not.toContain("fake-secret-for-test");
    expect(session.configureAgents).toHaveBeenCalledTimes(2);
  });

  it("Test Provider Connection uses only model discovery and explains that it does not generate text", async () => {
    const { session } = activateFake();
    await mock.commands.get("nyxara.testProviderConnection")?.();
    expect(session.core.listModels).toHaveBeenCalledWith("openai-compatible");
    expect(session.core.createPlan).not.toHaveBeenCalled();
    expect(session.core.runApprovedPlan).not.toHaveBeenCalled();
    expect(mock.info.join(" ")).toContain("does not generate text");
  });

  it("keeps provider/auth errors bounded and secret-safe in UI and logs", async () => {
    const { session } = activateFake();
    const fakeSecret = "sk-fake-provider-secret-123456";
    session.core.listModels.mockRejectedValueOnce(new Error(`Authorization: Bearer ${fakeSecret} ${"x".repeat(500)}`));
    await mock.commands.get("nyxara.testProviderConnection")?.();
    const rendered = [...mock.errors, ...mock.output.appendLine.mock.calls.flat()].join(" ");
    expect(rendered).not.toContain(fakeSecret);
    expect(mock.errors[0]?.length).toBeLessThanOrEqual(240);
    expect(rendered).toContain("[redacted]");
  });

  it("Generate Plan preserves the selected routed model ID exactly", async () => {
    const { session } = activateFake();
    mock.workspaceFolders.push({ name: "root", uri: { fsPath: "/workspace" } });
    mock.inputs.push("tiny task");
    await mock.commands.get("nyxara.generatePlan")?.();
    expect(session.core.configureAgent).toHaveBeenCalledWith({ role: "planner", providerId: "openai-compatible", modelId: "ha-op/gpt-5.6-sol" });
    expect(session.generate).toHaveBeenCalledWith("tiny task", "/workspace", "default");
  });

  it("renders a safe Not configured state and a clear Configure Provider action", () => {
    activateFake();
    const labels = mock.providers[0].getChildren().map((item: any) => item.label);
    expect(labels).toEqual(["Provider: Not configured", "Configure Provider"]);
  });

  it("renders the structured Core plan and unavailable usage values as '-'", () => {
    const session = fakeSession();
    session.configured = true;
    session.currentPlan = { objective: "Tiny utility", tasks: [{ id: "task-1", title: "Add utility", dependencies: [], acceptanceCriteria: ["Tests pass"] }] };
    session.snapshot = { status: "awaiting_plan_approval", tasks: [{ taskId: "task-1", executionStatus: "pending" }], usage: { totalTokens: null, totalProviderCalls: 0, totalDurationMs: null, usageSource: "unavailable" } };
    activateFake(session);
    const rendered = mock.providers[0].getChildren().map((item: any) => `${item.label} ${item.description ?? ""}`).join("\n");
    expect(rendered).toContain("PLAN · Tiny utility");
    expect(rendered).toContain("task-1 — Add utility");
    expect(rendered).toContain("Acceptance: Tests pass");
    expect(rendered).toContain("Tokens: -");
    expect(rendered).toContain("Duration: -");
  });

  it.each([["nyxara.allowOnce", "allow"], ["nyxara.denyPermission", "deny"]] as const)("%s forwards the exact pending request ID", async (command, decision) => {
    const session = fakeSession();
    session.snapshot = { status: "waiting_for_permission", tasks: [], pendingPermission: { id: "request/exact", capability: "write", reason: "test" } };
    activateFake(session);
    await mock.commands.get(command)?.();
    expect(session.resolvePermission).toHaveBeenCalledWith("request/exact", decision);
  });

  it("Reject and Abort commands delegate to the session", async () => {
    const { session } = activateFake();
    await mock.commands.get("nyxara.rejectPlan")?.();
    await mock.commands.get("nyxara.abort")?.();
    expect(session.rejectPlan).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("no-workspace returns a safe user-facing state", async () => {
    await expect(workspaceRoot()).resolves.toBeUndefined();
    expect(mock.errors).toEqual(["Open a workspace folder before using Nyxara."]);
  });

  it("multi-root requires an explicit workspace selection", async () => {
    const first = { name: "a", uri: { fsPath: "/a" } };
    const second = { name: "b", uri: { fsPath: "/b" } };
    mock.workspaceFolders.push(first, second);
    mock.picks.push({ label: "b", description: "/b", folder: second });
    await expect(workspaceRoot()).resolves.toBe("/b");
  });
});
