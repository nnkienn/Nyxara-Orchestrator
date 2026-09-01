import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface BenchmarkFixture { root: string; cleanup(): Promise<void>; }

export async function createBenchmarkFixture(keep = false): Promise<BenchmarkFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyxara-real-benchmark-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "nyxara-benchmark-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  await fs.writeFile(path.join(root, "index.js"), "export const identity = value => value;\n");
  await fs.writeFile(path.join(root, "index.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { identity } from './index.js';\ntest('identity', () => assert.equal(identity(1), 1));\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "benchmark@nyxara.local"], { cwd: root });
  await exec("git", ["config", "user.name", "Nyxara Benchmark"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return { root, cleanup: async () => { if (!keep) await fs.rm(root, { recursive: true, force: true }); } };
}
