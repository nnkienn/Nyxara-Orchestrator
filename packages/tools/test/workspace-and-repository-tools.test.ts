import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  DefaultPermissionEngine,
  WorkspacePathResolver,
  type ListDirectoryResult,
  type ReadFileResult,
  type SearchCodeResult,
  type SearchFilesResult,
} from "../src/index.js";
import {
  createRepositoryFixture,
  createTestWorkspace,
  removeTestWorkspace,
} from "./test-workspace.js";

describe("workspace boundary and repository tools", () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    outside = await createTestWorkspace();
    await createRepositoryFixture(workspace);
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(join(outside, "secret.txt"), join(workspace, "secret-link"));
  });

  afterEach(async () => {
    await removeTestWorkspace(workspace);
    await removeTestWorkspace(outside);
  });

  it("allows valid paths and rejects traversal, absolute outside paths, and symlink escapes", async () => {
    const resolver = await WorkspacePathResolver.create(workspace);

    await expect(
      resolver.resolve("src/notification/notification.service.ts"),
    ).resolves.toMatchObject({
      relativePath: "src/notification/notification.service.ts",
    });
    await expect(resolver.resolve("../../secret")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    await expect(resolver.resolve("/etc/passwd")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    await expect(resolver.resolve("secret-link")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
  });

  it("lists directories while skipping generated and dependency directories", async () => {
    const registry = createDefaultToolRegistry();
    const result = await registry.execute<Record<string, never>, ListDirectoryResult>(
      "list_directory",
      { depth: 4 },
      { workspaceRoot: workspace },
    );

    expect(result.entries.map((entry) => entry.path)).toContain(
      "src/notification/notification.service.ts",
    );
    expect(result.entries.map((entry) => entry.path)).not.toContain(
      "node_modules/ignored/match.ts",
    );
    expect(result.entries.map((entry) => entry.path)).not.toContain(
      "dist/notification.js",
    );
  });

  it("searches paths and code without generated directories", async () => {
    const registry = createDefaultToolRegistry();
    const files = await registry.execute<
      { query: string },
      SearchFilesResult
    >("search_files", { query: "notification" }, { workspaceRoot: workspace });
    const code = await registry.execute<{ query: string }, SearchCodeResult>(
      "search_code",
      { query: "getNotifications" },
      { workspaceRoot: workspace },
    );

    expect(files.matches).toEqual([
      "src/notification/notification.controller.ts",
      "src/notification/notification.service.ts",
    ]);
    expect(code.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/notification/notification.service.ts",
          line: 1,
        }),
      ]),
    );
    expect(code.matches.some((match) => match.path.startsWith("dist/"))).toBe(
      false,
    );
  });

  it("reads files with line metadata and bounded truncation", async () => {
    const registry = createDefaultToolRegistry();
    await mkdir(join(workspace, "large"), { recursive: true });
    await writeFile(join(workspace, "large", "large.txt"), "abcdefghij\nsecond\n");

    const result = await registry.execute<
      { path: string; maxBytes: number },
      ReadFileResult
    >(
      "read_file",
      { path: "large/large.txt", maxBytes: 5 },
      { workspaceRoot: workspace },
    );

    expect(result).toMatchObject({
      path: "large/large.txt",
      content: "abcde",
      lineCount: 2,
      truncated: true,
    });
  });

  it("denies an outside path before a filesystem tool executes", async () => {
    const registry = createDefaultToolRegistry();

    await expect(
      registry.execute("read_file", { path: "/etc/passwd" }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: "permission_error" });
  });
});

describe("DefaultPermissionEngine", () => {
  it("allows reads and denies outside resources and dangerous commands", async () => {
    const engine = new DefaultPermissionEngine({ safeCommand: "allow" });
    const workspace = "/tmp/nyxara-workspace";

    await expect(
      engine.evaluate({
        capability: "read_workspace_file",
        workspaceRoot: workspace,
        resource: "src/index.ts",
      }),
    ).resolves.toBe("allow");
    await expect(
      engine.evaluate({
        capability: "read_workspace_file",
        workspaceRoot: workspace,
        resource: "/etc/passwd",
      }),
    ).resolves.toBe("deny");

    for (const [command, args] of [
      ["sudo", ["ls"]],
      ["rm", ["-rf", "/"]],
      ["git", ["push"]],
    ] as const) {
      await expect(
        engine.evaluate({
          capability: "run_command",
          workspaceRoot: workspace,
          command: { command, args, cwd: workspace },
        }),
      ).resolves.toBe("deny");
    }
  });
});

