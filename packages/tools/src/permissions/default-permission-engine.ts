import { basename, isAbsolute, relative, resolve } from "node:path";
import type { CommandRequest } from "../execution/execution.types.js";
import type {
  DefaultPermissionPolicy,
  PermissionDecision,
  PermissionEngine,
  PermissionRequest,
} from "./permission.types.js";

type CommandSafety = "safe" | "validation" | "unknown" | "dangerous";

const SAFE_COMMANDS = new Set(["pwd", "ls", "rg"]);
const SHELL_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
]);
const PRODUCTION_COMMANDS = new Set([
  "kubectl",
  "helm",
  "terraform",
  "vercel",
  "flyctl",
]);
const VALIDATION_SCRIPTS = new Set([
  "typecheck",
  "type-check",
  "check-types",
  "lint",
  "test",
  "test:unit",
  "build",
]);

export class DefaultPermissionEngine implements PermissionEngine {
  private readonly safeCommandDecision: PermissionDecision;
  private readonly validationCommandDecision: PermissionDecision;
  private readonly unknownCommandDecision: PermissionDecision;
  private readonly createWorkspaceFileDecision: PermissionDecision;
  private readonly modifyWorkspaceFileDecision: PermissionDecision;
  private readonly largeFileWriteDecision: PermissionDecision;
  private readonly environmentFileWriteDecision: PermissionDecision;
  private readonly credentialFileWriteDecision: PermissionDecision;

  constructor(policy: DefaultPermissionPolicy = {}) {
    this.safeCommandDecision = policy.safeCommand ?? "ask";
    this.validationCommandDecision = policy.validationCommand ?? "allow";
    this.unknownCommandDecision = policy.unknownCommand ?? "ask";
    this.createWorkspaceFileDecision = policy.createWorkspaceFile ?? "allow";
    this.modifyWorkspaceFileDecision = policy.modifyWorkspaceFile ?? "allow";
    this.largeFileWriteDecision = policy.largeFileWrite ?? "ask";
    this.environmentFileWriteDecision = policy.environmentFileWrite ?? "ask";
    this.credentialFileWriteDecision = policy.credentialFileWrite ?? "deny";
  }

  async evaluate(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.resource && this.isOutsideWorkspace(request)) {
      return "deny";
    }

    switch (request.capability) {
      case "read_workspace_file":
      case "list_workspace_directory":
      case "search_workspace":
      case "git_status":
      case "git_diff":
        return "allow";
      case "run_command":
        return this.commandDecision(request.command);
      case "create_workspace_file":
      case "modify_workspace_file":
        return this.writeDecision(request);
      case "delete_workspace_file":
      case "outside_workspace":
      case "sudo":
      case "git_push":
      case "production_deploy":
        return "deny";
    }
  }

  private writeDecision(request: PermissionRequest): PermissionDecision {
    if (request.write?.sensitivity === "credential") {
      return this.credentialFileWriteDecision;
    }
    if (request.write?.sensitivity === "environment") {
      return this.environmentFileWriteDecision;
    }
    if (request.write?.large) {
      return this.largeFileWriteDecision;
    }
    return request.capability === "create_workspace_file"
      ? this.createWorkspaceFileDecision
      : this.modifyWorkspaceFileDecision;
  }

  private commandDecision(command: CommandRequest | undefined): PermissionDecision {
    if (!command) {
      return "deny";
    }

    const safety = classifyCommand(command);
    if (safety === "dangerous") {
      return "deny";
    }
    if (safety === "validation") {
      return this.validationCommandDecision;
    }

    return safety === "safe"
      ? this.safeCommandDecision
      : this.unknownCommandDecision;
  }

  private isOutsideWorkspace(request: PermissionRequest): boolean {
    const resource = request.resource!;
    const workspace = resolve(request.workspaceRoot);
    const candidate = isAbsolute(resource)
      ? resolve(resource)
      : resolve(workspace, resource);
    const pathFromWorkspace = relative(workspace, candidate);

    return (
      pathFromWorkspace === ".." ||
      pathFromWorkspace.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(pathFromWorkspace)
    );
  }
}

export function classifyCommand(request: CommandRequest): CommandSafety {
  const command = basename(request.command).toLocaleLowerCase();
  const args = request.args ?? [];

  if (
    command === "sudo" ||
    command === "doas" ||
    command === "rm" ||
    SHELL_COMMANDS.has(command) ||
    PRODUCTION_COMMANDS.has(command)
  ) {
    return "dangerous";
  }

  if (command === "git") {
    const subcommand = args.find((argument) => !argument.startsWith("-"));
    if (subcommand === "push" || subcommand === "reset" || subcommand === "clean") {
      return "dangerous";
    }

    return ["status", "diff", "branch", "rev-parse"].includes(subcommand ?? "")
      ? "safe"
      : "unknown";
  }

  if (isValidationCommand(command, args)) {
    return "validation";
  }

  if (command === "node" && args.length === 1 && args[0] === "--version") {
    return "safe";
  }

  return SAFE_COMMANDS.has(command) ? "safe" : "unknown";
}

function isValidationCommand(
  command: string,
  args: readonly string[],
): boolean {
  if (
    command === "pnpm" &&
    args.length === 3 &&
    args[0] === "exec" &&
    args[1] === "tsc" &&
    args[2] === "--noEmit"
  ) {
    return true;
  }

  if (["pnpm", "npm", "yarn"].includes(command)) {
    const script = args[0] === "run" ? args[1] : args[0];
    return (
      typeof script === "string" &&
      VALIDATION_SCRIPTS.has(script) &&
      (args.length === 1 || (args[0] === "run" && args.length === 2))
    );
  }

  if (command === "npx") {
    return (
      (args.length === 2 && args[0] === "tsc" && args[1] === "--noEmit") ||
      (args.length === 3 &&
        args[0] === "--no-install" &&
        args[1] === "tsc" &&
        args[2] === "--noEmit")
    );
  }

  return false;
}
