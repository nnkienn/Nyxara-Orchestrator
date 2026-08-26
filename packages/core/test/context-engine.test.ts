import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NyxaraOrchestrator } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("ContextEngine", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-context-"));
    await mkdir(join(workspace, "src", "notification"), { recursive: true });
    await mkdir(join(workspace, "src", "users"), { recursive: true });
    await writeFile(
      join(workspace, "src", "notification", "notification.controller.ts"),
      "export const notificationController = 'pagination';\n",
    );
    await writeFile(
      join(workspace, "src", "notification", "notification.service.ts"),
      "export function listNotifications() { return []; }\n",
    );
    await writeFile(
      join(workspace, "src", "notification", "notification.dto.ts"),
      "export interface NotificationPage { page: number }\n",
    );
    await writeFile(
      join(workspace, "src", "users", "user.service.ts"),
      "export function listUsers() { return []; }\n",
    );
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@nyxara.local"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["config", "user.name", "Nyxara Test"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
    await writeFile(
      join(workspace, "src", "notification", "notification.service.ts"),
      "export function listNotifications(page: number) { return [page]; }\n",
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("selects relevant files, includes Git metadata, and estimates tokens", async () => {
    const nyxara = new NyxaraOrchestrator();

    const context = await nyxara.inspectRepository({
      workspaceRoot: workspace,
      prompt: "Add pagination to the notification API",
    });

    expect(context.files.map((file) => file.path)).toEqual([
      "src/notification/notification.service.ts",
      "src/notification/notification.controller.ts",
      "src/notification/notification.dto.ts",
    ]);
    expect(context.files[0]?.reason).toContain('path matched "notification"');
    expect(context.git.status.files).toContainEqual(
      expect.objectContaining({
        path: "src/notification/notification.service.ts",
        status: "modified",
      }),
    );
    expect(context.estimatedTokens).toBeGreaterThan(0);
    expect(context.totalBytes).toBeGreaterThan(0);
  });

  it("respects maxFiles and maxBytes and reports truncation", async () => {
    const nyxara = new NyxaraOrchestrator();
    const onTruncated = vi.fn();
    nyxara.events.on("context.truncated", onTruncated);

    const context = await nyxara.inspectRepository({
      workspaceRoot: workspace,
      prompt: "notification",
      budget: { maxFiles: 1, maxBytes: 20, maxBytesPerFile: 20 },
    });

    expect(context.files).toHaveLength(1);
    expect(context.totalBytes).toBeLessThanOrEqual(20);
    expect(context.truncated).toBe(true);
    expect(context.files[0]?.truncated).toBe(true);
    expect(onTruncated).toHaveBeenCalledWith(
      expect.objectContaining({ fileCount: 1, totalBytes: context.totalBytes }),
    );
  });

  it("emits metadata-only tool and context events", async () => {
    const nyxara = new NyxaraOrchestrator();
    const events: unknown[] = [];
    nyxara.events.on("tool.completed", (event) => events.push(event));
    nyxara.events.on("context.completed", (event) => events.push(event));

    await nyxara.inspectRepository({
      workspaceRoot: workspace,
      prompt: "notification",
      budget: { maxFiles: 1 },
    });

    const serialized = JSON.stringify(events);
    expect(serialized).toContain("read_file");
    expect(serialized).not.toContain("listNotifications");
  });
});

