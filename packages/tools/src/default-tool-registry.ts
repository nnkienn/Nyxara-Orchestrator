import type { ExecutionRuntime } from "./execution/execution.types.js";
import { GitDiffTool } from "./git/git-diff-tool.js";
import { GitStatusTool } from "./git/git-status-tool.js";
import { LocalExecutionRuntime } from "./execution/local-execution-runtime.js";
import { RunCommandTool } from "./execution/run-command-tool.js";
import type { PermissionEngine } from "./permissions/permission.types.js";
import { DefaultPermissionEngine } from "./permissions/default-permission-engine.js";
import { ListDirectoryTool } from "./repository/list-directory-tool.js";
import { ReadFileTool } from "./repository/read-file-tool.js";
import type { RepositoryToolOptions } from "./repository/repository.types.js";
import { SearchCodeTool } from "./repository/search-code-tool.js";
import { SearchFilesTool } from "./repository/search-files-tool.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolEventObserver } from "./tool.types.js";

export interface DefaultToolRegistryOptions extends RepositoryToolOptions {
  readonly permissionEngine?: PermissionEngine;
  readonly executionRuntime?: ExecutionRuntime;
  readonly observer?: ToolEventObserver;
}

export function createDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const runtime = options.executionRuntime ?? new LocalExecutionRuntime();
  const repositoryOptions: RepositoryToolOptions = {
    ...(options.ignoredDirectories
      ? { ignoredDirectories: options.ignoredDirectories }
      : {}),
  };
  const registry = new ToolRegistry(
    options.permissionEngine ?? new DefaultPermissionEngine(),
    options.observer,
  );

  registry.register(new ListDirectoryTool(repositoryOptions));
  registry.register(new SearchFilesTool(repositoryOptions));
  registry.register(new SearchCodeTool(repositoryOptions));
  registry.register(new ReadFileTool());
  registry.register(new GitStatusTool(runtime));
  registry.register(new GitDiffTool(runtime));
  registry.register(new RunCommandTool(runtime));

  return registry;
}

