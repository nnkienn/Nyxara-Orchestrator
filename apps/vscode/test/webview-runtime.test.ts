import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildSettingsProjection } from "../src/settings-projection.js";

type Listener = (event: any) => void;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  title = "";
  type = "";
  disabled = false;
  selected = false;
  scrollTop = 0;
  scrollHeight = 200;
  clientHeight = 200;
  constructor(readonly tagName: string, readonly id?: string) {}
  readonly classList = {
    toggle: (name: string, force?: boolean) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force ?? !values.has(name);
      if (enabled) values.add(name); else values.delete(name);
      this.className = [...values].join(" ");
    },
    add: (name: string) => { const values = new Set(this.className.split(/\s+/).filter(Boolean)); values.add(name); this.className = [...values].join(" "); },
    remove: (name: string) => { this.className = this.className.split(/\s+/).filter((item) => item && item !== name).join(" "); },
  };
  append(...items: FakeElement[]): void {
    this.children.push(...items);
    if (this.tagName === "select") {
      const selected = items.find((item) => item.selected) ?? (this.children.length === items.length ? items[0] : undefined);
      if (selected) this.value = selected.value;
    }
  }
  replaceChildren(...items: FakeElement[]): void { this.children.splice(0, this.children.length, ...items); this.value = items.find((item) => item.selected)?.value ?? items[0]?.value ?? ""; }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string, event: Record<string, unknown> = {}): void { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, ...event }); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  allText(): string { return this.textContent + this.children.map((child) => child.allText()).join(""); }
  descendants(): FakeElement[] { return [this, ...this.children.flatMap((child) => child.descendants())]; }
}

const runtimeSource = readFileSync(new URL("../media/workspace.js", import.meta.url), "utf8");
const ids = ["timeline", "requirement", "submit", "model", "new-task", "history", "settings", "provider-dot", "workspace-warning", "notice", "context"];

function harness() {
  const elements = new Map(ids.map((id) => [id, new FakeElement(id === "requirement" ? "textarea" : id === "model" ? "select" : "div", id)]));
  const messages: any[] = [];
  let receive: Listener | undefined;
  const document = { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new FakeElement(tag) };
  const window = { addEventListener: (type: string, listener: Listener) => { if (type === "message") receive = listener; } };
  vm.runInNewContext(runtimeSource, { acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }), document, window });
  const emit = (state: any, type = "initialState") => receive?.({ data: { type, state } });
  const text = () => elements.get("timeline")!.allText();
  const findButton = (label: string) => elements.get("timeline")!.descendants().find((item) => item.tagName === "button" && item.allText() === label);
  return { elements, messages, emit, text, findButton };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return { version: "0.1.0-alpha.9", configured: true, workspace: { available: true, multiple: false }, providerLabel: "Gateway · route/model", advancedRouting: false, providers: [{ id: "gateway", displayName: "Gateway", modelId: "route/model", isDefault: true }], history: { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace" }, validation: [], repairCycles: null, ...overrides };
}

const historicalTask = { id: "history-1", schemaVersion: 1, createdAt: "2026-09-03T10:00:00.000Z", updatedAt: "2026-09-03T10:01:00.000Z", workspaceIdentity: { id: "workspace", label: "Project" }, title: "Add <filters>", requirement: "Add <filters> safely", workflowId: "w-old", status: "completed", providerSummary: { provider: "Gate<way>", model: "model<x>" }, planSummary: { objective: "Add <pagination>", approvalStatus: "approved", tasks: [{ id: "one", title: "Update <query>", acceptanceCriteria: ["Tests <pass>"], dependencies: [], risk: "low" }], risks: [] }, executionSummary: { completed: 1, total: 1, tasks: [{ title: "Update query", status: "completed" }] }, validationSummary: { status: "passed", steps: [{ name: "typecheck", status: "passed", durationMs: 50 }] }, reviewSummary: { status: "passed", findingCount: 0, ruleViolationCount: null }, repairSummary: { cycles: 1, outcome: "completed", durationMs: 10, tokens: 5 }, usageSummary: { totalTokens: 7073, providerCalls: 4, toolCalls: 9, workflowDurationMs: 20600, repairCycles: 1 } };

const plan = { id: "plan-1", objective: "Add pagination", summary: "Keep compatibility", tasks: [{ id: "task-1", title: "Update query", description: "Add paging", acceptanceCriteria: ["Tests pass"], dependencies: [], risk: "low" }], risks: [{ description: "Offset drift", severity: "low", mitigation: "Stable order" }] };
const awaiting = { id: "w", status: "awaiting_plan_approval", stage: "Awaiting approval", active: true, tasks: [] };
const settingsProjection = buildSettingsProjection({ version: "0.1.0-alpha.9", providers: [{ id: "work", catalogId: "openai", type: "openai", displayName: "OpenAI Work", modelId: "gpt-5.1", baseUrl: "https://api.openai.com/v1", authStrategy: "api_key" }], defaultProviderId: "work", credentialStored: new Map([["work", true]]), testedProviderIds: new Set(["work"]), modelMode: "simple", roles: [{ role: "planner", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } }, { role: "executor", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } }, { role: "reviewer", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } }], selectedPlanningProfile: "default", planningProfiles: [{ id: "default", name: "Default", outputLanguage: "en", planStyle: "balanced", riskMode: "balanced" }], engineeringRules: [{ id: "avoid-secret-exposure", name: "Avoid secret exposure", description: "Protect secrets", scope: "global", severity: "error", enabled: true }], historyRetention: 50, historyCount: 4, workspaceFolders: [{ id: "root-0", label: "Project" }], selectedWorkspaceRootId: "root-0" } as any);

