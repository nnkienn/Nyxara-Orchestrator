import { describe, expect, it } from "vitest";
import { BenchmarkRunner, WORKLOAD_PROFILES } from "../benchmark-runner.js";
import { BenchmarkFakeProvider } from "../fake-provider.js";
describe("realistic benchmark workloads", () => {
  it("keeps plan-only role metrics free of execution/review/repair work", async () => { const c = BenchmarkRunner.defaults(process.cwd()); Object.assign(c, { warmupRuns: 0, measuredRuns: 1, stabilizationMs: 1, sampleIntervalMs: 100, scenarios: ["plan-only"], workloadProfile: "light" as const }); const { report } = await new BenchmarkRunner(c).run(); const m = report.scenarios[0]!.runs[0]!.metrics as any; expect(m.providerCallsByRole).toMatchObject({ planner: 1, executor: 0, reviewer: 0, repair: 0 }); expect(m.toolCalls).toBe(0); expect(m.reviewCalls).toBe(0); expect(m.repairCycles).toBe(0); });
  it("uses bounded realistic profile sizes", () => { expect(WORKLOAD_PROFILES.light.contextBytes).toBeGreaterThanOrEqual(8_000); expect(WORKLOAD_PROFILES.normal.contextBytes).toBeGreaterThan(WORKLOAD_PROFILES.light.contextBytes); expect(WORKLOAD_PROFILES.heavy.contextBytes).toBeLessThan(1_000_000); });
  it("supports deterministic provider latency and usage", async () => { const provider = new BenchmarkFakeProvider({ plannerDelayMs: 10, responseBytes: 400 }); const r = await provider.call("planner", 800); expect(r.latencyMs).toBeGreaterThanOrEqual(8); expect(r.usage.total).toBe(300); expect(provider.calls).toHaveLength(1); });
});
