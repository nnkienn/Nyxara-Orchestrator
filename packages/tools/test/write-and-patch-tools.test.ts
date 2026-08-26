import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  type ApplyPatchResult,
  type WriteFileResult,
} from "../src/index.js";
import {
  createRepositoryFixture,
  createTestWorkspace,
  removeTestWorkspace,
} from "./test-workspace.js";

describe("write_file and apply_patch", () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    outside = await createTestWorkspace();
    await createRepositoryFixture(workspace);
    await writeFile(join(outside, "secret.ts"), "export const secret = true;\n");
    await symlink(join(outside, "secret.ts"), join(workspace, "escape.ts"));
  });

  afterEach(async () => {
    await removeTestWorkspace(workspace);
    await removeTestWorkspace(outside);
  });

  it("creates and modifies normal files inside the workspace", async () => {
    const registry = createDefaultToolRegistry();
    const created = await registry.execute<
      { path: string; content: string },
      WriteFileResult
    >(
      "write_file",
      { path: "src/new-file.ts", content: "export const created = true;\n" },
      { workspaceRoot: workspace },
    );
    const modified = await registry.execute<
      { path: string; content: string },
      WriteFileResult
    >(
      "write_file",
      { path: "src/new-file.ts", content: "export const created = false;\n" },
      { workspaceRoot: workspace },
    );

    expect(created).toMatchObject({ path: "src/new-file.ts", created: true });
    expect(modified).toMatchObject({ path: "src/new-file.ts", created: false });
    await expect(readFile(join(workspace, "src/new-file.ts"), "utf8")).resolves.toBe(
      "export const created = false;\n",
    );
  });

  it.each([
    ["../../outside.ts"],
    ["/etc/nyxara-outside.ts"],
    ["escape.ts"],
  ])("rejects unsafe write target %s", async (path) => {
    const registry = createDefaultToolRegistry();
    await expect(
      registry.execute(
        "write_file",
        { path, content: "unsafe" },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: "path_outside_workspace" });
  });

  it("requires permission for large and environment writes and denies keys", async () => {
    const registry = createDefaultToolRegistry();

    await expect(
      registry.execute(
        "write_file",
        { path: "src/large.ts", content: "x".repeat(65 * 1024) },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: "permission_required" });
    await expect(
      registry.execute(
        "write_file",
        { path: ".env", content: "TOKEN=secret" },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: "permission_required" });
    await expect(
      registry.execute(
        "write_file",
        { path: "private.pem", content: "secret" },
        { workspaceRoot: workspace },
      ),
    ).rejects.toMatchObject({ code: "write_permission_denied" });
  });

  it("applies a validated unified patch and reports changed paths", async () => {
    const registry = createDefaultToolRegistry();
    const patch = [
      "diff --git a/src/notification/notification.service.ts b/src/notification/notification.service.ts",
      "--- a/src/notification/notification.service.ts",
      "+++ b/src/notification/notification.service.ts",
      "@@ -1,3 +1,3 @@",
      " export function getNotifications() {",
      "-  return [];",
      "+  return [{ page: 1 }];",
      " }",
      "",
    ].join("\n");

    const result = await registry.execute<
      { patch: string },
      ApplyPatchResult
    >("apply_patch", { patch }, { workspaceRoot: workspace });

    expect(result).toEqual({
      applied: true,
      filesChanged: ["src/notification/notification.service.ts"],
      additions: 1,
      deletions: 1,
    });
    await expect(
      readFile(
        join(workspace, "src/notification/notification.service.ts"),
        "utf8",
      ),
    ).resolves.toContain("return [{ page: 1 }]");
  });

  it("fails an invalid patch without partially changing the file", async () => {
    const registry = createDefaultToolRegistry();
    const path = join(workspace, "src/notification/notification.service.ts");
    const before = await readFile(path, "utf8");
    const patch = [
      "diff --git a/src/notification/notification.service.ts b/src/notification/notification.service.ts",
      "--- a/src/notification/notification.service.ts",
      "+++ b/src/notification/notification.service.ts",
      "@@ -1 +1 @@",
      "-content that does not exist",
      "+replacement",
      "",
    ].join("\n");

    await expect(
      registry.execute("apply_patch", { patch }, { workspaceRoot: workspace }),
    ).rejects.toMatchObject({ code: "patch_failed" });
    await expect(readFile(path, "utf8")).resolves.toBe(before);
  });

  it("rejects patch traversal and symlink escape before mutation", async () => {
    const registry = createDefaultToolRegistry();
    for (const path of ["../../outside.ts", "/etc/outside.ts", "escape.ts"]) {
      const patch = [
        `--- ${path}`,
        `+++ ${path}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      await expect(
        registry.execute("apply_patch", { patch }, { workspaceRoot: workspace }),
      ).rejects.toMatchObject({ code: "path_outside_workspace" });
    }
  });
});