describe("Nyxara browser runtime", () => {
  it("does not submit while typing, accepts multiline input, and explicit Send submits once", () => {
    const h = harness();
    h.emit(baseState());
    const input = h.elements.get("requirement")!;
    input.value = "Add pagination\nand filters";
    input.dispatch("input");
    expect(h.messages).toEqual([{ type: "ready" }]);
    h.elements.get("submit")!.dispatch("click");
    h.elements.get("submit")!.dispatch("click");
    expect(h.messages.filter((message) => message.type === "submitRequirement")).toEqual([{ type: "submitRequirement", task: "Add pagination\nand filters" }]);
  });

  it("keeps empty input disabled and Ctrl/Cmd+Enter submits exactly once", () => {
    const h = harness();
    h.emit(baseState());
    expect(h.elements.get("submit")!.disabled).toBe(true);
    const input = h.elements.get("requirement")!;
    input.value = "Keyboard task";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter", ctrlKey: true, metaKey: false });
    input.dispatch("keydown", { key: "Enter", ctrlKey: true, metaKey: false });
    expect(h.messages.filter((message) => message.type === "submitRequirement")).toEqual([{ type: "submitRequirement", task: "Keyboard task" }]);
  });

  it("renders provider-missing and no-workspace states inline while provider setup remains available", () => {
    const missing = harness();
    missing.emit(baseState({ configured: false, providers: [] }));
    expect(missing.text()).toContain("Connect an AI provider to start.");
    missing.findButton("Connect Provider")?.dispatch("click");
    expect(missing.messages.at(-1)).toEqual({ type: "openProviderSetup" });
    const noWorkspace = harness();
    noWorkspace.emit(baseState({ workspace: { available: false, multiple: false } }));
    expect(noWorkspace.text()).toContain("Open a folder or workspace to start a coding task.");
    expect(noWorkspace.elements.get("requirement")!.disabled).toBe(true);
  });

  it("renders structured plans, criteria and risks as text and sends inline approval/rejection actions", () => {
    const h = harness();
    h.emit(baseState({ prompt: "<img src=x onerror=bad>", plan: { ...plan, tasks: [{ ...plan.tasks[0], title: "<script>bad()</script>" }] }, workflow: awaiting }));
    expect(h.text()).toContain("Implementation Plan");
    expect(h.text()).toContain("Acceptance criteria");
    expect(h.text()).toContain("Tests pass");
    expect(h.text()).toContain("Risk: Low");
    expect(h.text()).toContain("<script>bad()</script>");
    h.findButton("Approve & Run")?.dispatch("click");
    h.findButton("Reject")?.dispatch("click");
    expect(h.messages.slice(-2)).toEqual([{ type: "approvePlan" }, { type: "rejectPlan" }]);
  });

  it.each([
    ["executing", "Executing"], ["validating", "Validating"], ["reviewing", "Reviewing"], ["repairing", "Repairing"], ["paused", "Paused"],
  ])("renders %s workflow status and task progress", (status, stage) => {
    const h = harness();
    h.emit(baseState({ plan, workflow: { id: "w", status, stage, active: true, currentTaskId: "task-1", progress: { completed: 0, total: 1 }, tasks: [{ id: "task-1", title: "Update query", status: "running" }] }, repairCycles: status === "repairing" ? 1 : null }));
    expect(h.text()).toContain(stage);
    expect(h.text()).toContain("Task 1 / 1");
    expect(h.text()).toContain("Update query");
  });

  it("renders validation skipped, all review outcomes, and repair cycles without raw output bodies", () => {
    for (const reviewStatus of ["passed", "failed", "needs_more_context"]) {
      const h = harness();
      h.emit(baseState({ plan, workflow: { id: "w", status: "repairing", stage: "Repairing", active: true, tasks: [] }, validation: [{ kind: "typecheck", status: "passed" }, { kind: "lint", status: "skipped", stdout: "RAW_STDOUT" }], reviewStatus, repairCycles: 1, rawReviewerResponse: "RAW_REVIEW" }));
      expect(h.text()).toContain("✓ TypecheckPassed");
      expect(h.text()).toContain("– LintSkipped");
      expect(h.text()).toContain(reviewStatus === "needs_more_context" ? "Needs More Context" : reviewStatus === "passed" ? "Passed" : "Failed");
      expect(h.text()).toContain("Cycle 1");
      expect(h.text()).not.toContain("RAW_STDOUT");
      expect(h.text()).not.toContain("RAW_REVIEW");
    }
  });

  it("renders permission inline and forwards the exact request ID for Allow Once and Deny", () => {
    const h = harness();
    h.emit(baseState({ plan, workflow: { id: "w", status: "waiting_for_permission", stage: "Waiting for permission", active: true, tasks: [], permission: { id: "permission/exact", action: "write · src/a.ts", reason: "Apply approved change" } } }));
    expect(h.text()).toContain("Permission required");
    h.findButton("Allow Once")?.dispatch("click");
    h.findButton("Deny")?.dispatch("click");
    expect(h.messages.slice(-2)).toEqual([{ type: "allowPermission", requestId: "permission/exact" }, { type: "denyPermission", requestId: "permission/exact" }]);
  });

  it("renders completed, failed and aborted summaries with authoritative usage and New Task", () => {
    for (const status of ["completed", "failed", "aborted"]) {
      const h = harness();
      h.emit(baseState({ workflow: { id: "w", status, stage: status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Aborted", active: false, tasks: [], ...(status === "failed" ? { error: { stage: "Reviewing", message: "Review failed" } } : {}) }, validation: [{ kind: "test", status: "passed" }], reviewStatus: "passed", repairCycles: 2, completion: { status, changedFiles: 3, tokens: 7073, modelCalls: 4, durationMs: 20620, repairCycles: 2 } }));
      expect(h.text()).toContain(status === "completed" ? "Completed ✓" : status === "failed" ? "Failed" : "Aborted");
      expect(h.text()).toContain("7,073");
      expect(h.text()).toContain("20.6 s");
      h.findButton("New Task")?.dispatch("click");
      expect(h.messages.at(-1)).toEqual({ type: "newTask" });
    }
  });

  it("renders unavailable usage as dashes", () => {
    const h = harness();
    h.emit(baseState({ workflow: { id: "w", status: "completed", stage: "Completed", active: false, tasks: [] }, completion: { status: "completed", changedFiles: null, tokens: null, modelCalls: null, durationMs: null, repairCycles: null } }));
    expect(h.text()).toContain("Tokens-");
    expect(h.text()).toContain("Model Calls-");
    expect(h.text()).toContain("Duration-");
  });

  it("completes the normal sidebar flow without a Command Palette or InputBox", () => {
    const h = harness();
    h.emit(baseState());
    const input = h.elements.get("requirement")!;
    input.value = "Add pagination";
    input.dispatch("input");
    h.elements.get("submit")!.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "submitRequirement", task: "Add pagination" });
    h.emit(baseState({ prompt: "Add pagination", workflow: { id: "w", status: "planning", stage: "Planning", active: true, tasks: [] } }), "planningStarted");
    expect(h.text()).toContain("Planning…");
    h.emit(baseState({ prompt: "Add pagination", plan, workflow: awaiting }), "planReady");
    h.findButton("Approve & Run")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "approvePlan" });
    h.emit(baseState({ prompt: "Add pagination", plan, workflow: { id: "w", status: "executing", stage: "Executing", active: true, currentTaskId: "task-1", progress: { completed: 0, total: 1 }, tasks: [{ id: "task-1", title: "Update query", status: "running" }] } }), "workflowSnapshot");
    expect(h.text()).toContain("Executing");
    h.emit(baseState({ prompt: "Add pagination", plan, workflow: { id: "w", status: "validating", stage: "Validating", active: true, tasks: [] }, validation: [{ kind: "test", status: "passed" }] }), "validationUpdated");
    expect(h.text()).toContain("Validation");
    h.emit(baseState({ prompt: "Add pagination", plan, workflow: { id: "w", status: "reviewing", stage: "Reviewing", active: true, tasks: [] }, validation: [{ kind: "test", status: "passed" }], reviewStatus: "passed" }), "reviewUpdated");
    expect(h.text()).toContain("ReviewPassed");
    h.emit(baseState({ prompt: "Add pagination", plan, workflow: { id: "w", status: "completed", stage: "Completed", active: false, tasks: [] }, validation: [{ kind: "test", status: "passed" }], reviewStatus: "passed", repairCycles: 0, completion: { status: "completed", changedFiles: 1, tokens: 100, modelCalls: 3, durationMs: 1000, repairCycles: 0 } }), "workflowCompleted");
    expect(h.text()).toContain("Completed ✓");
  });

  it("renders ordered Recent Tasks, status/time/usage metadata, and the empty state", () => {
    const h = harness();
    h.emit(baseState({ history: { screen: "workspace", recentTasks: [historicalTask], tasks: [], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace" } }));
    expect(h.text()).toContain("Recent Tasks");
    expect(h.text()).toContain("Add <filters>");
    expect(h.text()).toContain("Completed · 7,073 tokens · 20.6 s");
    h.findButton("View all")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "openHistory" });
    const empty = harness(); empty.emit(baseState());
    expect(empty.text()).toContain("No tasks yet.Start your first task below.");
  });

  it("opens History inside Nyxara and sends local search, filter, scope, and task actions", () => {
    const h = harness();
    h.emit(baseState({ history: { screen: "history", recentTasks: [historicalTask], tasks: [historicalTask], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace" } }), "taskHistory");
    expect(h.text()).toContain("History");
    expect(h.text()).toContain("Add <filters>");
    const search = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "input")!;
    search.value = "filters"; search.dispatch("input");
    h.findButton("Failed")?.dispatch("click");
    h.findButton("All Workspaces")?.dispatch("click");
    h.elements.get("timeline")!.descendants().find((item) => item.tagName === "button" && item.allText().includes("Add <filters>"))?.dispatch("click");
    expect(h.messages.slice(-4)).toEqual([{ type: "searchTasks", query: "filters" }, { type: "filterTasks", filter: "failed" }, { type: "listTasks", scope: "all" }, { type: "openTask", taskId: "history-1" }]);
  });

  it("reconstructs a safe structured historical timeline and authoritative usage", () => {
    const h = harness();
    h.elements.get("timeline")!.scrollTop = 200;
    h.emit(baseState({ history: { screen: "historical", recentTasks: [historicalTask], tasks: [historicalTask], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace", selectedTask: historicalTask } }), "historicalTaskLoaded");
    for (const label of ["Add <filters> safely", "Implementation Plan", "Approved ✓", "Execution", "Update query — Completed", "ValidationPassed", "ReviewPassed", "Repair", "Completed ✓", "7,073", "20.6 s", "Model Calls4", "Tool Calls9"]) expect(h.text()).toContain(label);
    expect(h.text()).toContain("Gate<way> · model<x>");
    expect(h.elements.get("timeline")!.descendants().some((item) => item.tagName === "script")).toBe(false);
    expect(h.elements.get("timeline")!.scrollTop).toBe(0);
    h.findButton("Delete Task")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "deleteTask", taskId: "history-1" });
  });

  it.each([
    ["failed", "Failed"], ["aborted", "Aborted"], ["interrupted", "This workflow cannot be resumed automatically in the current version."],
  ])("renders historical %s state without fake Resume", (status, label) => {
    const h = harness(); const task = { ...historicalTask, status, ...(status === "failed" ? { failureSummary: { stage: "Review", message: "Safe failure" } } : {}) };
    h.emit(baseState({ history: { screen: "historical", recentTasks: [task], tasks: [task], query: "", filter: "all", scope: "all", selectedTask: task } }));
    expect(h.text()).toContain(label);
    expect(h.findButton("Resume")).toBeUndefined();
  });

  it("returns to a live active task without submitting or duplicating provider work", () => {
    const h = harness();
    h.emit(baseState({ history: { screen: "history", recentTasks: [{ ...historicalTask, id: "active", status: "executing" }], tasks: [{ ...historicalTask, id: "active", status: "executing" }], query: "", filter: "active", scope: "current", currentWorkspaceId: "workspace", activeTaskId: "active" }, workflow: { id: "w", status: "executing", stage: "Executing", active: true, tasks: [] } }));
    h.elements.get("timeline")!.descendants().find((item) => item.tagName === "button" && item.allText().includes("Add <filters>"))?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "openTask", taskId: "active" });
    expect(h.messages.filter((message) => message.type === "submitRequirement")).toHaveLength(0);
    h.findButton("Return to Active Task")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "returnToActiveTask" });
  });

  it("exposes Clear History as a confirmed host action and keeps the composer pinned", () => {
    const h = harness();
    h.emit(baseState({ history: { screen: "history", recentTasks: [historicalTask], tasks: [historicalTask], query: "", filter: "all", scope: "all" } }));
    h.findButton("Clear History")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "clearHistory" });
    expect(h.elements.get("requirement")).toBeDefined();
  });

  it("renders the compact Settings home with every intended top-level section and no Command Palette", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "home", projection: settingsProjection } }), "settingsProjection");
    for (const label of ["AI Providers", "Models & Roles", "Workflow", "Planning", "Engineering Rules", "Permissions", "Context", "Validation", "Review", "Repair", "Usage", "Task History", "Workspace", "Privacy & Storage", "Advanced", "About"]) expect(h.text()).toContain(label);
    expect(h.text()).not.toContain("Command Palette"); h.elements.get("timeline")!.descendants().find((item) => item.tagName === "button" && item.allText().startsWith("Planning"))?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "planning" });
  });

  it("searches Settings entirely locally and Back/Home navigation remains inside the Webview", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "home", projection: settingsProjection } }), "settingsProjection"); const count = h.messages.length;
    const search = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "input" && item.attributes.get("aria-label") === "Search settings locally")!; search.value = "review"; search.dispatch("input"); expect(h.text()).toContain("Models & Roles"); expect(h.text()).toContain("Review"); expect(h.text()).not.toContain("Task History"); expect(h.messages).toHaveLength(count);
    h.emit(baseState({ settings: { section: "review", projection: settingsProjection } }), "settingsProjection"); h.findButton("Home")?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "home" }); h.findButton("←")?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "home" });
  });

  it("renders capability-driven Simple and Advanced execution controls", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "modelsRoles", projection: settingsProjection } }), "settingsProjection");
    expect(h.text()).toContain("SimpleDefault ProviderOpenAI Work · ConnectedDefault ModelReasoningProvider Default");
    for (const role of ["Planner", "Executor", "Reviewer"]) expect(h.text()).toContain(role);
    expect(h.text().match(/Reasoning/g)?.length).toBeGreaterThanOrEqual(4);
    expect(h.text()).toContain("Repair uses Executor");
    h.findButton("Use Simple Mode")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "setDefaultModel", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } });
    h.findButton("Save Advanced Roles")?.dispatch("click");
    expect(h.messages.at(-1)?.assignments).toEqual([
      { role: "planner", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } },
      { role: "executor", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } },
      { role: "reviewer", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } },
    ]);
  });

  it("renders provider-native Anthropic budget and Gemini level schemas without OpenAI field assumptions", () => {
    const providers = [
      { id: "claude", catalogId: "anthropic", type: "anthropic", displayName: "Claude", modelId: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", authStrategy: "api_key" },
      { id: "openai", catalogId: "openai", type: "openai", displayName: "OpenAI", modelId: "gpt-5.1", baseUrl: "https://api.openai.com/v1", authStrategy: "api_key" },
      { id: "gemini", catalogId: "gemini", type: "gemini", displayName: "Gemini", modelId: "gemini-3-pro-preview", baseUrl: "https://generativelanguage.googleapis.com/v1beta", authStrategy: "api_key" },
    ];
    const projection = buildSettingsProjection({
      version: "0.1.0-alpha.9", providers, defaultProviderId: "openai",
      credentialStored: new Map(providers.map((provider) => [provider.id, true])), testedProviderIds: new Set(providers.map((provider) => provider.id)), modelMode: "advanced",
      roles: [
        { role: "planner", providerConfigId: "claude", modelId: "claude-sonnet-4-5", executionOptions: { kind: "anthropic_thinking", enabled: true, budgetTokens: 2048 } },
        { role: "executor", providerConfigId: "openai", modelId: "gpt-5.1", executionOptions: { kind: "openai_reasoning", effort: "medium" } },
        { role: "reviewer", providerConfigId: "gemini", modelId: "gemini-3-pro-preview", executionOptions: { kind: "gemini_thinking_level", level: "high" } },
      ],
      selectedPlanningProfile: "default", planningProfiles: [], engineeringRules: [], historyRetention: 50, historyCount: 0, workspaceFolders: [],
    } as any);
    const h = harness(); h.emit(baseState({ settings: { section: "modelsRoles", projection } }), "settingsProjection");
    expect(h.text()).toContain("EnabledThinking Budget");
    expect(h.text()).toContain("ReasoningProvider DefaultNoneLowMediumHigh");
    expect(h.text()).toContain("ThinkingProvider DefaultLowHigh");
    expect(h.elements.get("timeline")!.descendants().some((item) => item.tagName === "input" && item.attributes.get("aria-label") === "Thinking Budget" && item.value === "2048")).toBe(true);
  });

  it("shows unknown capability as Provider Default only and provides explicit stale recovery", () => {
    const localProvider = { ...settingsProjection.providers[0], id: "local", adapterId: "ollama", displayName: "Local", defaultModel: "gpt-5.1", executionCapabilityRules: [] };
    const unknown = { ...settingsProjection, providers: [localProvider], defaultProviderConfigId: "local", modelMode: "advanced", roles: [
      { role: "planner", providerConfigId: "local", providerName: "Local", modelId: "gpt-5.1", available: true, status: "Configured", executionOptions: { kind: "openai_reasoning", effort: "medium" }, executionProfileStatus: "stale" },
      { role: "executor", providerConfigId: "local", providerName: "Local", modelId: "gpt-5.1", available: true, status: "Configured", executionOptions: { kind: "provider_default" }, executionProfileStatus: "unknown" },
      { role: "reviewer", providerConfigId: "local", providerName: "Local", modelId: "gpt-5.1", available: true, status: "Configured", executionOptions: { kind: "provider_default" }, executionProfileStatus: "unknown" },
    ] };
    const h = harness(); h.emit(baseState({ settings: { section: "modelsRoles", projection: unknown } }), "settingsProjection");
    expect(h.text()).toContain("Advanced tuning unavailable for this provider/model.");
    expect(h.text()).toContain("Execution setting no longer supported by the selected model.");
    for (const item of h.elements.get("timeline")!.descendants().filter((item) => item.tagName === "button" && item.allText() === "Use Provider Default")) item.dispatch("click");
    expect(h.text()).not.toContain("Execution setting no longer supported by the selected model.");
  });

  it.each(["execution", "reasoning", "thinking"])("finds %s in Settings locally", (query) => {
    const h = harness(); h.emit(baseState({ settings: { section: "home", projection: settingsProjection } }), "settingsProjection"); const count = h.messages.length;
    const search = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "input" && item.attributes.get("aria-label") === "Search settings locally")!; search.value = query; search.dispatch("input");
    expect(h.text()).toContain("Models & Roles"); expect(h.messages).toHaveLength(count);
  });

  it("renders provider details with separate Disconnect and Remove Provider actions and never a stored key", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "aiProviders", providerConfigId: "work", projection: settingsProjection } }), "providerConfigs"); expect(h.text()).toContain("Provider Details"); expect(h.text()).toContain("Credential stored securely"); expect(h.text()).toContain("Disconnect"); expect(h.text()).toContain("Remove Provider"); expect(h.text()).not.toContain("sk-"); h.findButton("Test Connection")?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "testProvider", providerConfigId: "work" });
  });

  it("renders Settings projections without prompts, raw responses, source, or tool output", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "about", projection: settingsProjection, diagnostics: { version: "0.1.0-alpha.8", providers: [{ adapterId: "openai", requestedModelId: "gpt-work" }] } } }), "diagnostics"); const text = h.text(); expect(text).toContain("Privacy-safe Diagnostics"); for (const forbidden of ["apiKey", "oauthToken", "raw provider response", "private prompt", "tool output", "/home/"]) expect(text).not.toContain(forbidden);
  });
});
