import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { BenchmarkRunner } from "../benchmark-runner.js";

describe("real benchmark usage", () => {
  it("uses Core aggregation and verifies fixture validity", async () => {
    const config = BenchmarkRunner.defaults(process.cwd());
    Object.assign(config, {
      providerMode: "real", scenarios: ["real-workflow"], keepFixture: false,
      realProvider: { async generate(role: string, input: any) {
        if (role === "executor") {
          await fs.mkdir(`${input.workspaceRoot}/src`, { recursive: true });
          await fs.writeFile(`${input.workspaceRoot}/src/benchmark-utility.js`, "export const value = 1;\n");
          return { provider: "mock", model: "resolved", latencyMs: 2, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, toolCallSupported: true, toolCallSucceeded: true, toolCallCount: 1, invalidToolCalls: 0 };
        }
        return { provider: "mock", model: "resolved", latencyMs: 1, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, structuredOutputValid: true };
      } },
    });
    const { report } = await new BenchmarkRunner(config).run();
    const run = report.scenarios[0]!.runs[0] as any;
    expect(run).toMatchObject({ fixtureCreated: true, fixtureChanged: true, validationPassed: true });
    expect(run.changedFileCount).toBeGreaterThan(0);
    expect(run.usage.totalTokens).toBe(9);
    expect(run.usage.planner).toMatchObject({ requestedModelId: "default", resolvedModelId: "resolved" });
  });
});
