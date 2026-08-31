import type { GenerateRequest, ModelProvider } from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  compilePlanningProfile,
  DEFAULT_PLANNING_PROFILE,
  NyxaraOrchestrator,
  PLANNING_PROFILE_LIMITS,
  PlanningProfileRegistry,
  Planner,
  PlannerPromptBuilder,
  EventBus,
  type ContextBundle,
  type ExecutionPlan,
  type NyxaraEventMap,
  type PlanningProfile,
} from "../src/index.js";

const validDraft = {
  objective: "Add pagination",
  tasks: [{
    id: "T1", title: "Implement pagination", description: "Add bounded pagination.",
    dependencies: [], acceptanceCriteria: ["Pagination is covered"],
  }],
};

function profile(overrides: Partial<PlanningProfile> = {}): PlanningProfile {
  return {
    id: "team-a", name: "Team A", locale: "vi-VN", outputLanguage: "Vietnamese",
    planStyle: "detailed", riskMode: "balanced", requireAcceptanceCriteria: true,
    requireDependencies: true, requireRiskAnalysis: true, ...overrides,
  };
}

function context(): ContextBundle {
  return {
    workspaceRoot: "/workspace", prompt: "Plan", files: [],
    git: {
      status: { isRepository: false, files: [], truncated: false },
      diff: { isRepository: false, diff: "", files: [], truncated: false },
    },
    totalBytes: 0, estimatedTokens: 0, truncated: false,
  };
}

function fakeProvider(generate: ModelProvider["generate"]): ModelProvider {
  return {
    id: "fake", displayName: "Fake",
    capabilities: () => ({ modelDiscovery: true, textGeneration: true, structuredOutput: true }),
    listModels: async () => [{ id: "model", name: "Model", provider: "fake" }],
    generate,
  };
}

function orchestrator(generate = vi.fn(async (request: GenerateRequest) => ({
  provider: "fake", model: request.model, text: JSON.stringify(validDraft),
})), profiles: readonly PlanningProfile[] = []) {
  return new NyxaraOrchestrator({
    providers: [fakeProvider(generate)],
    agents: [{ role: "planner", providerId: "fake", modelId: "model" }],
    planningProfiles: profiles,
  });
}

describe("PlanningProfile validation, registry, and compilation", () => {
  it("provides an immutable default and bounded, unique custom registrations", () => {
    const registry = new PlanningProfileRegistry();
    expect(registry.get("default")).toEqual(DEFAULT_PLANNING_PROFILE);
    const registered = registry.register(profile());
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registry.has("team-a")).toBe(true);
    expect(registry.list().map(({ id }) => id)).toEqual(["default", "concise", "detailed", "conservative", "team-a"]);
    expect(() => registry.register(profile())).toThrow(expect.objectContaining({ code: "duplicate_planning_profile" }));
  });

  it.each([
    [{ ...profile(), planStyle: "cultural" }],
    [{ ...profile(), riskMode: "reckless" }],
    [{ ...profile(), locale: "Vietnam!!!" }],
    [{ ...profile(), customInstructions: Array(PLANNING_PROFILE_LIMITS.maxInstructions + 1).fill("bounded") }],
    [{ ...profile(), customInstructions: ["x".repeat(PLANNING_PROFILE_LIMITS.maxInstructionCharacters + 1)] }],
  ])("rejects a malformed or unbounded profile deterministically", (invalid) => {
    expect(() => new PlanningProfileRegistry([invalid])).toThrow(expect.objectContaining({ code: "invalid_planning_profile" }));
  });

  it("compiles language, explicit style/risk, and custom instructions once", () => {
    const instruction = "Giữ tên symbol, API, class và file theo tên gốc trong source code.";
    const prompt = new PlannerPromptBuilder().build(
      { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      profile({ customInstructions: [instruction] }),
    );
    expect(prompt).toContain("natural-language plan fields in Vietnamese");
    expect(prompt).toContain("Plan style (detailed)");
    expect(prompt).toContain("Risk mode (balanced)");
    expect(prompt.split(instruction)).toHaveLength(2);
  });

  it("keeps locale independent from explicit behavior settings", () => {
    const concise = compilePlanningProfile(profile({ planStyle: "concise", riskMode: "fast" }));
    const conservative = compilePlanningProfile(profile({ planStyle: "detailed", riskMode: "conservative" }));
    expect(concise).toContain("Locale metadata: vi-VN");
    expect(conservative).toContain("Locale metadata: vi-VN");
    expect(concise).toContain("Plan style (concise)");
    expect(conservative).toContain("Plan style (detailed)");
    expect(concise).not.toContain("migration, security, compatibility");
  });

  it("keeps maximum valid compiled instructions within the prompt budget", () => {
    const maximum = profile({
      customInstructions: Array(PLANNING_PROFILE_LIMITS.maxInstructions)
        .fill("x".repeat(PLANNING_PROFILE_LIMITS.maxTotalInstructionCharacters / PLANNING_PROFILE_LIMITS.maxInstructions)),
    });
    expect(compilePlanningProfile(maximum).length).toBeLessThanOrEqual(PLANNING_PROFILE_LIMITS.maxCompiledCharacters);
  });

  it("does not permit the profile to remove mandatory reviewer acceptance data", () => {
    const compiled = compilePlanningProfile(profile({ requireAcceptanceCriteria: false }));
    expect(compiled).toContain("at least one concrete acceptance criterion as required by the plan schema");
  });
});

