export interface CommandRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly truncated: boolean;
}

export interface ExecutionRuntime {
  run(request: CommandRequest): Promise<CommandResult>;
}

