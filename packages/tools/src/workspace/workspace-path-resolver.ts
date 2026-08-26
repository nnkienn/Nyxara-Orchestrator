import { realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { NyxaraToolError } from "../errors.js";

export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface ResolveWorkspacePathOptions {
  readonly mustExist?: boolean;
}

export class WorkspacePathResolver {
  readonly root: string;

  private constructor(
    private readonly requestedRoot: string,
    canonicalRoot: string,
  ) {
    this.root = canonicalRoot;
  }

  static async create(workspaceRoot: string): Promise<WorkspacePathResolver> {
    const requestedRoot = resolve(workspaceRoot);

    try {
      const root = await realpath(requestedRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) {
        throw new NyxaraToolError(
          "workspace_error",
          "Workspace root is not a directory",
        );
      }

      return new WorkspacePathResolver(requestedRoot, root);
    } catch (error: unknown) {
      if (error instanceof NyxaraToolError) {
        throw error;
      }

      throw new NyxaraToolError(
        "workspace_error",
        "Workspace root could not be resolved",
      );
    }
  }

  async resolve(
    requestedPath = ".",
    options: ResolveWorkspacePathOptions = {},
  ): Promise<ResolvedWorkspacePath> {
    const mustExist = options.mustExist ?? true;
    const candidate = this.lexicalCandidate(requestedPath);
    this.assertInside(candidate);

    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(candidate);
    } catch (error: unknown) {
      if (mustExist) {
        throw new NyxaraToolError(
          "file_not_found",
          "Workspace path does not exist",
        );
      }

      await this.assertExistingAncestorInside(candidate);
      resolvedTarget = candidate;
    }

    this.assertInside(resolvedTarget);

    const relativePath = relative(this.root, candidate) || ".";
    return {
      absolutePath: resolvedTarget,
      relativePath: relativePath.split(sep).join("/"),
    };
  }

  private lexicalCandidate(requestedPath: string): string {
    if (!isAbsolute(requestedPath)) {
      return resolve(this.root, requestedPath);
    }

    const absolute = resolve(requestedPath);
    if (this.isInside(this.requestedRoot, absolute)) {
      return resolve(this.root, relative(this.requestedRoot, absolute));
    }

    return absolute;
  }

  private async assertExistingAncestorInside(candidate: string): Promise<void> {
    let ancestor = dirname(candidate);

    while (this.isInside(this.root, ancestor)) {
      let resolvedAncestor: string | undefined;
      try {
        resolvedAncestor = await realpath(ancestor);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          break;
        }
        ancestor = parent;
        continue;
      }

      if (resolvedAncestor) {
        this.assertInside(resolvedAncestor);
        return;
      }
    }

    throw new NyxaraToolError(
      "path_outside_workspace",
      "Workspace path resolves outside the workspace",
    );
  }

  private assertInside(candidate: string): void {
    if (!this.isInside(this.root, candidate)) {
      throw new NyxaraToolError(
        "path_outside_workspace",
        "Workspace path resolves outside the workspace",
      );
    }
  }

  private isInside(root: string, candidate: string): boolean {
    const pathFromRoot = relative(root, candidate);
    return (
      pathFromRoot === "" ||
      (!pathFromRoot.startsWith(`..${sep}`) &&
        pathFromRoot !== ".." &&
        !isAbsolute(pathFromRoot))
    );
  }
}
