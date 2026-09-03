import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface BenchmarkFixture {
  root: string;
  contextFiles: number;
  contextBytes: number;
  inspect(): Promise<{ fixtureCreated: true; fixtureChanged: boolean; changedFileCount: number; validationPassed: boolean }>;
  cleanup(): Promise<void>;
}

export async function createBenchmarkFixture(keep = false): Promise<BenchmarkFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyxara-real-benchmark-"));
  const files = new Map([
    ["package.json", JSON.stringify({ name: "nyxara-benchmark-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n"],
    ["index.js", "export const identity = value => value;\n"],
    ["index.test.js", "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { identity } from './index.js';\ntest('identity', () => assert.equal(identity(1), 1));\n"],
  ]);
  for (const [name, content] of files) await fs.writeFile(path.join(root, name), content);
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "benchmark@nyxara.local"], { cwd: root });
  await exec("git", ["config", "user.name", "Nyxara Benchmark"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return {
    root,
    contextFiles: files.size,
    contextBytes: [...files.values()].reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0),
    inspect: async () => {
      const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: root });
      const changedFileCount = stdout.split("\n").filter(Boolean).length;
      let validationPassed = false;
      try { await exec(process.execPath, ["--test"], { cwd: root }); validationPassed = true; } catch { validationPassed = false; }
      return { fixtureCreated: true, fixtureChanged: changedFileCount > 0, changedFileCount, validationPassed };
    },
    cleanup: async () => { if (!keep) await fs.rm(root, { recursive: true, force: true }); },
  };
}
