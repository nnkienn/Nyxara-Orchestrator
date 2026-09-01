import fs from "node:fs/promises";
import type { BenchmarkReport } from "../scenario.types.js";
import { BENCHMARK_RUNNER_VERSION } from "../scenario.types.js";
import { sanitizeForReport } from "../privacy.js";
export async function writeJsonReport(file: string, report: BenchmarkReport) { const safe = sanitizeForReport(report) as BenchmarkReport; safe.summary = { ...safe.summary, benchmarkRunnerVersion: BENCHMARK_RUNNER_VERSION }; await fs.writeFile(file, JSON.stringify(safe, null, 2) + "\n"); }
