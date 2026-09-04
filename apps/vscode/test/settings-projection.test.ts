import { describe, expect, it } from "vitest";
import { buildSanitizedDiagnostics, buildSettingsProjection, providerStatus } from "../src/settings-projection.js";

const openai = { id: "openai-work", catalogId: "openai", type: "openai" as const, displayName: "OpenAI Work", modelId: "gpt-work", baseUrl: "https://api.openai.com/v1", authStrategy: "api_key" as const, createdAt: "2026-09-04T00:00:00.000Z" };
const local = { id: "ollama", type: "ollama" as const, displayName: "Ollama Local", modelId: "local-model", baseUrl: "http://localhost:11434/v1", authStrategy: "local" as const };

function projection(overrides: Record<string, unknown> = {}) {
  return buildSettingsProjection({
    version: "0.1.0-alpha.8", providers: [openai, local], defaultProviderId: openai.id, credentialStored: new Map([[openai.id, true]]), testedProviderIds: new Set([openai.id]), modelMode: "advanced",
    roles: [{ role: "planner", providerConfigId: openai.id, modelId: "gpt-work" }, { role: "executor", providerConfigId: local.id, modelId: "local-model" }, { role: "reviewer", providerConfigId: openai.id, modelId: "gpt-review" }],
    selectedPlanningProfile: "default", planningProfiles: [{ id: "default", name: "Default", outputLanguage: "en", planStyle: "balanced", riskMode: "balanced" }],
    engineeringRules: [{ id: "avoid-secret-exposure", name: "Avoid secret exposure", description: "Never expose secrets", scope: "global", severity: "error", enabled: true, instruction: "raw internal instruction" }],
    historyRetention: 50, historyCount: 12, workspaceFolders: [{ id: "root-0", label: "Project" }], selectedWorkspaceRootId: "root-0", ...overrides,
  } as any);
}

describe("Settings authoritative projection", () => {
  it("projects multiple provider instances, lifecycle states, defaults, and mixed role assignments without secrets", () => {
    const value = projection(); expect(value.providers.map((provider) => provider.id)).toEqual(["openai-work", "ollama"]); expect(value.providers[0]).toMatchObject({ displayName: "OpenAI Work", status: "Connected", credentialStored: true, lifecycleAction: "Disconnect", isDefault: true }); expect(value.providers[1]).toMatchObject({ status: "Connection unknown", lifecycleAction: "Remove Provider" }); expect(value.roles.map((role) => [role.role, role.providerConfigId, role.modelId])).toEqual([["planner", "openai-work", "gpt-work"], ["executor", "ollama", "local-model"], ["reviewer", "openai-work", "gpt-review"]]); expect(JSON.stringify(value)).not.toContain("apiKey");
  });

  it("does not claim connected from config or credential presence alone", () => {
    expect(providerStatus(openai, false)).toBe("Credential missing"); expect(providerStatus(openai, true)).toBe("Connection unknown"); expect(providerStatus(openai, true, true)).toBe("Connected"); expect(providerStatus(local, false)).toBe("Connection unknown"); expect(providerStatus(local, false, true)).toBe("Local available"); expect(providerStatus({ ...openai, signedOut: true }, true, true)).toBe("Signed out");
  });

  it("marks signed-out role references unavailable without rerouting them", () => {
    const value = projection({ providers: [{ ...openai, signedOut: true }, local], testedProviderIds: new Set() }); const planner = value.roles.find((role) => role.role === "planner"); expect(planner).toMatchObject({ providerConfigId: openai.id, modelId: "gpt-work", available: false, status: "Signed out" });
  });

  it("projects public profiles and rule metadata but not internal instructions or precedence logic", () => {
    const value = projection(); expect(value.planning.profiles[0]).toEqual({ id: "default", name: "Default", outputLanguage: "en", planStyle: "balanced", riskMode: "balanced" }); expect(value.rules[0]).toEqual({ id: "avoid-secret-exposure", name: "Avoid secret exposure", description: "Never expose secrets", scope: "global", severity: "error", enabled: true }); expect(JSON.stringify(value.rules)).not.toContain("raw internal instruction");
  });

  it("projects actual bounded context, validation, review, and repair behavior", () => {
    const value = projection(); expect(value.context).toMatchObject({ strategy: "Automatic", repositoryContext: "On demand", targetedExpansion: "Enabled", bounded: "Enabled", maxTaskFiles: 6 }); expect(value.validation.steps.map((step) => step.kind)).toEqual(["Typecheck", "Lint", "Tests", "Build"]); expect(value.review).toMatchObject({ rulesApplied: true, validationFailuresForceFail: true, boundedEvidence: true }); expect(value.repair).toMatchObject({ automatic: true, validationFirst: true, plannerReplan: false, contextReuse: true, usesRole: "Executor", maximumCycles: 3 });
  });

  it("exposes safe permission policy without an allow-all state", () => {
    const text = JSON.stringify(projection().permissions); expect(text).toContain("Outside workspace"); expect(text).toContain("Credential file writes"); expect(text).toContain("Git push/reset/clean"); expect(text.toLocaleLowerCase()).not.toContain("allow everything"); expect(text.toLocaleLowerCase()).not.toContain("yolo");
  });

  it("keeps workspace labels safe and omits absolute paths", () => {
    const value = projection(); expect(value.workspace).toMatchObject({ currentWorkspace: "Project", selectedRoot: "root-0" }); expect(JSON.stringify(value.workspace)).not.toContain("/home/");
  });

  it("creates allowlisted diagnostics without credentials, prompts, source, outputs, or raw responses", () => {
    const diagnostics = buildSanitizedDiagnostics(projection(), { status: "executing", active: true }); const text = JSON.stringify({ ...diagnostics, ignoredInput: undefined }); expect(text).toContain("openai-work"); expect(text).toContain("gpt-work"); for (const forbidden of ["credentialStored", "api-key", "prompt", "source", "toolOutput", "rawResponse", "Authorization"]) expect(text).not.toContain(forbidden);
  });
});