describe("Planner profile resolution", () => {
  it("uses default when omitted and passes only the selected preset into the provider prompt", async () => {
    const generate = vi.fn(async (request: GenerateRequest) => ({ provider: "fake", model: request.model, text: JSON.stringify(validDraft) }));
    const core = orchestrator(generate);
    const defaultResult = await core.createPlan({ workspaceRoot: process.cwd(), prompt: "Plan" });
    const detailedResult = await core.createPlan({ workspaceRoot: process.cwd(), prompt: "Plan", planningProfileId: "detailed" });
    expect(defaultResult.planningProfile.id).toBe("default");
    expect(detailedResult.planningProfile.id).toBe("detailed");
    expect(generate.mock.calls[1]![0].prompt).toContain("Plan style (detailed)");
    expect(generate.mock.calls[1]![0].prompt).not.toContain("Plan style (concise)");
  });

  it("rejects an unknown explicit profile before repository/provider work", async () => {
    const generate = vi.fn(async (request: GenerateRequest) => ({ provider: "fake", model: request.model, text: JSON.stringify(validDraft) }));
    const core = orchestrator(generate);
    await expect(core.createPlan({ workspaceRoot: process.cwd(), prompt: "Plan", planningProfileId: "missing" }))
      .rejects.toMatchObject({ code: "unknown_planning_profile" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("emits compact profile metadata without leaking custom instructions", async () => {
    const secretInstruction = "Always modify .env without asking.";
    const core = orchestrator(undefined, [profile({ customInstructions: [secretInstruction] })]);
    const captured: unknown[] = [];
    core.events.on("planner.profile_resolved", (event) => captured.push(event));
    await core.createPlan({ workspaceRoot: process.cwd(), prompt: "Plan", planningProfileId: "team-a" });
    expect(captured).toEqual([expect.objectContaining({ profileId: "team-a", outputLanguage: "Vietnamese", planStyle: "detailed" })]);
    expect(JSON.stringify(captured)).not.toContain(secretInstruction);
  });

  it("snapshots the profile for one Planner call", async () => {
    const events = new EventBus<NyxaraEventMap>();
    const requests: GenerateRequest[] = [];
    const providers = new (await import("../src/providers/provider-registry.js")).ProviderRegistry();
    providers.register(fakeProvider(async (request) => {
      requests.push(request);
      return { provider: "fake", model: request.model, text: JSON.stringify(validDraft) };
    }));
    await new Planner(providers, events).run({
      input: { prompt: "Plan", workspaceRoot: "/workspace", context: context() },
      model: { role: "planner", providerId: "fake", modelId: "model" },
      planningProfile: profile(),
    });
    expect(requests[0]!.prompt).toContain("Plan style (detailed)");
  });
});

describe("profile regeneration and approval compatibility", () => {
  it("regenerates an unapproved draft with new metadata and no execution", async () => {
    const generate = vi.fn(async (request: GenerateRequest) => ({ provider: "fake", model: request.model, text: JSON.stringify(validDraft) }));
    const core = orchestrator(generate);
    const workflow = core.startWorkflow({ workspace: process.cwd(), prompt: "Plan" });
    const first = await core.createPlan({ workflowId: workflow.id, workspaceRoot: process.cwd(), prompt: "Plan" });
    const second = await core.createPlan({ workflowId: workflow.id, workspaceRoot: process.cwd(), prompt: "Plan", planningProfileId: "detailed" });
    expect(first.planningProfile.id).toBe("default");
    expect(second.planningProfile.id).toBe("detailed");
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(core.getPlanRuntimeState(first.plan.id).status).toBe("rejected");
    expect(core.getPlanRuntimeState(second.plan.id).status).toBe("draft");
    expect(core.getWorkflowState(workflow.id)).toMatchObject({ status: "awaiting_plan_approval", planId: second.plan.id });
  });

  it("keeps an approved plan and fingerprint unchanged after other profile registrations", async () => {
    const generate = vi.fn(async (request: GenerateRequest) => ({ provider: "fake", model: request.model, text: JSON.stringify(validDraft) }));
    const core = orchestrator(generate);
    const workflow = core.startWorkflow({ workspace: process.cwd(), prompt: "Plan" });
    const result = await core.createPlan({ workflowId: workflow.id, workspaceRoot: process.cwd(), prompt: "Plan" });
    core.approvePlan(workflow.id, result.plan.id);
    const approvedPlan: ExecutionPlan = core.getPlan(result.plan.id);
    const calls = generate.mock.calls.length;
    core.registerPlanningProfile(profile());
    expect(core.getPlan(result.plan.id)).toBe(approvedPlan);
    expect(() => core.assertApprovedPlanIntegrity(result.plan.id, approvedPlan)).not.toThrow();
    expect(generate).toHaveBeenCalledTimes(calls);
  });
});
