import { basename, isAbsolute, relative, resolve } from "node:path";
import type { CommandRequest } from "../execution/execution.types.js";
import type {
  DefaultPermissionPolicy,
  PermissionDecision,
  PermissionEngine,
  PermissionRequest,
} from "./permission.types.js";

type CommandSafety = "safe" | "unknown" | "dangerous";

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

export class DefaultPermissionEngine implements PermissionEngine {
  private readonly safeCommandDecision: PermissionDecision;
  private readonly unknownCommandDecision: PermissionDecision;
  private readonly writeWorkspaceFileDecision: PermissionDecision;

  constructor(policy: DefaultPermissionPolicy = {}) {
    this.safeCommandDecision = policy.safeCommand ?? "ask";
    this.unknownCommandDecision = policy.unknownCommand ?? "ask";
    this.writeWorkspaceFileDecision = policy.writeWorkspaceFile ?? "ask";
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
      case "write_workspace_file":
        return this.writeWorkspaceFileDecision;
      case "delete_workspace_file":
      case "outside_workspace":
      case "sudo":
      case "git_push":
      case "production_deploy":
        return "deny";
    }
  }

  private commandDecision(command: CommandRequest | undefined): PermissionDecision {
    if (!command) {
      return "deny";
    }

    const safety = classifyCommand(command);
    if (safety === "dangerous") {
      return "deny";
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

  if (command === "node" && args.length === 1 && args[0] === "--version") {
    return "safe";
  }

  return SAFE_COMMANDS.has(command) ? "safe" : "unknown";
}

