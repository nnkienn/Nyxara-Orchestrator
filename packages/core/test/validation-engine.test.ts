import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createDefaultToolRegistry,
  DefaultPermissionEngine,
  LocalExecutionRuntime,
  type CommandRequest,
  type CommandResult,
  type ExecutionRuntime,
} from "@nyxara/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NyxaraOrchestrator,
  type ValidationConfig,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("ValidationEngine", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-validation-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("discovers and runs required checks in cheap-first order", async () => {
    await createRepository(passScripts());
    const nyxara = new NyxaraOrchestrator();
    const emitted: string[] = [];
    nyxara.events.on("validation.started", () => emitted.push("started"));
    nyxara.events.on("validation.step_started", ({ kind }) =>
      emitted.push(`${kind}.started`),
    );
    nyxara.events.on("validation.step_passed", ({ kind }) =>
      emitted.push(`${kind}.passed`),
    );
    nyxara.events.on("validation.completed", () => emitted.push("completed"));

    const result = await nyxara.validate({
      workspaceRoot: workspace,
      planId: "plan-1",
      taskId: "T1",
    });

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => [step.kind, step.status])).toEqual([
      ["typecheck", "passed"],
      ["lint", "passed"],
      ["test", "passed"],
      ["build", "passed"],
    ]);
    expect(result).toMatchObject({
      packageManager: "npm",
      planId: "plan-1",
      taskId: "T1",
    });
    expect(nyxara.getLatestValidationResult()).toEqual(result);
    expect(emitted).toEqual([
      "started",
      "typecheck.started",
      "typecheck.passed",
      "lint.started",
      "lint.passed",
      "test.started",
      "test.passed",
      "build.started",
      "build.passed",
      "completed",
    ]);
  });

  it("fails fast after a non-zero required command", async () => {
    await createRepository({
      ...passScripts(),
      typecheck: nodeScript("process.exit(2)"),
    });
    const nyxara = new NyxaraOrchestrator();
    const failed = vi.fn();
    const stepFailed = vi.fn();
    nyxara.events.on("validation.failed", failed);
    nyxara.events.on("validation.step_failed", stepFailed);

    const result = await nyxara.validate({ workspaceRoot: workspace });

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(result.steps[0]?.exitCode).not.toBe(0);
    expect(stepFailed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "typecheck", status: "failed" }),
    );
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ failedKinds: ["typecheck"] }),
    );
  });

  it("continues after failures when failFast is false", async () => {
    await createRepository({
      ...passScripts(),
      lint: nodeScript("process.exit(3)"),
    });

    const result = await new NyxaraOrchestrator().validate({
      workspaceRoot: workspace,
      config: { failFast: false },
    });

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "passed",
      "failed",
      "passed",
      "passed",
    ]);
  });

  it("normalizes timeout and bounds subprocess output", async () => {
    await createRepository(passScripts());
    const timedRuntime = new ConditionalRuntime(async (request) => {
      if (request.command === "npm") {
        return commandResult({ timedOut: true, durationMs: 11 });
      }
      return new LocalExecutionRuntime().run(request);
    });
    const timedNyxara = new NyxaraOrchestrator({
      toolRegistry: createDefaultToolRegistry({ executionRuntime: timedRuntime }),
    });
    const timedOutEvent = vi.fn();
    timedNyxara.events.on("validation.step_timed_out", timedOutEvent);

    const timed = await timedNyxara.validate({ workspaceRoot: workspace });

    expect(timed.steps[0]).toMatchObject({
      kind: "typecheck",
      status: "timed_out",
      errorCode: "validation_timeout",
    });
    expect(timedOutEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "typecheck", status: "timed_out" }),
    );

    let receivedOutputLimit: number | undefined;
    const boundedRuntime = new ConditionalRuntime(async (request) => {
      if (request.command === "npm") {
        if (request.args?.includes("typecheck")) {
          receivedOutputLimit = request.maxOutputBytes;
          return commandResult({ stdout: "x".repeat(256), truncated: true });
        }
        return commandResult();
      }
      return new LocalExecutionRuntime().run(request);
    });
    const bounded = await new NyxaraOrchestrator({
      toolRegistry: createDefaultToolRegistry({ executionRuntime: boundedRuntime }),
    }).validate({
      workspaceRoot: workspace,
      config: { typecheck: { maxOutputBytes: 256 } },
    });

    expect(receivedOutputLimit).toBe(256);
    expect(bounded.steps[0]).toMatchObject({ status: "passed", truncated: true });
    expect(
      (bounded.steps[0]?.stdout?.length ?? 0) +
        (bounded.steps[0]?.stderr?.length ?? 0),
    ).toBeLessThanOrEqual(256);
  });

  it("returns controlled results for missing commands and no discovery", async () => {
    await createRepository(passScripts());
    const registry = createDefaultToolRegistry({
      permissionEngine: new DefaultPermissionEngine({ unknownCommand: "allow" }),
    });
    const missing = await new NyxaraOrchestrator({ toolRegistry: registry }).validate({
      workspaceRoot: workspace,
      config: {
        typecheck: { command: ["nyxara-missing-validation-binary"] },
        lint: { enabled: false },
        test: { enabled: false },
        build: { enabled: false },
      },
    });

    expect(missing).toMatchObject({
      status: "failed",
      errorCode: "validation_process_error",
    });
    expect(missing.steps[0]).toMatchObject({
      status: "errored",
      errorCode: "validation_process_error",
    });

    const emptyWorkspace = await mkdtemp(join(tmpdir(), "nyxara-validation-empty-"));
    try {
      const empty = await new NyxaraOrchestrator().validate({
        workspaceRoot: emptyWorkspace,
      });
      expect(empty).toMatchObject({
        status: "failed",
        errorCode: "no_validation_commands",
      });
      expect(empty.steps.every((step) => step.status === "skipped")).toBe(true);

      await writeFile(
        join(emptyWorkspace, "package.json"),
        JSON.stringify({ scripts: { test: nodeScript("process.exit(0)") } }),
      );
      const managerMissing = await new NyxaraOrchestrator().validate({
        workspaceRoot: emptyWorkspace,
      });
      expect(managerMissing).toMatchObject({
        status: "failed",
        errorCode: "package_manager_not_found",
      });
    } finally {
      await rm(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it("treats undiscovered optional steps as skipped without failing", async () => {
    await createRepository({ test: nodeScript("process.exit(0)") });

    const result = await new NyxaraOrchestrator().validate({
      workspaceRoot: workspace,
    });

    expect(result.status).toBe("passed");
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "lint", status: "skipped", required: false }),
        expect.objectContaining({ kind: "test", status: "passed", required: true }),
      ]),
    );
  });

  it("fails when an explicitly required validation cannot be discovered", async () => {
    await createRepository({ test: nodeScript("process.exit(0)") });

    const nyxara = new NyxaraOrchestrator();
    const skipped = vi.fn();
    nyxara.events.on("validation.step_skipped", skipped);
    const result = await nyxara.validate({
      workspaceRoot: workspace,
      config: { lint: { required: true } },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "validation_command_not_found",
    });
    expect(result.steps[1]).toMatchObject({
      kind: "lint",
      status: "skipped",
      required: true,
      errorCode: "validation_command_not_found",
    });
    expect(skipped).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lint",
        errorCode: "validation_command_not_found",
      }),
    );
  });

  it("blocks dangerous commands and shell-injection arguments before execution", async () => {
    await createRepository(passScripts());
    const marker = join(workspace, "owned");
    const dangerousConfigs: ValidationConfig[] = [
      {
        typecheck: { command: ["sudo", "true"] },
        lint: { enabled: false },
        test: { enabled: false },
        build: { enabled: false },
      },
      {
        typecheck: { command: ["git", "push"] },
        lint: { enabled: false },
        test: { enabled: false },
        build: { enabled: false },
      },
      {
        typecheck: { command: ["npm", "run", "test", ";", "touch", marker] },
        lint: { enabled: false },
        test: { enabled: false },
        build: { enabled: false },
      },
    ];

    for (const config of dangerousConfigs) {
      const result = await new NyxaraOrchestrator().validate({
        workspaceRoot: workspace,
        config,
      });
      expect(result.steps[0]).toMatchObject({
        status: "errored",
        errorCode: "validation_command_blocked",
      });
    }
    await expect(access(marker)).rejects.toThrow();
  });

  it("detects tracked source mutation but accepts changes present before validation", async () => {
    await createRepository({
      test: nodeScript(
        "require('node:fs').writeFileSync('tracked.ts', 'changed\\n')",
      ),
    }, true, "original\n");

    const mutated = await new NyxaraOrchestrator().validate({
      workspaceRoot: workspace,
    });

    expect(mutated).toMatchObject({
      status: "failed",
      errorCode: "validation_workspace_changed",
    });
    expect(mutated.steps[2]).toMatchObject({
      kind: "test",
      status: "errored",
      changedTrackedFiles: ["tracked.ts"],
    });

    await execFileAsync("git", ["checkout", "--", "tracked.ts"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "tracked.ts"), "already changed\n");
    await writePackage({ test: nodeScript("process.exit(0)") });
    const existingChange = await new NyxaraOrchestrator().validate({
      workspaceRoot: workspace,
    });

    expect(existingChange.status).toBe("passed");
  });

  async function createRepository(
    scripts: Readonly<Record<string, string>>,
    initialize = true,
    trackedContent?: string,
  ): Promise<void> {
    await writePackage(scripts);
    await writeFile(join(workspace, "package-lock.json"), "{}\n");
    if (trackedContent !== undefined) {
      await writeFile(join(workspace, "tracked.ts"), trackedContent);
    }
    if (initialize) {
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
  }

  async function writePackage(scripts: Readonly<Record<string, string>>): Promise<void> {
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({ private: true, scripts }, null, 2)}\n`,
    );
  }
});

function passScripts(): Record<string, string> {
  return {
    typecheck: nodeScript("process.exit(0)"),
    lint: nodeScript("process.exit(0)"),
    test: nodeScript("process.exit(0)"),
    build: nodeScript("process.exit(0)"),
  };
}

function nodeScript(source: string): string {
  return `node -e ${JSON.stringify(source)}`;
}

class ConditionalRuntime implements ExecutionRuntime {
  constructor(
    private readonly handler: (request: CommandRequest) => Promise<CommandResult>,
  ) {}

  run(request: CommandRequest): Promise<CommandResult> {
    return this.handler(request);
  }
}

function commandResult(
  override: Partial<CommandResult> = {},
): CommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    ...override,
  };
}
