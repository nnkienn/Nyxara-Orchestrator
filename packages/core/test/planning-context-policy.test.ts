import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GenerateRequest, ModelProvider } from "@nyxara/provider-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLANNER_OUTPUT_TOKENS,
  MIN_PLANNER_OUTPUT_TOKENS,
  NyxaraOrchestrator,
  boundPlannerOutputTokens,
  decidePlanningContext,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const validDraft = {
  objective: "Add pagination",
  tasks: [{
    id: "T1", title: "Implement pagination", description: "Add bounded pagination.",
    dependencies: [], acceptanceCriteria: ["Pagination is covered"],
  }],
};

function fakeProvider(generate: ModelProvider["generate"]): ModelProvider {
  return {
    id: "fake", displayName: "Fake",
    capabilities: () => ({ modelDiscovery: true, textGeneration: true, structuredOutput: true }),
    listModels: async () => [{ id: "model", name: "Model", provider: "fake" }],
    generate,
  };
}

describe("deterministic pre-planning context policy", () => {
  it("treats greetings and pleasantries as trivial with zero repository context", () => {
    for (const prompt of ["hello", "helo", "hi", "hey", "thanks", "test", "?", "can you help?"]) {
      const decision = decidePlanningContext({ prompt });
      expect(decision.classification, prompt).toBe("trivial");
      expect(decision.mode, prompt).toBe("none");
      expect(decision.repositoryRetrieval, prompt).toBe(false);
      expect(decision.clarificationRequired, prompt).toBe(true);
      expect(decision.clarificationReason, prompt).toBe("trivial");
      expect(decision.focusPaths, prompt).toEqual([]);
    }
  });

  it("keeps an underspecified coding request on a minimal focused budget", () => {
    for (const prompt of ["fix this", "make it better", "update API"]) {
      const decision = decidePlanningContext({ prompt });
      expect(decision.mode, prompt).toBe("minimal");
      expect(decision.classification, prompt).toBe("underspecified");
      expect(decision.clarificationRequired, prompt).toBe(true);
      expect(decision.repositoryRetrieval, prompt).toBe(false);
      expect(decision.focusOnly, prompt).toBe(true);
      expect(decision.contextBudget?.maxBytes, prompt).toBeLessThan(32 * 1024);
      expect(decision.plannerMaxOutputTokens, prompt).toBeLessThan(DEFAULT_PLANNER_OUTPUT_TOKENS);
    }
  });

  it("anchors an underspecified request on cheap editor signals without a full scan", () => {
    const decision = decidePlanningContext({
      prompt: "fix this",
      signals: { activeFilePath: "src/api/notifications.ts", selection: { path: "src/api/notifications.ts", lineCount: 12 } },
    });
    expect(decision.mode).toBe("minimal");
    // An anchored request can plan directly; it still must not scan broadly.
    expect(decision.clarificationRequired).toBe(false);
    expect(decision.focusPaths).toEqual(["src/api/notifications.ts"]);
    expect(decision.focusOnly).toBe(true);
  });

  it("still asks what to fix when only an active file is available", () => {
    const decision = decidePlanningContext({
      prompt: "fix this",
      signals: { activeFilePath: "src/api/notifications.ts" },
    });
    expect(decision.classification).toBe("underspecified");
    expect(decision.clarificationRequired).toBe(true);
    expect(decision.repositoryRetrieval).toBe(false);
  });

  it("uses a small exclusive focus for an explicitly targeted request", () => {
    const decision = decidePlanningContext({
      prompt: "Fix pagination in backend/app/modules/rem/notifications/service.py",
    });
    expect(decision.mode).toBe("targeted");
    expect(decision.classification).toBe("targeted");
    expect(decision.focusPaths).toContain("backend/app/modules/rem/notifications/service.py");
    expect(decision.focusOnly).toBe(true);
    expect(decision.contextBudget?.maxFiles).toBeLessThan(8);
  });

  it("recognizes explicit lowercase symbols and named modules as targeted", () => {
    for (const prompt of ["Fix function retry", "Refactor notifications module"]) {
      const decision = decidePlanningContext({ prompt });
      expect(decision.classification, prompt).toBe("targeted");
      expect(decision.mode, prompt).toBe("targeted");
      expect(decision.focusOnly, prompt).toBe(true);
    }
  });

  it("allows normal bounded retrieval only for genuinely broad requests", () => {
    for (const prompt of [
      "Audit authentication architecture across the repository",
      "Refactor notification architecture across CRM, REM and HRM modules",
    ]) {
      const decision = decidePlanningContext({ prompt });
      expect(decision.mode, prompt).toBe("normal");
      expect(decision.classification, prompt).toBe("normal_repository_task");
      expect(decision.repositoryRetrieval, prompt).toBe(true);
      expect(decision.focusOnly, prompt).toBe(false);
      expect(decision.contextBudget, prompt).toBeUndefined();
      expect(decision.plannerMaxOutputTokens, prompt).toBe(DEFAULT_PLANNER_OUTPUT_TOKENS);
    }
  });

  it("corrects an unusable configured Planner output limit to a safe range", () => {
    expect(boundPlannerOutputTokens(16)).toBe(MIN_PLANNER_OUTPUT_TOKENS);
    expect(boundPlannerOutputTokens(Number.NaN)).toBe(DEFAULT_PLANNER_OUTPUT_TOKENS);
    expect(boundPlannerOutputTokens(undefined)).toBe(DEFAULT_PLANNER_OUTPUT_TOKENS);
    expect(boundPlannerOutputTokens(10_000_000)).toBeLessThanOrEqual(32_000);
  });
});

