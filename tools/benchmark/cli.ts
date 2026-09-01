#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { BenchmarkRunner, writeSamplesCsv } from "./benchmark-runner.js";
import { writeJsonReport } from "./reporters/json-reporter.js";
import { writeCsvReport } from "./reporters/csv-reporter.js";
import { writeMarkdownReport } from "./reporters/markdown-reporter.js";
import { compareReportsDetailed } from "./compare.js";
import { validateConfig } from "./config.js";
import { BENCHMARK_RUNNER_VERSION } from "./scenario.types.js";
import { createPublicRealProvider } from "./real-provider.js";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args.shift()! : "run";
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const help = () => console.log(`Nyxara Benchmark\n\nCommands:\n  run [flags]                 Run local benchmark (default command)\n  extension [flags]           Profile a VS Code extension host\n  compare <before> <after>   Compare two report.json files\n\nCommon flags:\n  --quick --full --realistic --profile <light|normal|heavy|repair-heavy>\n  --scenario <name> --provider-mode <fake|real> --yes --quiet\n  --label <name> --output <dir> --keep-fixture --help`);
if (args.includes("--help") || command === "help") { help(); process.exit(0); }

if (command === "compare") {
  const result = await compareReportsDetailed(args[0]!, args[1]!);
  console.table(result.deltas);
  if (result.warnings.length) console.warn(`Warnings: ${result.warnings.join(", ")}`);
  process.exit(0);
}

const config = BenchmarkRunner.defaults(process.cwd());
if (args.includes("--quick")) Object.assign(config, { warmupRuns: 0, measuredRuns: 2, idleDurationMs: 5000, stabilizationMs: 250, longRunWorkflows: 5 });
if (args.includes("--full")) Object.assign(config, { warmupRuns: 1, measuredRuns: 5, idleDurationMs: 30000, stabilizationMs: 5000, longRunWorkflows: 20 });
if (args.includes("--realistic")) Object.assign(config, { realistic: true, stabilizationMs: 1000 });
const profile = value("--profile"); if (profile && ["light", "normal", "heavy", "repair-heavy"].includes(profile)) config.workloadProfile = profile as any;
const requestedScenario = value("--scenario"); if (requestedScenario) config.scenarios = [requestedScenario];
if (command === "extension" && !requestedScenario) config.scenarios = ["extension-idle"];
const providerMode = value("--provider-mode"); if (providerMode === "real") config.providerMode = "real";
if (config.providerMode === "real" && !requestedScenario && command !== "extension") config.scenarios = ["real-plan", "real-workflow"];
config.quiet = args.includes("--quiet"); config.yes = args.includes("--yes"); config.keepFixture = args.includes("--keep-fixture");
const matrixConfig = value("--matrix-config"); if (matrixConfig) config.matrixConfig = matrixConfig;
const label = value("--label"); if (label) config.label = label; const output = value("--output"); if (output) config.outputDir = output;
for (const role of ["planner", "executor", "reviewer"] as const) { const p = value(`--${role}-provider`); const m = value(`--${role}-model`); if (p) (config as any)[`${role}Provider`] = p; if (m) (config as any)[`${role}Model`] = m; else { const envModel = process.env[`NYXARA_BENCHMARK_${role.toUpperCase()}_MODEL`]; if (envModel) (config as any)[`${role}Model`] = envModel; } }
validateConfig(config);
if (config.providerMode === "real") {
  const roleProviders = { planner: config.plannerProvider ?? "openai-compatible", executor: config.executorProvider ?? "openai-compatible", reviewer: config.reviewerProvider ?? "openai-compatible" } as const;
  const configured = await createPublicRealProvider(roleProviders);
  config.realProvider = configured.adapter;
}
if (config.providerMode === "real" && !config.yes) {
  console.log(`Real provider mode is enabled.\nThis may incur API usage/cost.\nProviders/models:\nPlanner: ${config.plannerProvider ?? "openai-compatible"} / ${config.plannerModel ?? "default"}\nExecutor: ${config.executorProvider ?? "openai-compatible"} / ${config.executorModel ?? "default"}\nReviewer: ${config.reviewerProvider ?? "openai-compatible"} / ${config.reviewerModel ?? "default"}`);
  process.stdout.write("Continue? [y/N] ");
  const answer = await new Promise<string>(resolve => { process.stdin.setEncoding("utf8"); process.stdin.once("data", d => resolve(String(d).trim().toLowerCase())); });
  if (answer !== "y" && answer !== "yes") { console.log("Benchmark cancelled."); process.exit(0); }
}
if (config.providerMode === "real" && config.matrixConfig && !config.yes) {
  let count = 0;
  try { const matrix = JSON.parse(await fs.readFile(config.matrixConfig, "utf8")); count = Array.isArray(matrix) ? matrix.length : Array.isArray(matrix.configurations) ? matrix.configurations.length : 0; } catch { throw new Error("Unable to read --matrix-config"); }
  const expected = count * (config.scenarios.includes("real-workflow") ? 1 : 0);
  console.log(`Matrix configurations: ${count}\nExpected workflow runs: ${expected}\nPotential provider usage may apply.`);
  process.stdout.write("Continue? [y/N] ");
  const answer = await new Promise<string>(resolve => { process.stdin.setEncoding("utf8"); process.stdin.once("data", d => resolve(String(d).trim().toLowerCase())); });
  if (answer !== "y" && answer !== "yes") { console.log("Benchmark cancelled."); process.exit(0); }
}
const controller = new AbortController(); let aborted = false;
process.once("SIGINT", () => { aborted = true; controller.abort(); });
try {
  if (!config.quiet) { console.log(`Nyxara Benchmark\nMode: ${config.realistic ? "realistic" : "local"}\nProfile: ${config.workloadProfile}\nProvider: ${config.providerMode}`); }
  config.progress = (message) => console.log(message);
  const { report, samples } = await new BenchmarkRunner(config).run(controller.signal);
  report.summary.benchmarkRunnerVersion = BENCHMARK_RUNNER_VERSION;
  const dir = path.join(config.outputDir, report.benchmarkRunId); await fs.mkdir(dir, { recursive: true });
  await Promise.all([writeJsonReport(path.join(dir, "report.json"), report), writeCsvReport(path.join(dir, "report.csv"), report), writeMarkdownReport(path.join(dir, "report.md"), report), writeSamplesCsv(path.join(dir, "samples.csv"), samples), fs.writeFile(path.join(dir, "environment.json"), JSON.stringify(report.environment, null, 2))]);
  if (aborted || report.warnings.includes("benchmark_aborted")) { console.log(`Benchmark aborted by user.\nPartial report: ${path.join(dir, "report.json")}`); process.exitCode = 130; } else if (!config.quiet) console.log(dir);
} catch (error) { if (aborted || controller.signal.aborted) { console.log("Benchmark aborted by user."); process.exitCode = 130; } else { console.error(error instanceof Error ? error.message : "Benchmark failed"); process.exitCode = 1; } }
