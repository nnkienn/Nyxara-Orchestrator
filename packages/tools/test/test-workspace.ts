import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTestWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nyxara-tools-"));
}

export async function removeTestWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}

export async function createRepositoryFixture(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src", "notification"), { recursive: true });
  await mkdir(join(workspace, "src", "users"), { recursive: true });
  await mkdir(join(workspace, "node_modules", "ignored"), { recursive: true });
  await mkdir(join(workspace, "dist"), { recursive: true });
  await writeFile(
    join(workspace, "src", "notification", "notification.service.ts"),
    "export function getNotifications() {\n  return [];\n}\n",
  );
  await writeFile(
    join(workspace, "src", "notification", "notification.controller.ts"),
    "import { getNotifications } from './notification.service.js';\n",
  );
  await writeFile(
    join(workspace, "src", "users", "user.service.ts"),
    "export function getUser() {}\n",
  );
  await writeFile(join(workspace, "node_modules", "ignored", "match.ts"), "secret");
  await writeFile(join(workspace, "dist", "notification.js"), "generated");
}

export async function initializeGitRepository(workspace: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@nyxara.local"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.name", "Nyxara Test"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
}

