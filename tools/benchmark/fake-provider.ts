import { performance } from "node:perf_hooks";
import type { TokenUsage, WorkloadProfile } from "./scenario.types.js";
import { WORKLOAD_PROFILES } from "./benchmark-runner.js";

export interface FakeProviderOptions { plannerDelayMs?: number; executorDelayMs?: number; reviewerDelayMs?: number; repairDelayMs?: number; responseBytes?: number; profile?: WorkloadProfile; }
export interface FakeProviderResult { role: "planner" | "executor" | "reviewer" | "repair"; latencyMs: number; usage: TokenUsage; responseBytes: number; structuredOutput: boolean; toolCalls: number; }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class BenchmarkFakeProvider {
  readonly calls: FakeProviderResult[] = [];
  constructor(private readonly options: FakeProviderOptions = {}) {}
  async call(role: FakeProviderResult["role"], inputBytes = 0, toolCalls = 0): Promise<FakeProviderResult> { const profile = this.options.profile ? WORKLOAD_PROFILES[this.options.profile] : WORKLOAD_PROFILES.normal; const delay = role === "planner" ? this.options.plannerDelayMs ?? profile.plannerDelayMs : role === "executor" ? this.options.executorDelayMs ?? profile.executorDelayMs : role === "reviewer" ? this.options.reviewerDelayMs ?? profile.reviewerDelayMs : this.options.repairDelayMs ?? profile.repairDelayMs; const start = performance.now(); await wait(delay); const output = this.options.responseBytes ?? Math.max(256, Math.round(inputBytes * 0.15)); const result: FakeProviderResult = { role, latencyMs: performance.now() - start, usage: { input: Math.ceil(inputBytes / 4), output: Math.ceil(output / 4), total: Math.ceil(inputBytes / 4) + Math.ceil(output / 4), calls: 1 }, responseBytes: output, structuredOutput: true, toolCalls }; this.calls.push(result); return result; }
}
