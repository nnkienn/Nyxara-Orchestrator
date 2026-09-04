import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_HISTORY_SESSIONS,
  TASK_SESSION_SCHEMA_VERSION,
  TERMINAL_TASK_SESSION_STATUSES,
  createTaskSession,
  sanitizeTaskSession,
  type CreateTaskSessionInput,
  type TaskSession,
  type TaskSessionStatus,
} from "./task-session.js";

export interface TaskHistoryFilter { readonly status?: "active" | "completed" | "failed" | "interrupted"; readonly workspaceId?: string; readonly allWorkspaces?: boolean; readonly query?: string }
export const HISTORY_RETENTION_CHOICES = Object.freeze([20, 50, 100] as const);
export type HistoryRetention = typeof HISTORY_RETENTION_CHOICES[number];
interface TaskHistoryFile { readonly schemaVersion: 1; readonly sessions: readonly TaskSession[] }
const MAX_HISTORY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_LOAD_CANDIDATES = 200;

export class TaskHistoryStore {
  readonly loadDurationMs: number;
  private sessions: TaskSession[] = [];
  private revision = 0;
  private writtenRevision = 0;
  private writeScheduled = false;
  private writeQueue: Promise<void> = Promise.resolve();
  readonly storageFile?: string;

  constructor(
    storageRoot?: string,
    private maxSessions = MAX_HISTORY_SESSIONS,
    private readonly diagnostic: (message: string) => void = () => undefined,
  ) {
    const started = performance.now();
    if (storageRoot) this.storageFile = path.join(storageRoot, "task-history.v1.json");
    this.load();
    this.loadDurationMs = Math.max(0, performance.now() - started);
  }

  create(input: CreateTaskSessionInput): TaskSession {
    const session = createTaskSession(input);
    this.sessions = this.retain([session, ...this.sessions.filter((item) => item.id !== session.id)]);
    this.changed();
    return session;
  }

  update(id: string, update: Partial<TaskSession> | ((session: TaskSession) => TaskSession)): TaskSession | undefined {
    const current = this.get(id); if (!current) return undefined;
    const candidate = typeof update === "function" ? update(current) : { ...current, ...update };
    const sanitized = sanitizeTaskSession(candidate); if (!sanitized || sanitized.id !== current.id) return undefined;
    if (sameProjection(current, sanitized)) return current;
    this.sessions = this.retain(this.sessions.map((item) => item.id === id ? sanitized : item));
    this.changed();
    return sanitized;
  }

  get(id: string): TaskSession | undefined { return this.sessions.find((session) => session.id === id); }

