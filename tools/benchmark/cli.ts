#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { BenchmarkRunner, writeSamplesCsv } from "./benchmark-runner.js";
import { writeJsonReport } from "./reporters/json-reporter.js";
import { writeCsvReport } from "./reporters/csv-reporter.js";
import { writeMarkdownReport } from "./reporters/markdown-reporter.js";
import { compareReports } from "./compare.js";
import { validateConfig } from "./config.js";

const args = process.argv.slice(2); const command = args[0] ?? "run";
function value(flag: string) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }
if (command === "compare") { const d = await compareReports(args[1]!, args[2]!); console.table(d); } else {
  const c = BenchmarkRunner.defaults(process.cwd());
  if (args.includes("--quick")) Object.assign(c, { warmupRuns: 0, measuredRuns: 2, idleDurationMs: 5000, stabilizationMs: 250, longRunWorkflows: 5 });
  if (args.includes("--full")) Object.assign(c, { warmupRuns: 1, measuredRuns: 5, idleDurationMs: 30000, stabilizationMs: 5000, longRunWorkflows: 20 });
  if (args.includes("--realistic")) Object.assign(c, { realistic: true, sampleIntervalMs: 150, workloadProfile: "normal", stabilizationMs: 1000 });
  const profile = value("--profile"); if (profile && ["light", "normal", "heavy", "repair-heavy"].includes(profile)) c.workloadProfile = profile as any;
  const s = value("--scenario"); if (s) c.scenarios = [s];
  const pm = value("--provider-mode"); if (pm === "real") { c.providerMode = "real"; console.warn("Real provider calls may incur usage/cost."); }
  const label = value("--label"); if (label) c.label = label; const output = value("--output"); if (output) c.outputDir = output;
  if (command === "extension" && !s) c.scenarios = ["extension-idle"];
  validateConfig(c); const controller = new AbortController(); process.once("SIGINT", () => controller.abort()); const { report, samples } = await new BenchmarkRunner(c).run(controller.signal); const dir = path.join(c.outputDir, report.benchmarkRunId); await fs.mkdir(dir, { recursive: true }); await Promise.all([writeJsonReport(path.join(dir, "report.json"), report), writeCsvReport(path.join(dir, "report.csv"), report), writeMarkdownReport(path.join(dir, "report.md"), report), writeSamplesCsv(path.join(dir, "samples.csv"), samples), fs.writeFile(path.join(dir, "environment.json"), JSON.stringify(report.environment, null, 2))]); console.log(dir); }
