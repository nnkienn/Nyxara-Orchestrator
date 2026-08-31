import { NyxaraOrchestrator } from "@nyxara/core";
import { describe, expect, it, vi } from "vitest";
import { runPlanCli, runProfilesCli, type CliIO } from "../src/cli.js";

describe("planning profile CLI", () => {
  it("lists compact built-in profile columns", () => {
    const output: string[] = [];
    runProfilesCli({ write: (value) => output.push(value), question: async () => "" }, new NyxaraOrchestrator());
    expect(output.join("")).toContain("ID\tName\tLanguage\tStyle\tRisk");
    expect(output.join("")).toContain("default\tDefault\ten\tbalanced\tbalanced");
  });

  it("passes an explicit profile selection to Core planning", async () => {
    const createPlan = vi.fn(async () => { throw new Error("stop after capture"); });
    const core = {
      events: new NyxaraOrchestrator().events,
      listProviders: () => [{ id: "fake", displayName: "Fake", capabilities: {} }],
      listModels: async () => [{ id: "model", name: "Model", provider: "fake" }],
      configureAgent: vi.fn(), createPlan,
    } as unknown as NyxaraOrchestrator;
    const answers = ["", ""];
    const io: CliIO = { write: () => {}, question: async () => answers.shift() ?? "" };
    await expect(runPlanCli(io, core, "/workspace", "Plan", "detailed")).rejects.toThrow("stop after capture");
    expect(createPlan).toHaveBeenCalledWith({ workspaceRoot: "/workspace", prompt: "Plan", planningProfileId: "detailed" });
  });
});