describe("planning context policy applied through Core", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-policy-"));
    await mkdir(join(workspace, "src", "notification"), { recursive: true });
    await mkdir(join(workspace, "src", "users"), { recursive: true });
    await writeFile(join(workspace, "src", "notification", "service.ts"), "export function listNotifications() { return []; }\n");
    await writeFile(join(workspace, "src", "notification", "controller.ts"), "export const notificationController = 'pagination';\n");
    await writeFile(join(workspace, "src", "users", "user.service.ts"), "export function listUsers() { return []; }\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@nyxara.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Nyxara Test"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function orchestrator() {
    const generate = vi.fn(async (request: GenerateRequest) => ({
      provider: "fake", model: request.model, text: JSON.stringify(validDraft),
    }));
    const core = new NyxaraOrchestrator({
      providers: [fakeProvider(generate)],
      agents: [{ role: "planner", providerId: "fake", modelId: "model" }],
    });
    return { core, generate };
  }

  it("resolves a trivial greeting locally with no provider call and no repository search", async () => {
    const { core, generate } = orchestrator();
    const searches: string[] = [];
    const policyEvents: any[] = [];
    core.events.on("tool.started", (event: any) => searches.push(event.tool));
    core.events.on("context.policy_resolved", (event) => policyEvents.push(event));
    const decision = core.planningContextDecision({ prompt: "helo" });
    expect(decision.mode).toBe("none");
    const clarification = core.requestPlanClarification({ prompt: "helo", decision });
    expect(clarification.kind).toBe("clarification_required");
    expect(clarification.contextMetrics).toMatchObject({ planningContextMode: "none", files: 0, bytes: 0 });
    // No model call, and no repository tool ran at all.
    expect(generate).not.toHaveBeenCalled();
    expect(searches).toEqual([]);
    expect(policyEvents).toEqual([expect.objectContaining({
      classification: "trivial",
      planningContextMode: "none",
      files: 0,
      bytes: 0,
      truncated: false,
      plannerMaxOutputTokens: null,
    })]);
  });

  it("defensively rejects a trivial direct createPlan call before context or Planner work", async () => {
    const { core, generate } = orchestrator();
    const tools: string[] = [];
    core.events.on("tool.started", (event: any) => tools.push(event.tool));
    await expect(core.createPlan({ workspaceRoot: workspace, prompt: "helo" }))
      .rejects.toMatchObject({ code: "clarification_required" });
    expect(generate).not.toHaveBeenCalled();
    expect(tools).toEqual([]);
  });

  it("defensively rejects an unanchored underspecified direct call before broad context", async () => {
    const { core, generate } = orchestrator();
    const tools: string[] = [];
    core.events.on("tool.started", (event: any) => tools.push(event.tool));
    await expect(core.createPlan({ workspaceRoot: workspace, prompt: "fix this" }))
      .rejects.toMatchObject({ code: "clarification_required" });
    expect(generate).not.toHaveBeenCalled();
    expect(tools).toEqual([]);
  });

  it("records planningContextMode with bounded context metadata and no source content", async () => {
    const { core, generate } = orchestrator();
    const policyEvents: any[] = [];
    core.events.on("context.policy_resolved", (event) => policyEvents.push(event));
    const result = await core.createPlan({
      workspaceRoot: workspace,
      prompt: "Fix pagination in src/notification/service.ts",
    });
    expect(result.planningContextMode).toBe("targeted");
    expect(result.contextMetrics).toMatchObject({ planningContextMode: "targeted" });
    expect(policyEvents[0]).toMatchObject({ planningContextMode: "targeted", repositoryRetrieval: true });
    // Observability stays metadata-only.
    expect(JSON.stringify(policyEvents)).not.toContain("listNotifications");
    // Classification is local; the sole provider call is the Planner itself.
    expect(generate).toHaveBeenCalledOnce();
  });

  it("uses only targeted evidence instead of filling the remaining budget", async () => {
    const { core } = orchestrator();
    const result = await core.createPlan({
      workspaceRoot: workspace,
      prompt: "Fix pagination in src/notification/service.ts",
    });
    expect(result.context.files.map((file) => file.path)).toEqual(["src/notification/service.ts"]);
    expect(result.context.files.every((file) => !file.path.includes("users"))).toBe(true);
    expect(result.context.git.diff.diff).toBe("");
  });

  it("uses an editor anchor as minimal context without loading the repository neighborhood", async () => {
    const { core } = orchestrator();
    const result = await core.createPlan({
      workspaceRoot: workspace,
      prompt: "fix this",
      requestSignals: {
        activeFilePath: "src/notification/service.ts",
        selection: { path: "src/notification/service.ts", lineCount: 3 },
      },
    });
    expect(result.planningContextMode).toBe("minimal");
    expect(result.context.files.map((file) => file.path)).toEqual(["src/notification/service.ts"]);
    expect(result.context.git.diff.diff).toBe("");
    expect(result.context.totalBytes).toBeLessThanOrEqual(12 * 1024);
  });

  it("keeps normal bounded retrieval for a broad request", async () => {
    const { core } = orchestrator();
    const result = await core.createPlan({
      workspaceRoot: workspace,
      prompt: "Audit the notification and user service architecture across the whole repository",
    });
    expect(result.planningContextMode).toBe("normal");
    expect(result.context.files.length).toBeGreaterThan(1);
    expect(result.context.files.length).toBeLessThanOrEqual(8);
  });

  it("bounds Planner output per role without touching Executor or Reviewer", async () => {
    const requests: GenerateRequest[] = [];
    const generate = vi.fn(async (request: GenerateRequest) => {
      requests.push(request);
      return { provider: "fake", model: request.model, text: JSON.stringify(validDraft) };
    });
    const core = new NyxaraOrchestrator({
      providers: [fakeProvider(generate)],
      agents: [
        { role: "planner", providerId: "fake", modelId: "model" },
        { role: "executor", providerId: "fake", modelId: "model" },
        { role: "reviewer", providerId: "fake", modelId: "model" },
      ],
    });
    await core.createPlan({ workspaceRoot: workspace, prompt: "Fix pagination in src/notification/service.ts" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.maxOutputTokens).toBeDefined();
    expect(requests[0]!.maxOutputTokens).toBeLessThan(DEFAULT_PLANNER_OUTPUT_TOKENS);
    // Executor and Reviewer requests carry no Planner-specific output bound.
    expect(core.getAgentModel("executor")).toMatchObject({ role: "executor" });
    expect(core.getAgentModel("reviewer")).toMatchObject({ role: "reviewer" });
  });

  it("does not stream progress for a transport that reports no streaming support", async () => {
    const { core } = orchestrator();
    const progress: unknown[] = [];
    core.events.on("provider.generation.progress", (event) => progress.push(event));
    await core.createPlan({ workspaceRoot: workspace, prompt: "Fix pagination in src/notification/service.ts" });
    expect(progress).toEqual([]);
  });

  it("emits safe structured progress for a streaming-capable transport", async () => {
    const streamingProvider: ModelProvider = {
      id: "streaming", displayName: "Streaming",
      capabilities: () => ({ modelDiscovery: true, textGeneration: true, structuredOutput: true, progressStreaming: true }),
      listModels: async () => [{ id: "model", name: "Model", provider: "streaming" }],
      generate: async (request) => {
        request.onProgress?.({ phase: "request_started" });
        request.onProgress?.({ phase: "response_started" });
        request.onProgress?.({ phase: "request_completed" });
        return { provider: "streaming", model: request.model, text: JSON.stringify(validDraft) };
      },
    };
    const core = new NyxaraOrchestrator({
      providers: [streamingProvider],
      agents: [{ role: "planner", providerId: "streaming", modelId: "model" }],
    });
    const progress: any[] = [];
    core.events.on("provider.generation.progress", (event) => progress.push(event));
    await core.createPlan({ workspaceRoot: workspace, prompt: "Fix pagination in src/notification/service.ts" });
    expect(progress.map((event) => event.phase)).toEqual(["request_started", "response_started", "request_completed"]);
    // Progress carries phases only: never model text, reasoning, or plan JSON.
    const serialized = JSON.stringify(progress);
    expect(serialized).not.toContain("objective");
    expect(serialized).not.toContain("Implement pagination");
    for (const event of progress) expect(Object.keys(event).sort()).toEqual(["modelId", "phase", "providerConfigId", "providerId", "role", "timestamp"]);
  });
});
