import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { PermissionRequest } from "../permissions/permission.types.js";
import type { ToolContext } from "../tool.types.js";
import { WorkspacePathResolver } from "../workspace/workspace-path-resolver.js";

export interface WriteTarget {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly permission: PermissionRequest;
}

export async function inspectWriteTarget(
  requestedPath: string,
  bytes: number,
  largeThresholdBytes: number,
  context: ToolContext,
): Promise<WriteTarget> {
  const resolver = await WorkspacePathResolver.create(context.workspaceRoot);
  const resolved = await resolver.resolve(requestedPath, { mustExist: false });
  let exists = true;
  try {
    await stat(resolved.absolutePath);
  } catch {
    exists = false;
  }

  const sensitivity = classifySensitivePath(resolved.relativePath);
  return {
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    exists,
    permission: {
      capability: exists
        ? "modify_workspace_file"
        : "create_workspace_file",
      workspaceRoot: resolver.root,
      resource: resolved.relativePath,
      write: {
        bytes,
        large: bytes > largeThresholdBytes,
        ...(sensitivity ? { sensitivity } : {}),
      },
    },
  };
}

export function classifySensitivePath(
  path: string,
): "environment" | "credential" | undefined {
  const name = basename(path).toLocaleLowerCase();
  if (name === ".env" || name.startsWith(".env.")) {
    return "environment";
  }
  if (
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.startsWith("credentials") ||
    name === "id_rsa" ||
    name === "id_ed25519"
  ) {
    return "credential";
  }
  return undefined;
}
