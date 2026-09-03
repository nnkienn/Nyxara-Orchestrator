import os from "node:os";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { BENCHMARK_RUNNER_VERSION } from "./scenario.types.js";

function command(name: string, args: string[] = []): string | null { try { return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; } }

export function detectEnvironment(): Record<string, unknown> {
  const commit = command("git", ["rev-parse", "HEAD"]); const status = command("git", ["status", "--porcelain"]);
  return { os: process.platform, osVersion: os.release(), architecture: process.arch, cpuModel: os.cpus()[0]?.model ?? null, logicalCpus: os.cpus().length, totalSystemRamMb: Math.round(os.totalmem() / 1048576), freeSystemRamMb: Math.round(os.freemem() / 1048576), nodeVersion: process.version, packageManagers: { npm: command("npm", ["--version"]), pnpm: command("pnpm", ["--version"]), yarn: command("yarn", ["--version"]) }, gitVersion: command("git", ["--version"]), vscodeVersion: command("code", ["--version"]), gitCommitSha: commit, gitWorktree: status ? "dirty" : "clean", benchmarkRunnerVersion: BENCHMARK_RUNNER_VERSION, timestamp: new Date().toISOString() };
}
