import type {
  DirectoryEntry,
  ListDirectoryResult,
  ReadFileResult,
  ToolContext,
  ToolRegistry,
} from "@nyxara/tools";
import { ValidationError } from "./validation.errors.js";
import type { NormalizedValidationConfig } from "./validation-config.js";
import {
  type PackageManager,
  type ResolvedValidationStep,
  type ValidationDiscoveryResult,
  type ValidationKind,
} from "./validation.types.js";

const SCRIPT_CANDIDATES: Readonly<
  Record<ValidationKind, readonly string[]>
> = {
  typecheck: ["typecheck", "type-check", "check-types"],
  lint: ["lint"],
  test: ["test", "test:unit"],
  build: ["build"],
};

const DEFAULT_TIMEOUTS: Readonly<Record<ValidationKind, number>> = {
  typecheck: 120_000,
  lint: 120_000,
  test: 300_000,
  build: 300_000,
};
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

interface PackageMetadata {
  readonly packageManager?: unknown;
  readonly scripts?: unknown;
}

export class ValidationCommandDiscovery {
  constructor(private readonly tools: ToolRegistry) {}

  async discover(
    workspaceRoot: string,
    normalized: NormalizedValidationConfig,
    signal?: AbortSignal,
  ): Promise<ValidationDiscoveryResult> {
    const context: ToolContext = {
      workspaceRoot,
      ...(signal ? { signal } : {}),
    };
    const listing = await this.tools.execute<
      { path: string; depth: number },
      ListDirectoryResult
    >("list_directory", { path: ".", depth: 1 }, context);
    const rootFiles = new Set(
      listing.entries
        .filter((entry) => isRootFile(entry))
        .map((entry) => entry.path),
    );
    const metadata = rootFiles.has("package.json")
      ? await this.readPackageMetadata(context)
      : undefined;
    const packageManager = detectPackageManager(metadata, rootFiles);
    const scripts = normalizeScripts(metadata?.scripts);

    const steps = normalized.order.map((kind) =>
      resolveStep(
        kind,
        normalized.config[kind],
        packageManager,
        scripts,
      ),
    );
    const packageManagerMissing =
      packageManager === null &&
      Object.keys(SCRIPT_CANDIDATES).some((kind) =>
        SCRIPT_CANDIDATES[kind as ValidationKind].some(
          (candidate) => candidate in scripts,
        ),
      );
    return { packageManager, packageManagerMissing, steps };
  }

  private async readPackageMetadata(
    context: ToolContext,
  ): Promise<PackageMetadata> {
    const result = await this.tools.execute<
      { path: string; maxBytes: number },
      ReadFileResult
    >(
      "read_file",
      { path: "package.json", maxBytes: 256 * 1024 },
      context,
    );
    try {
      const parsed: unknown = JSON.parse(result.content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("invalid package metadata");
      }
      return parsed as PackageMetadata;
    } catch {
      throw new ValidationError(
        "validation_error",
        "Workspace package.json is invalid JSON",
      );
    }
  }
}

function isRootFile(entry: DirectoryEntry): boolean {
  return entry.type === "file" && !entry.path.includes("/");
}

export function detectPackageManager(
  metadata: PackageMetadata | undefined,
  rootFiles: ReadonlySet<string>,
): PackageManager | null {
  if (typeof metadata?.packageManager === "string") {
    const match = /^(pnpm|npm|yarn)(?:@|$)/.exec(metadata.packageManager.trim());
    if (match?.[1]) return match[1] as PackageManager;
  }
  if (rootFiles.has("pnpm-lock.yaml")) return "pnpm";
  if (rootFiles.has("yarn.lock")) return "yarn";
  if (rootFiles.has("package-lock.json")) return "npm";
  return null;
}

function normalizeScripts(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function resolveStep(
  kind: ValidationKind,
  configured: NormalizedValidationConfig["config"][ValidationKind],
  packageManager: PackageManager | null,
  scripts: Readonly<Record<string, string>>,
): ResolvedValidationStep {
  const enabled = configured?.enabled ?? true;
  const timeoutMs = configured?.timeoutMs ?? DEFAULT_TIMEOUTS[kind];
  const maxOutputBytes =
    configured?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!enabled) {
    return {
      kind,
      enabled: false,
      required: false,
      source: "missing",
      timeoutMs,
      maxOutputBytes,
    };
  }

  if (configured?.command) {
    return {
      kind,
      enabled: true,
      required: configured.required ?? true,
      source: "explicit",
      command: configured.command as [string, ...string[]],
      timeoutMs,
      maxOutputBytes,
    };
  }

  const script = SCRIPT_CANDIDATES[kind].find((candidate) => candidate in scripts);
  if (script && packageManager) {
    return {
      kind,
      enabled: true,
      required: configured?.required ?? true,
      source: "discovered",
      command: [packageManager, "run", script],
      timeoutMs,
      maxOutputBytes,
    };
  }

  return {
    kind,
    enabled: true,
    required: configured?.required ?? false,
    source: "missing",
    timeoutMs,
    maxOutputBytes,
  };
}

export { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUTS, SCRIPT_CANDIDATES };
