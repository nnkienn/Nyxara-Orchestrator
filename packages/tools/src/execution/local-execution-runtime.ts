import { spawn } from "node:child_process";
import { NyxaraToolError } from "../errors.js";
import type {
  CommandRequest,
  CommandResult,
  ExecutionRuntime,
} from "./execution.types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class LocalExecutionRuntime implements ExecutionRuntime {
  async run(request: CommandRequest): Promise<CommandResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    if (timeoutMs <= 0 || maxOutputBytes <= 0) {
      throw new NyxaraToolError(
        "tool_error",
        "Command timeout and output limit must be positive",
      );
    }

    return new Promise<CommandResult>((resolveResult, reject) => {
      const startedAt = Date.now();
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      let aborted = false;
      let truncated = false;
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;

      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        shell: false,
        stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });

      if (request.stdin !== undefined && child.stdin) {
        child.stdin.end(request.stdin);
      }

      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const usedBytes = stdout.byteLength + stderr.byteLength;
        const remainingBytes = Math.max(0, maxOutputBytes - usedBytes);
        const accepted = chunk.subarray(0, remainingBytes);

        if (target === "stdout") {
          stdout = Buffer.concat([stdout, accepted]);
        } else {
          stderr = Buffer.concat([stderr, accepted]);
        }

        if (accepted.byteLength < chunk.byteLength || remainingBytes === 0) {
          truncated = true;
        }
      };

      child.stdout!.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => append("stderr", chunk));

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) {
        onAbort();
      }

      child.on("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        request.signal?.removeEventListener("abort", onAbort);
        reject(
          new NyxaraToolError("tool_error", "Command could not be started"),
        );
      });

      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        request.signal?.removeEventListener("abort", onAbort);
        resolveResult({
          exitCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          durationMs: Date.now() - startedAt,
          timedOut,
          aborted,
          truncated,
        });
      });
    });
  }
}
