import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultToolRegistry,
  DefaultPermissionEngine,
  LocalExecutionRuntime,
  type CommandResult,
  type ExecutionRuntime,
  type GitDiffResult,
  type GitStatusResult,
} from "../src/index.js";
import {
  createRepositoryFixture,
  createTestWorkspace,
  initializeGitRepository,
  removeTestWorkspace,
} from "./test-workspace.js";

describe("Git inspection tools", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await createRepositoryFixture(workspace);
  });

  afterEach(async () => {
    await removeTestWorkspace(workspace);
  });

  it("normalizes git status and working tree diff", async () => {
    await initializeGitRepository(workspace);
    const changedPath = join(
      workspace,
      "src",
      "notification",
      "notification.service.ts",
    );
    await writeFile(changedPath, "export const changed = true;\n");
    const registry = createDefaultToolRegistry();

    const status = await registry.execute<Record<string, never>, GitStatusResult>(
      "git_status",
      {},
      { workspaceRoot: workspace },
    );
    const diff = await registry.execute<Record<string, never>, GitDiffResult>(
      "git_diff",
      {},
      { workspaceRoot: workspace },
    );

    expect(status).toMatchObject({ isRepository: true, branch: "main" });
    expect(status.files).toContainEqual(
      expect.objectContaining({
        path: "src/notification/notification.service.ts",
        status: "modified",
      }),
    );
    expect(diff.files).toContain("src/notification/notification.service.ts");
    expect(diff.diff).toContain("export const changed = true");
  });

  it("handles a non-git workspace without leaking raw process errors", async () => {
    const registry = createDefaultToolRegistry();

    await expect(
      registry.execute("git_status", {}, { workspaceRoot: workspace }),
    ).resolves.toMatchObject({ isRepository: false, files: [] });
    await expect(
      registry.execute("git_diff", {}, { workspaceRoot: workspace }),
    ).resolves.toMatchObject({ isRepository: false, diff: "" });
  });
});

describe("run_command", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await removeTestWorkspace(workspace);
  });

  it("executes inside the workspace and enforces output limits", async () => {
    const registry = createDefaultToolRegistry({
      permissionEngine: new DefaultPermissionEngine({
        safeCommand: "allow",
        unknownCommand: "allow",
      }),
    });
    const pwd = await registry.execute<Record<string, never>, CommandResult>(
      "run_command",
      { command: "pwd" },
      { workspaceRoot: workspace },
    );
    const output = await registry.execute<Record<string, never>, CommandResult>(
      "run_command",
      {
        command: "printf",
        args: ["x".repeat(10_000)],
        maxOutputBytes: 100,
      },
      { workspaceRoot: workspace },
    );

    expect(pwd.stdout.trim()).toBe(workspace);
    expect(output.stdout).toHaveLength(100);
    expect(output.truncated).toBe(true);
  });

  it("enforces command timeouts", async () => {
    const registry = createDefaultToolRegistry({
      permissionEngine: new DefaultPermissionEngine({ unknownCommand: "allow" }),
    });

    await expect(
      registry.execute(
        "run_command",
        {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
          timeoutMs: 25,
        },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: "command_timeout" });
  });

  it("blocks dangerous commands before the runtime is invoked", async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      aborted: false,
      truncated: false,
    }));
    const runtime: ExecutionRuntime = { run };
    const registry = createDefaultToolRegistry({
      executionRuntime: runtime,
      permissionEngine: new DefaultPermissionEngine({
        safeCommand: "allow",
        unknownCommand: "allow",
      }),
    });

    for (const input of [
      { command: "sudo", args: ["ls"] },
      { command: "rm", args: ["-rf", "/"] },
      { command: "git", args: ["push"] },
    ]) {
      await expect(
        registry.execute("run_command", input, { workspaceRoot: workspace }),
      ).rejects.toMatchObject({ code: "command_blocked" });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("allows exact validation commands but rejects appended shell arguments", async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      aborted: false,
      truncated: false,
    }));
    const registry = createDefaultToolRegistry({ executionRuntime: { run } });

    for (const input of [
      { command: "pnpm", args: ["run", "typecheck"] },
      { command: "npm", args: ["test"] },
      { command: "yarn", args: ["lint"] },
      { command: "npx", args: ["tsc", "--noEmit"] },
    ]) {
      await expect(
        registry.execute("run_command", input, { workspaceRoot: workspace }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    await expect(
      registry.execute(
        "run_command",
        { command: "npm", args: ["run", "test", ";", "touch", "owned"] },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: "permission_required" });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("keeps LocalExecutionRuntime as the local V1 implementation", () => {
    expect(new LocalExecutionRuntime()).toBeDefined();
  });
});
