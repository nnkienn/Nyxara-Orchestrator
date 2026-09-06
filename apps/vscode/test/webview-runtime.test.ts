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
  focus(): void { /* focus is presentation only */ }
  allText(): string { return this.textContent + this.children.map((child) => child.allText()).join(""); }
  descendants(): FakeElement[] { return [this, ...this.children.flatMap((child) => child.descendants())]; }
}

const runtimeSource = readFileSync(new URL("../media/workspace.js", import.meta.url), "utf8");
const ids = ["timeline", "requirement", "submit", "model", "new-task", "history", "settings", "provider-dot", "workspace-warning", "notice", "context"];

function harness() {
  const elements = new Map(ids.map((id) => [id, new FakeElement(id === "requirement" ? "textarea" : id === "model" ? "button" : "div", id)]));
  const messages: any[] = [];
  let receive: Listener | undefined;
  const unloadListeners: Listener[] = [];
  // Controllable clock so the elapsed timer can be observed without real waiting.
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let now = Date.now();
  const NativeDate = Date;
  class FakeDate extends NativeDate {
    constructor(value?: string | number | Date) { super(value === undefined ? now : value); }
    static now(): number { return now; }
  }
  const document = { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new FakeElement(tag) };
  const window = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") receive = listener;
      if (type === "unload" || type === "pagehide") unloadListeners.push(listener);
    },
  };
  vm.runInNewContext(runtimeSource, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
    document,
    window,
    setInterval: (handler: () => void) => { const id = nextTimer++; timers.set(id, handler); return id; },
    clearInterval: (id: number) => { timers.delete(id); },
    Date: FakeDate,
  });
  const emit = (state: any, type = "initialState") => receive?.({ data: { type, state } });
  const text = () => elements.get("timeline")!.allText();
  const findButton = (label: string) => elements.get("timeline")!.descendants().find((item) => item.tagName === "button" && item.allText() === label);
  const tick = () => { for (const handler of [...timers.values()]) handler(); };
  const advance = (ms: number) => { now += ms; tick(); };
  const dispose = () => { for (const listener of unloadListeners) listener({}); };
  return { elements, messages, emit, text, findButton, timers, tick, advance, dispose };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return { version: "0.1.0-alpha.9", configured: true, workspace: { available: true, multiple: false }, providerLabel: "Gateway · route/model", advancedRouting: false, providers: [{ id: "gateway", displayName: "Gateway", modelId: "route/model", isDefault: true }], history: { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace" }, validation: [], repairCycles: null, ...overrides };
}

const historicalTask = { id: "history-1", schemaVersion: 1, createdAt: "2026-09-03T10:00:00.000Z", updatedAt: "2026-09-03T10:01:00.000Z", workspaceIdentity: { id: "workspace", label: "Project" }, title: "Add <filters>", requirement: "Add <filters> safely", workflowId: "w-old", status: "completed", providerSummary: { provider: "Gate<way>", model: "model<x>" }, planSummary: { objective: "Add <pagination>", approvalStatus: "approved", tasks: [{ id: "one", title: "Update <query>", acceptanceCriteria: ["Tests <pass>"], dependencies: [], risk: "low" }], risks: [] }, executionSummary: { completed: 1, total: 1, tasks: [{ title: "Update query", status: "completed" }] }, validationSummary: { status: "passed", steps: [{ name: "typecheck", status: "passed", durationMs: 50 }] }, reviewSummary: { status: "passed", findingCount: 0, ruleViolationCount: null }, repairSummary: { cycles: 1, outcome: "completed", durationMs: 10, tokens: 5 }, usageSummary: { totalTokens: 7073, providerCalls: 4, toolCalls: 9, workflowDurationMs: 20600, repairCycles: 1 } };

const performanceProjection: any = {
  detailLevel: "detailed", overview: { terminalStatus: "completed", inputTokens: 5580, outputTokens: 1493, totalTokens: 7073, workflowDurationMs: 25000, providerCalls: 5, toolCalls: 14, repairCycles: 1, usageSource: "provider_reported", validationStatus: "passed", reviewStatus: "passed", cost: 0.034, currency: "USD", costSource: "provider_reported" },
  roles: [
    { role: "planner", providerConfigId: "claude-work", providerId: "anthropic", providerName: "Claude Work", requestedModelId: "claude-sonnet", resolvedModelId: "claude-sonnet", executionProfileSummary: { kind: "provider_default" }, executionProfileLabel: "Provider Default", calls: 1, inputTokens: 1000, outputTokens: 200, totalTokens: 1200, providerDurationMs: 3000, usageSource: "provider_reported" },
    { role: "executor", providerConfigId: "openai-work", providerId: "openai", providerName: "OpenAI Work", requestedModelId: "ha-op/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, executionProfileLabel: "Reasoning · Medium", calls: 2, inputTokens: 2900, outputTokens: 810, totalTokens: 3710, providerDurationMs: 12100, usageSource: "provider_reported" },
    { role: "reviewer", providerConfigId: "gemini-work", providerId: "gemini", providerName: "Gemini Work", requestedModelId: "gemini-2.5-pro", resolvedModelId: "gemini-2.5-pro", executionProfileSummary: { kind: "gemini_thinking_level", value: "high" }, executionProfileLabel: "Thinking Level · High", calls: 1, inputTokens: 1200, outputTokens: 400, totalTokens: 1600, providerDurationMs: 4100, usageSource: "provider_reported" },
    { role: "repair", providerConfigId: "openai-work", providerId: "openai", providerName: "OpenAI Work", requestedModelId: "ha-op/gpt-5.6-sol", resolvedModelId: "gpt-5.6-sol", executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, executionProfileLabel: "Reasoning · Medium", calls: 1, inputTokens: 480, outputTokens: 83, totalTokens: 563, providerDurationMs: 1400, usageSource: "provider_reported" },
  ],
  executorTasks: [{ taskId: "task-1", title: "Update service", inputTokens: 1000, outputTokens: 240, totalTokens: 1240, providerDurationMs: 3200, providerCalls: 1, toolCalls: 2, toolDurationMs: 410 }],
  latency: { workflowDurationMs: 25000, totalProviderDurationMs: 20600, providerByRole: { planner: 3000, executor: 12100, reviewer: 4100, repair: 1400 }, toolDurationMs: 2400, validationDurationMs: 6500, reviewDurationMs: 4500, repairDurationMs: 2100, localOrchestrationDurationMs: 1500 },
  context: { files: 18, bytes: 76000, truncated: false, targetedExpansions: 2 },
  tools: { requestedByModel: 16, executed: 14, successful: 12, failed: 2, invalid: 2, durationMs: 2400, byName: [{ name: "read_<file>", count: 5 }, { name: "run_command", count: 4 }] },
  validation: { status: "passed", durationMs: 6500, steps: [{ name: "typecheck", status: "passed", durationMs: 800 }, { name: "lint", status: "skipped", durationMs: null }, { name: "tests", status: "passed", durationMs: 4200 }, { name: "build", status: "passed", durationMs: 1300 }] },
  review: { status: "passed", durationMs: 4500, contextExpansions: null, role: undefined },
  repair: { cycles: 1, durationMs: 2100, providerCalls: 1, inputTokens: 480, outputTokens: 83, totalTokens: 563, providerDurationMs: 1400, usesExecutorProfile: true, executionProfileSummary: { kind: "openai_reasoning", value: "medium" }, executionProfileLabel: "Reasoning · Medium" },
  cost: { amount: 0.034, currency: "USD", source: "provider_reported" },
};
performanceProjection.review.role = performanceProjection.roles[2];

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
    h.emit(baseState({ plan, workflow: { id: "w", status: "waiting_for_permission", stage: "Waiting for Permission", active: true, tasks: [], permission: { id: "permission/exact", action: "write · src/a.ts", reason: "Apply approved change" } } }));
    expect(h.text()).toContain("Waiting for Permission");
    expect(h.text()).toContain("Permission required");
    h.findButton("Allow Once")?.dispatch("click");
    h.findButton("Deny")?.dispatch("click");
    expect(h.messages.slice(-2)).toEqual([{ type: "allowPermission", requestId: "permission/exact" }, { type: "denyPermission", requestId: "permission/exact" }]);
  });

  it("renders compact completed, failed and aborted summaries with authoritative usage and New Task", () => {
    for (const status of ["completed", "failed", "aborted"]) {
      const h = harness();
      h.emit(baseState({ workflow: { id: "w", status, stage: status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Aborted", active: false, tasks: [], occurredStages: ["planning", "approval", "execution", "validation", "review"], ...(status === "failed" ? { error: { stage: "Reviewing", message: "Review failed" } } : {}) }, validation: [{ kind: "test", status: "passed" }], reviewStatus: "passed", repairCycles: 2, completion: { status, outcome: status, changedFiles: 3, tokens: 128050, modelCalls: 4, durationMs: 20620, repairCycles: 2, tokenParts: ["2 input", "126K cache read", "2K output"] } }));
      expect(h.text()).toContain(status === "completed" ? "Completed ✓" : status === "failed" ? "Failed" : "Aborted");
      // Compact truthful token line, not a full inline metrics block.
      expect(h.text()).toContain("2 input · 126K cache read · 2K output");
      expect(h.text()).toContain("20.6s");
      if (status !== "aborted") expect(h.text()).toContain("3 files changed");
      expect(h.text()).not.toContain("Tool Calls");
      if (status === "aborted") expect(h.text()).toContain("Workflow stopped by user.");
      h.findButton("New Task")?.dispatch("click");
      expect(h.messages.at(-1)).toEqual({ type: "newTask" });
    }
  });

  it("renders Plan Rejected as a neutral outcome with no unexecuted stages", () => {
    const h = harness();
    h.emit(baseState({ prompt: "Test greeting", plan, workflow: { id: "w", status: "failed", stage: "Plan Rejected", active: false, tasks: [], outcome: "rejected", occurredStages: ["planning", "approval"] }, completion: { status: "rejected", outcome: "rejected", changedFiles: 0, tokens: 120, modelCalls: 1, durationMs: 900, repairCycles: null, tokenParts: [] } }));
    const text = h.text();
    expect(text).toContain("Plan Rejected");
    expect(text).toContain("No repository changes were made.");
    expect(text).not.toContain("Failed");
    expect(text).not.toContain("Execution");
    expect(text).not.toContain("Validation");
    expect(text).not.toContain("Repair");
    expect(text).not.toContain("Review");
    // The plan is collapsed to a summary and reachable through View Plan.
    expect(text).toContain("Implementation Plan1 task");
    expect(h.findButton("View Plan")).toBeTruthy();
    h.findButton("Edit Requirement")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "editRequirement" });
    expect(h.findButton("New Task")).toBeTruthy();
  });

  it("keeps rejected outcome styling neutral rather than error red", () => {
    const h = harness();
    h.emit(baseState({ workflow: { id: "w", status: "failed", stage: "Plan Rejected", active: false, tasks: [], outcome: "rejected", occurredStages: ["planning", "approval"] }, completion: { status: "rejected", outcome: "rejected", changedFiles: 0, tokens: null, modelCalls: null, durationMs: null, repairCycles: null, tokenParts: [] } }));
    const card = h.elements.get("timeline")!.descendants().find((item) => item.className.includes("completion-card"));
    expect(card?.className).toContain("outcome-neutral");
    expect(card?.className).not.toContain("outcome-failure");
  });

  it("offers an inline planning retry and model switch after a failed plan", () => {
    const h = harness();
    h.emit(baseState({ prompt: "Retry this", workflow: { id: "w", status: "failed", stage: "Failed", active: false, tasks: [], occurredStages: ["planning"], error: { stage: "Planning", message: "The model returned an invalid plan." } }, completion: { status: "failed", outcome: "failed", changedFiles: 0, tokens: 1358, modelCalls: 1, durationMs: null, repairCycles: 0, tokenParts: [] } }));
    h.findButton("Try Again")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "retryPlanning" });
    h.findButton("Choose Model")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "modelsRoles" });
  });

  it("summarizes validation failures and failed tests without expanding workflow detail", () => {
    const h = harness();
    h.emit(baseState({
      workflow: { id: "failed-validation", status: "failed", stage: "Failed", active: false, tasks: [{ id: "one", title: "Fix tests", status: "failed" }], occurredStages: ["planning", "approval", "execution", "validation"], error: { stage: "Validating", message: "Validation failed." } },
      validation: [{ kind: "test:unit", status: "failed" }, { kind: "tests:e2e", status: "timed_out" }],
      completion: { status: "failed", outcome: "failed", changedFiles: 1, tokens: 5400, modelCalls: 3, durationMs: 18300, repairCycles: 0, tokenParts: [] },
    }));
    expect(h.text()).toContain("Failed");
    expect(h.text()).toContain("Validation failed · Tests: 2 failed");
    expect(h.text()).toContain("5.4K tokens · 18.3s");
    const details = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "summary" && item.allText() === "Details");
    expect(details?.attributes.get("aria-expanded")).toBe("false");
  });

  it("omits unavailable usage instead of implying zero", () => {
    const h = harness();
    h.emit(baseState({ workflow: { id: "w", status: "completed", stage: "Completed", active: false, tasks: [], occurredStages: ["planning"] }, completion: { status: "completed", outcome: "completed", changedFiles: null, tokens: null, modelCalls: null, durationMs: null, repairCycles: null, tokenParts: [] } }));
    expect(h.text()).toContain("Completed ✓");
    expect(h.text()).not.toContain("tokens");
    expect(h.text()).not.toContain("0 files changed");
  });

  it("offers View Performance on terminal cards with projected metrics", () => {
    for (const status of ["completed", "failed", "aborted"]) {
      const h = harness();
      h.emit(baseState({ workflow: { id: "w", status, stage: status, active: false, tasks: [], occurredStages: ["planning", "approval", "execution"] }, completion: { status, outcome: status, changedFiles: 1, tokens: 7073, modelCalls: 5, durationMs: 25000, repairCycles: 1, tokenParts: [] }, performance: { ...performanceProjection, overview: { ...performanceProjection.overview, terminalStatus: status } } }));
      // Detailed metrics belong on the Performance screen, not inline.
      expect(h.text()).toContain("7.1K tokens · 25s");
      expect(h.text()).not.toContain("Tool Calls14");
      h.findButton("View Performance")?.dispatch("click");
      expect(h.messages.at(-1)).toEqual({ type: "openPerformance" });
    }
  });

  it("renders readable Performance summaries with collapsed technical detail and Back", () => {
    const h = harness();
    h.emit(baseState({ performanceView: { source: "live", taskStatus: "completed", projection: performanceProjection } }), "performanceProjection");
    const text = h.text();
    for (const label of ["Performance", "Summary", "Models used", "Planner", "Executor", "Reviewer", "Repair", "Task breakdown", "Timing", "Context & tools", "Quality & repair", "Token & cost details"]) expect(text).toContain(label);
    for (const detail of ["7,073Tokens", "Claude Work", "Modelclaude-sonnet", "Requested Modelha-op/gpt-5.6-sol", "Resolved Modelgpt-5.6-sol", "Reasoning · Medium", "Thinking Level · High", "Update service", "Measured durations may overlap", "74.2 KB", "read_<file>", "Skipped", "Uses Executor · Reasoning · Medium", "Provider Reported"]) expect(text).toContain(detail);
    expect(text).not.toContain("Requested Modelclaude-sonnet");
    expect(h.elements.get("timeline")!.descendants().filter((item) => item.tagName === "details")).toHaveLength(6);
    expect(h.elements.get("timeline")!.descendants().some((item) => item.tagName === "script")).toBe(false);
    h.findButton("←")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "closePerformance" });
  });

  it("omits unused roles and empty technical groups from failed-planning Performance", () => {
    const h = harness();
    const plannerOnly = {
      ...performanceProjection,
      overview: { ...performanceProjection.overview, terminalStatus: "failed", workflowDurationMs: null, validationStatus: null, reviewStatus: null, cost: null, currency: null },
      roles: [performanceProjection.roles[0], ...performanceProjection.roles.slice(1).map((role: any) => ({ ...role, providerConfigId: null, providerId: null, providerName: null, requestedModelId: null, resolvedModelId: null, executionProfileLabel: null, calls: 0, inputTokens: null, outputTokens: null, totalTokens: null, providerDurationMs: null, usageSource: "unavailable" }))],
      executorTasks: [], context: { files: null, bytes: null, truncated: null, targetedExpansions: 0 }, tools: { requestedByModel: null, executed: null, successful: null, failed: null, invalid: null, durationMs: null, byName: [] }, validation: { status: null, durationMs: null, steps: [] }, review: { ...performanceProjection.review, status: null, durationMs: null, contextExpansions: null }, repair: { ...performanceProjection.repair, cycles: 0, durationMs: null, totalTokens: null, executionProfileLabel: null }, cost: { amount: null, currency: null, source: "unavailable" }, latency: { ...performanceProjection.latency, workflowDurationMs: null, totalProviderDurationMs: 22000, providerByRole: { planner: 22000, executor: null, reviewer: null, repair: null }, toolDurationMs: null, validationDurationMs: null, reviewDurationMs: null, repairDurationMs: null, localOrchestrationDurationMs: null },
    };
    h.emit(baseState({ performanceView: { source: "live", taskStatus: "failed", projection: plannerOnly } }));
    expect(h.text()).toContain("22.0 sTime");
    expect(h.text()).toContain("Models usedPlannerClaude Work");
    expect(h.text()).not.toContain("Models usedPlannerClaude Work · claude-sonnet1,200 tok · 3.0 sExecutor");
    expect(h.text()).not.toContain("Context & tools");
    expect(h.text()).not.toContain("Quality & repair");
  });

  it("labels aborted/interrupted Performance as partial and degrades legacy history honestly", () => {
    const partial = harness(); partial.emit(baseState({ performanceView: { source: "history", taskId: "history-1", taskStatus: "interrupted", projection: performanceProjection } }));
    expect(partial.text()).toContain("Partial metrics · Interrupted");
    const legacy = harness(); legacy.emit(baseState({ performanceView: { source: "history", taskId: "old", taskStatus: "completed", projection: { ...performanceProjection, detailLevel: "legacy", roles: [], executorTasks: [], overview: { ...performanceProjection.overview, inputTokens: null, outputTokens: null }, validation: { status: null, durationMs: null, steps: [] }, tools: { ...performanceProjection.tools, byName: [] } } } }));
    expect(legacy.text()).toContain("Detailed performance was not recorded for this task.");
    expect(legacy.text()).toContain("Total Tokens7,073");
    expect(legacy.text()).not.toContain("Models & Roles");
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
    expect(h.text()).toContain("Planning");
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
    expect(h.text()).toContain("Completed · 7.1K tokens · 21s");
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

  it("reconstructs a compact collapsible historical detail with authoritative usage", () => {
    const h = harness();
    h.elements.get("timeline")!.scrollTop = 200;
    h.emit(baseState({ history: { screen: "historical", recentTasks: [historicalTask], tasks: [historicalTask], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace", selectedTask: historicalTask } }), "historicalTaskLoaded");
    // The outcome leads; stage detail is present but collapsed behind sections.
    for (const label of ["Completed ✓", "7.1K tokens · 20.6s", "Requirement", "Plan1 task", "Execution1 / 1", "ValidationPassed", "ReviewPassed", "Repair1 cycle"]) expect(h.text()).toContain(label);
    expect(h.text()).toContain("Gate<way> · model<x>");
    const sections = h.elements.get("timeline")!.descendants().filter((item) => item.className.includes("section-disclosure") && item.tagName === "details");
    expect(sections.length).toBeGreaterThan(3);
    // Every historical section is collapsed by default.
    expect(sections.every((section) => !section.attributes.has("open"))).toBe(true);
    expect(sections.every((section) => section.children[0]?.attributes.get("aria-expanded") === "false")).toBe(true);
    expect(h.elements.get("timeline")!.descendants().some((item) => item.tagName === "script")).toBe(false);
    // A historical task opens at the top of its compact summary.
    expect(h.elements.get("timeline")!.scrollTop).toBe(0);
    h.findButton("Delete Task")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "deleteTask", taskId: "history-1" });
  });

  it("hides unexecuted stages for a rejected historical task and maps its outcome", () => {
    const rejected = { ...historicalTask, id: "history-rejected", status: "rejected", occurredStages: ["planning", "approval"], planSummary: { ...historicalTask.planSummary, approvalStatus: "rejected" }, executionSummary: undefined, validationSummary: undefined, reviewSummary: undefined, repairSummary: undefined, usageSummary: { totalTokens: 120, providerCalls: 1, toolCalls: null, workflowDurationMs: 900, repairCycles: null }, performanceSummary: undefined };
    const h = harness();
    h.emit(baseState({ history: { screen: "historical", recentTasks: [rejected], tasks: [rejected], query: "", filter: "all", scope: "current", currentWorkspaceId: "workspace", selectedTask: rejected } }), "historicalTaskLoaded");
    const text = h.text();
    expect(text).toContain("Plan Rejected");
    expect(text).toContain("No repository changes were made.");
    expect(text).toContain("Plan1 task");
    expect(text).not.toContain("120 tokens");
    expect(h.findButton("View Performance")).toBeUndefined();
    for (const absent of ["Execution", "Validation", "Review", "Repair"]) expect(text).not.toContain(absent);
    h.findButton("Edit Requirement")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "editRequirement", taskId: "history-rejected" });
  });

  it("keeps one bounded UI elapsed clock that never asks the extension for state", () => {
    const h = harness();
    const startedAt = new Date(Date.now() - 12_500).toISOString();
    h.emit(baseState({ prompt: "Add pagination", workflow: { id: "w", status: "planning", stage: "Planning", active: true, tasks: [], occurredStages: ["planning"], stageStartedAt: startedAt, providerLabel: "Claude · Opus" } }), "planningStarted");
    expect(h.text()).toContain("Planning · 12s");
    expect(h.text()).toContain("Claude · Opus");
    expect(h.timers.size).toBe(1);
    // The clock only re-renders locally; it issues no messages to the extension.
    const before = h.messages.length;
    h.advance(1_000);
    expect(h.messages.length).toBe(before);
    expect(h.text()).toContain("Planning · 13s");
    // A stage transition replaces the clock rather than accumulating timers.
    h.emit(baseState({ prompt: "Add pagination", workflow: { id: "w", status: "executing", stage: "Executing", active: true, tasks: [], occurredStages: ["planning", "approval", "execution"], stageStartedAt: new Date().toISOString() } }), "workflowSnapshot");
    expect(h.timers.size).toBe(1);
    // A terminal outcome stops it.
    h.emit(baseState({ workflow: { id: "w", status: "completed", stage: "Completed", active: false, tasks: [], occurredStages: ["planning", "approval", "execution"] }, completion: { status: "completed", outcome: "completed", changedFiles: 1, tokens: 10, modelCalls: 1, durationMs: 10, repairCycles: null, tokenParts: [] } }), "workflowCompleted");
    expect(h.timers.size).toBe(0);
  });

  it.each(["failed", "aborted"])("stops the elapsed clock on %s", (status) => {
    const h = harness();
    h.emit(baseState({ workflow: { id: "w", status: "planning", stage: "Planning", active: true, tasks: [], occurredStages: ["planning"], stageStartedAt: new Date().toISOString() } }));
    expect(h.timers.size).toBe(1);
    h.emit(baseState({ workflow: { id: "w", status, stage: status === "failed" ? "Failed" : "Aborted", active: false, tasks: [], occurredStages: ["planning"] }, completion: { status, outcome: status, changedFiles: 0, tokens: null, modelCalls: null, durationMs: 1, repairCycles: null, tokenParts: [] } }));
    expect(h.timers.size).toBe(0);
  });

  it("stops the elapsed clock when the Webview is disposed", () => {
    const h = harness();
    h.emit(baseState({ workflow: { id: "w", status: "planning", stage: "Planning", active: true, tasks: [], occurredStages: ["planning"], stageStartedAt: new Date().toISOString() } }));
    expect(h.timers.size).toBe(1);
    h.dispose();
    expect(h.timers.size).toBe(0);
  });

  it("shows honest provider waiting and response-start states without raw payloads or percentages", () => {
    const h = harness();
    const workflow = { id: "w", status: "planning", stage: "Planning", active: true, tasks: [], occurredStages: ["planning"], stageStartedAt: new Date().toISOString(), providerLabel: "Claude · Opus" };
    h.emit(baseState({ workflow }));
    expect(h.text()).toContain("Waiting for provider response...");
    h.emit(baseState({ workflow: { ...workflow, progressLabel: "Receiving response..." }, providerEvent: { raw: "SECRET", percent: 47 } }), "providerProgress");
    expect(h.text()).toContain("Receiving response...");
    expect(h.text()).not.toMatch(/SECRET|47%/);
  });

  it("shows a local clarification instead of planning a trivial request", () => {
    const h = harness();
    h.emit(baseState({ clarification: { reason: "trivial", requirement: "helo", title: "Ready when you are", message: "Tell Nyxara what you want to build, fix, review, or change.", examples: ["Fix pagination in src/api/notifications.ts"] } }), "clarificationRequired");
    const text = h.text();
    expect(text).toContain("Ready when you are");
    expect(text).toContain("Tell Nyxara what you want to build, fix, review, or change.");
    expect(text).toContain("Fix pagination in src/api/notifications.ts");
    // No plan, no workflow stage, and no elapsed clock for a greeting.
    expect(text).not.toContain("Implementation Plan");
    expect(text).not.toContain("Planning");
    expect(h.timers.size).toBe(0);
  });

  it("prefills a fresh composer draft for Edit Requirement without resuming a workflow", () => {
    const h = harness();
    h.emit(baseState({ requirementDraft: "Fix pagination in src/api/notifications.ts" }), "requirementDraft");
    expect(h.elements.get("requirement")!.value).toBe("Fix pagination in src/api/notifications.ts");
    expect(h.text()).not.toContain("Implementation Plan");
    expect(h.text()).not.toContain("Approve & Run");
  });

  it("keeps approval plans expanded, then defaults terminal plans and details to accessible collapsed disclosures", () => {
    const awaitingApproval = harness();
    awaitingApproval.emit(baseState({ prompt: "Add pagination", plan, workflow: awaiting }));
    expect(awaitingApproval.elements.get("timeline")!.descendants().some((item) => item.className.includes("plan-card") && item.tagName === "section")).toBe(true);
    expect(awaitingApproval.elements.get("timeline")!.descendants().some((item) => item.tagName === "details" && item.allText().startsWith("Implementation Plan"))).toBe(false);

    const completed = harness();
    completed.emit(baseState({ prompt: "Add pagination", plan, workflow: { id: "terminal", status: "completed", stage: "Completed", active: false, tasks: [{ id: "task-1", title: "Update query", status: "completed" }], occurredStages: ["planning", "approval", "execution"], progress: { completed: 1, total: 1 } }, completion: { status: "completed", outcome: "completed", changedFiles: 1, tokens: 10, modelCalls: 1, durationMs: 1000, repairCycles: 0, tokenParts: [] } }));
    const summaries = completed.elements.get("timeline")!.descendants().filter((item) => item.tagName === "summary");
    const planSummary = summaries.find((item) => item.allText().startsWith("Implementation Plan"));
    const detailSummary = summaries.find((item) => item.allText() === "Details");
    expect(planSummary?.attributes.get("aria-expanded")).toBe("false");
    expect(detailSummary?.attributes.get("aria-expanded")).toBe("false");
    expect(planSummary?.tagName).toBe("summary");
  });

  it("updates aria-expanded when View Plan opens a rejected task disclosure", () => {
    const h = harness();
    h.emit(baseState({ prompt: "Reject me", plan, workflow: { id: "rejected", status: "failed", stage: "Plan Rejected", active: false, tasks: [], outcome: "rejected", occurredStages: ["planning", "approval"] }, completion: { status: "rejected", outcome: "rejected", changedFiles: 0, tokens: null, modelCalls: null, durationMs: null, repairCycles: null, tokenParts: [] } }));
    const findPlanSummary = () => h.elements.get("timeline")!.descendants().find((item) => item.tagName === "summary" && item.allText().startsWith("Implementation Plan"));
    expect(findPlanSummary()?.attributes.get("aria-expanded")).toBe("false");
    h.findButton("View Plan")?.dispatch("click");
    expect(findPlanSummary()?.attributes.get("aria-expanded")).toBe("true");
  });

  it("keeps rejected history rows distinct, compact, and free of usage details", () => {
    const rejected = { ...historicalTask, id: "row-rejected", title: "Greeting test", status: "rejected", usageSummary: { ...historicalTask.usageSummary, totalTokens: 120, workflowDurationMs: 900 } };
    const h = harness();
    h.emit(baseState({ history: { screen: "workspace", recentTasks: [rejected], tasks: [], query: "", filter: "all", scope: "current" } }));
    const meta = h.elements.get("timeline")!.descendants().find((item) => item.className.includes("history-meta"));
    expect(meta?.allText()).toBe("Rejected");
    expect(meta?.className).toContain("status-rejected");
    expect(meta?.className).not.toContain("status-failed");
  });

  it("does not render an Execution section before execution actually starts", () => {
    const h = harness();
    h.emit(baseState({ prompt: "Approved task", plan, workflow: { id: "approved", status: "approved", stage: "Approved", active: true, tasks: [{ id: "task-1", title: "Update query", status: "pending" }], occurredStages: ["planning", "approval"] } }));
    expect(h.text()).not.toContain("Task progress");
    expect(h.text()).not.toContain("Execution");
  });

  it("opens persisted historical Performance without a provider action", () => {
    const h = harness(); const task = { ...historicalTask, performanceSummary: performanceProjection };
    h.emit(baseState({ history: { screen: "historical", recentTasks: [task], tasks: [task], query: "", filter: "all", scope: "current", selectedTask: task } }));
    h.findButton("View Performance")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "openPerformance", taskId: "history-1" });
    expect(h.messages.filter((message) => /provider|model|submit/i.test(message.type))).toEqual([]);
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
    for (const label of ["AI Providers", "Models & Roles", "Workflow", "Planning", "Engineering Rules", "Permissions", "Context", "Validation", "Review", "Repair", "Usage & Performance", "Task History", "Workspace", "Privacy & Storage", "Advanced", "About"]) expect(h.text()).toContain(label);
    expect(h.text()).not.toContain("Command Palette"); h.elements.get("timeline")!.descendants().find((item) => item.tagName === "button" && item.allText().startsWith("Planning"))?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "planning" });
  });

  it("searches Settings entirely locally and Back/Home navigation remains inside the Webview", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "home", projection: settingsProjection } }), "settingsProjection"); const count = h.messages.length;
    const search = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "input" && item.attributes.get("aria-label") === "Search settings locally")!; search.value = "review"; search.dispatch("input"); expect(h.text()).toContain("Models & Roles"); expect(h.text()).toContain("Review"); expect(h.text()).not.toContain("Task History"); expect(h.messages).toHaveLength(count);
    h.emit(baseState({ settings: { section: "review", projection: settingsProjection } }), "settingsProjection"); h.findButton("Home")?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "home" }); h.findButton("←")?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "home" });
  });

  it("keeps model and execution controls in one visible Simple or Advanced editor", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "modelsRoles", projection: settingsProjection } }), "settingsProjection");
    expect(h.text()).toContain("SimpleDefault ProviderOpenAI Work · ConnectedDefault ModelReasoningProvider Default");
    expect(h.text()).not.toContain("Advanced Role Assignments");
    expect(h.elements.get("timeline")!.descendants().some((item) => item.tagName === "input" && item.attributes.has("list"))).toBe(true);
    h.findButton("Use Simple Mode")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "setDefaultModel", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } });
    h.findButton("Advanced")?.dispatch("click");
    expect(h.text()).toContain("Advanced Role Assignments");
    expect(h.text()).not.toContain("SimpleDefault Provider");
    for (const role of ["Planner", "Executor", "Reviewer"]) expect(h.text()).toContain(role);
    expect(h.text().match(/Reasoning/g)?.length).toBeGreaterThanOrEqual(3);
    expect(h.text()).toContain("Repair uses Executor");
    h.findButton("Save Advanced Roles")?.dispatch("click");
    expect(h.messages.at(-1)?.assignments).toEqual([
      { role: "planner", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } },
      { role: "executor", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } },
      { role: "reviewer", providerConfigId: "work", modelId: "gpt-5.1", executionOptions: { kind: "provider_default" } },
    ]);
  });

  it("opens Models & Roles from the composer summary without changing provider or model directly", () => {
    const h = harness(); h.emit(baseState());
    expect(h.elements.get("model")?.textContent).toBe("Gateway · route/model");
    h.elements.get("model")?.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "openSettingsSection", section: "modelsRoles" });
    expect(h.messages.some((message) => message.type === "selectModel")).toBe(false);
  });

  it("finishes post-login model and effort selection entirely inside Nyxara", () => {
    const provider = { ...settingsProjection.providers[0], id: "claude-code-cli", adapterId: "claude-code-cli", displayName: "Claude Code", providerName: "Claude Code", authStrategy: "subscription_cli", defaultModel: undefined, modelsStatus: "loaded", models: [{ id: "opus", name: "Opus", capabilities: { reasoning: true, execution: { kind: "anthropic_effort", label: "Effort", control: "select", values: [{ value: "high", label: "High" }], provenance: "provider_discovery" } } }] };
    const projection = { ...settingsProjection, providers: [provider], defaultProviderConfigId: provider.id, defaultModel: undefined, modelMode: "simple", roles: [] };
    const h = harness(); h.emit(baseState({ configured: false, providers: [{ id: provider.id, displayName: provider.displayName, isDefault: true }], settings: { section: "modelsRoles", projection } }), "authCompleted");
    expect(h.text()).toContain("Connected. Choose a model and its execution setting here to finish setup.");
    const modelInput = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "input" && item.attributes.has("list"))!;
    modelInput.value = "opus"; modelInput.dispatch("input");
    const effort = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "select" && item.children.some((child) => child.allText() === "High"))!;
    effort.value = "high"; effort.dispatch("change");
    const save = h.findButton("Use Simple Mode"); expect(save).toBeDefined(); expect(modelInput.value).toBe("opus");
    save!.dispatch("click");
    expect(h.messages.at(-1)).toEqual({ type: "setDefaultModel", providerConfigId: provider.id, modelId: "opus", executionOptions: { kind: "anthropic_effort", effort: "high" } });
    expect(h.messages.some((message) => message.type === "selectModel")).toBe(false);
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

  it.each(["usage", "performance", "tokens", "latency", "context", "tools", "cost", "repair"])("finds Usage & Performance locally for %s", (query) => {
    const h = harness(); h.emit(baseState({ settings: { section: "home", projection: settingsProjection } }), "settingsProjection"); const count = h.messages.length;
    const search = h.elements.get("timeline")!.descendants().find((item) => item.tagName === "input" && item.attributes.get("aria-label") === "Search settings locally")!; search.value = query; search.dispatch("input");
    expect(h.text()).toContain("Usage & Performance"); expect(h.messages).toHaveLength(count);
  });

  it("renders factual Usage & Performance settings without optimization", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "usage", projection: settingsProjection } }), "settingsProjection");
    for (const value of ["Token Reporting", "Provider-reported when available", "Usage Estimates", "Provenance retained", "Provider-reported only / existing provenance", "Task Performance", "Stored locally", "Attributed per role/model", "Automatic Optimization", "Not enabled"]) expect(h.text()).toContain(value);
  });

  it("renders provider details with separate Disconnect and Remove Provider actions and never a stored key", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "aiProviders", providerConfigId: "work", projection: settingsProjection } }), "providerConfigs"); expect(h.text()).toContain("Provider Details"); expect(h.text()).toContain("Credential stored securely"); expect(h.text()).toContain("Disconnect"); expect(h.text()).toContain("Remove Provider"); expect(h.text()).toContain("Configure Models & Roles"); expect(h.text()).not.toContain("Choose discovered model"); expect(h.text()).not.toContain("Change Model"); expect(h.text()).not.toContain("sk-"); h.findButton("Test Connection")?.dispatch("click"); expect(h.messages.at(-1)).toEqual({ type: "testProvider", providerConfigId: "work" });
  });

  it("renders Settings projections without prompts, raw responses, source, or tool output", () => {
    const h = harness(); h.emit(baseState({ settings: { section: "about", projection: settingsProjection, diagnostics: { version: "0.1.0-alpha.8", providers: [{ adapterId: "openai", requestedModelId: "gpt-work" }] } } }), "diagnostics"); const text = h.text(); expect(text).toContain("Privacy-safe Diagnostics"); for (const forbidden of ["apiKey", "oauthToken", "raw provider response", "private prompt", "tool output", "/home/"]) expect(text).not.toContain(forbidden);
  });
});
