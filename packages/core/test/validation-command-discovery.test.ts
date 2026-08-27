import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultToolRegistry } from "@nyxara/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  normalizeValidationConfig,
  ValidationCommandDiscovery,
} from "../src/index.js";

describe("Validation command discovery", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-validation-discovery-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("detects package managers from packageManager and lockfile evidence", () => {
    expect(
      detectPackageManager(
        { packageManager: "pnpm@10.15.0" },
        new Set(["package-lock.json"]),
      ),
    ).toBe("pnpm");
    expect(detectPackageManager(undefined, new Set(["pnpm-lock.yaml"]))).toBe(
      "pnpm",
    );
    expect(detectPackageManager(undefined, new Set(["yarn.lock"]))).toBe(
      "yarn",
    );
    expect(
      detectPackageManager(undefined, new Set(["package-lock.json"])),
    ).toBe("npm");
  });

  it("maps only known package scripts in deterministic order", async () => {
    await writePackage({
      packageManager: "pnpm@10.15.0",
      scripts: {
        "check-types": "tsc --noEmit",
        lint: "eslint .",
        "test:unit": "vitest run",
        build: "tsc",
        deploy: "forbidden",
      },
    });

    const discovered = await discovery();

    expect(discovered.steps.map((step) => [step.kind, step.command])).toEqual([
      ["typecheck", ["pnpm", "run", "check-types"]],
      ["lint", ["pnpm", "run", "lint"]],
      ["test", ["pnpm", "run", "test:unit"]],
      ["build", ["pnpm", "run", "build"]],
    ]);
    expect(discovered.steps.every((step) => step.required)).toBe(true);
  });

  it("lets explicit configuration override discovery and marks missing steps", async () => {
    await writePackage({
      packageManager: "npm@11.0.0",
      scripts: { test: "vitest run" },
    });

    const discovered = await discovery({
      typecheck: {
        command: ["npx", "--no-install", "tsc", "--noEmit"],
        timeoutMs: 42_000,
      },
      test: { enabled: false },
    });

    expect(discovered.steps[0]).toMatchObject({
      kind: "typecheck",
      command: ["npx", "--no-install", "tsc", "--noEmit"],
      source: "explicit",
      required: true,
      timeoutMs: 42_000,
    });
    expect(discovered.steps[1]).toMatchObject({
      kind: "lint",
      source: "missing",
      required: false,
    });
    expect(discovered.steps[2]).toMatchObject({
      kind: "test",
      enabled: false,
      required: false,
    });
  });

  it("reports package-manager evidence missing when known scripts exist", async () => {
    await writePackage({ scripts: { typecheck: "tsc --noEmit" } });

    const discovered = await discovery();

    expect(discovered.packageManager).toBeNull();
    expect(discovered.packageManagerMissing).toBe(true);
    expect(discovered.steps.every((step) => !step.command)).toBe(true);
  });

  it("rejects executable paths and invalid validation order", () => {
    expect(() =>
      normalizeValidationConfig({
        test: { command: ["../outside/runner"] },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_validation_config" }));
    expect(() =>
      normalizeValidationConfig({
        test: { command: ["/tmp/outside-runner"] },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_validation_config" }));
    expect(() =>
      normalizeValidationConfig({ order: ["test", "test", "lint", "build"] }),
    ).toThrowError(expect.objectContaining({ code: "invalid_validation_config" }));
  });

  async function discovery(config = {}) {
    return new ValidationCommandDiscovery(
      createDefaultToolRegistry(),
    ).discover(workspace, normalizeValidationConfig(config));
  }

  async function writePackage(metadata: object): Promise<void> {
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }
});