  list(filter: TaskHistoryFilter = {}): TaskSession[] {
    const query = filter.query?.trim().toLocaleLowerCase() ?? "";
    const matchesStatus = (status: TaskSessionStatus): boolean => {
      if (!filter.status) return true;
      if (filter.status === "active") return !TERMINAL_TASK_SESSION_STATUSES.has(status);
      if (filter.status === "completed") return status === "completed";
      if (filter.status === "failed") return status === "failed" || status === "aborted";
      return status === "interrupted";
    };
    return [...this.sessions]
      .filter((session) => (filter.allWorkspaces || !filter.workspaceId || session.workspaceIdentity.id === filter.workspaceId) && matchesStatus(session.status) && (!query || `${session.title}\n${session.requirement}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        if (filter.allWorkspaces && filter.workspaceId) {
          const workspaceDelta = Number(b.workspaceIdentity.id === filter.workspaceId) - Number(a.workspaceIdentity.id === filter.workspaceId);
          if (workspaceDelta) return workspaceDelta;
        }
        return recentOrder(a, b);
      });
  }

  search(query: string, filter: Omit<TaskHistoryFilter, "query"> = {}): TaskSession[] { return this.list({ ...filter, query }); }

  get retention(): number { return this.maxSessions; }

  setRetention(value: number): void {
    if (!HISTORY_RETENTION_CHOICES.includes(value as HistoryRetention)) throw new Error("Task history retention must be 20, 50, or 100.");
    this.maxSessions = value;
    const retained = this.retain(this.sessions);
    if (retained.length !== this.sessions.length) { this.sessions = retained; this.changed(); }
  }

  delete(id: string): boolean {
    const session = this.get(id); if (!session) return false;
    if (!TERMINAL_TASK_SESSION_STATUSES.has(session.status)) throw new Error("The active task cannot be deleted.");
    this.sessions = this.sessions.filter((item) => item.id !== id);
    this.changed();
    return true;
  }

  clear(): number {
    const retained = this.sessions.filter((session) => !TERMINAL_TASK_SESSION_STATUSES.has(session.status));
    const removed = this.sessions.length - retained.length;
    if (removed) { this.sessions = retained; this.changed(); }
    return removed;
  }

  markInterrupted(authoritativeWorkflowIds: ReadonlySet<string> = new Set()): number {
    let changed = 0;
    const now = new Date().toISOString();
    this.sessions = this.retain(this.sessions.map((session) => {
      if (TERMINAL_TASK_SESSION_STATUSES.has(session.status) || (session.workflowId && authoritativeWorkflowIds.has(session.workflowId))) return session;
      changed += 1;
      return { ...session, status: "interrupted" as const, interrupted: true as const, updatedAt: now };
    }));
    if (changed) this.changed();
    return changed;
  }

  async flush(): Promise<void> {
    if (!this.storageFile) return;
    while (this.writeScheduled || this.writtenRevision < this.revision) await this.writeQueue;
  }

  private load(): void {
    if (!this.storageFile) return;
    try {
      if (statSync(this.storageFile).size > MAX_HISTORY_FILE_BYTES) {
        this.diagnostic("Task history storage exceeds the safe local size limit; starting with empty local history.");
        return;
      }
      const parsed: unknown = JSON.parse(readFileSync(this.storageFile, "utf8"));
      if (!record(parsed) || parsed.schemaVersion !== TASK_SESSION_SCHEMA_VERSION || !Array.isArray(parsed.sessions)) {
        this.diagnostic("Task history storage has an unsupported or malformed root; starting with empty local history.");
        return;
      }
      const sessions = parsed.sessions.slice(0, Math.max(this.maxSessions * 2, MAX_HISTORY_LOAD_CANDIDATES)).flatMap((value) => {
        const session = sanitizeTaskSession(value);
        if (!session) this.diagnostic("Ignored one malformed local task history record.");
        return session ? [session] : [];
      });
      this.sessions = this.retain(sessions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.diagnostic("Task history storage could not be parsed; starting with empty local history.");
    }
  }

  private retain(values: readonly TaskSession[]): TaskSession[] {
    const unique = [...new Map(values.map((session) => [session.id, session])).values()];
    const active = unique.filter((session) => !TERMINAL_TASK_SESSION_STATUSES.has(session.status)).sort(recentOrder);
    const terminal = unique.filter((session) => TERMINAL_TASK_SESSION_STATUSES.has(session.status)).sort(recentOrder);
    return [...active, ...terminal.slice(0, Math.max(0, this.maxSessions - active.length))].sort(recentOrder);
  }

  private changed(): void {
    this.revision += 1;
    if (!this.storageFile || this.writeScheduled) return;
    this.writeScheduled = true;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        while (this.writtenRevision < this.revision) {
          const revision = this.revision;
          const payload: TaskHistoryFile = { schemaVersion: TASK_SESSION_SCHEMA_VERSION, sessions: this.sessions };
          await mkdir(path.dirname(this.storageFile!), { recursive: true });
          const temporary = `${this.storageFile}.tmp`;
          await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, this.storageFile!);
          this.writtenRevision = revision;
        }
      } catch {
        this.diagnostic("Task history could not be saved; current in-memory history remains available.");
        this.writtenRevision = this.revision;
      } finally {
        this.writeScheduled = false;
      }
    });
  }
}

function recentOrder(a: TaskSession, b: TaskSession): number { return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id); }
function sameProjection(a: TaskSession, b: TaskSession): boolean { const { updatedAt: _a, ...left } = a; const { updatedAt: _b, ...right } = b; return JSON.stringify(left) === JSON.stringify(right); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
