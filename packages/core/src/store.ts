import Database from "better-sqlite3";
import type {
  Project,
  Thread,
  ThreadEvent,
  ThreadEventType,
  ThreadKind,
  ThreadStatus,
} from "./types.js";

type ThreadRow = Omit<Thread, "costUsd"> & { costUsd: number };
type ProjectRow = Project;
type EventRow = Omit<ThreadEvent, "data"> & { data: string };

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        projectId TEXT REFERENCES projects(id),
        agentId TEXT NOT NULL,
        model TEXT,
        runtime TEXT NOT NULL,
        status TEXT NOT NULL,
        worktreePath TEXT,
        branch TEXT,
        baseRef TEXT,
        externalId TEXT,
        error TEXT,
        costUsd REAL NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (threadId, seq)
      );
      CREATE INDEX IF NOT EXISTS threads_status_idx ON threads(status);
      CREATE INDEX IF NOT EXISTS threads_project_idx ON threads(projectId);
    `);
  }

  close(): void {
    this.db.close();
  }

  createProject(project: Project): Project {
    this.db
      .prepare("INSERT INTO projects (id, name, path, createdAt) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.path, project.createdAt);
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  findProjectByPath(path: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE path = ?").get(path) as
      | ProjectRow
      | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY createdAt").all() as ProjectRow[];
  }

  createThread(thread: Thread): Thread {
    this.db
      .prepare(
        `INSERT INTO threads
          (id, kind, title, projectId, agentId, model, runtime, status, worktreePath, branch,
           baseRef, externalId, error, costUsd, createdAt, updatedAt)
         VALUES (@id, @kind, @title, @projectId, @agentId, @model, @runtime, @status,
           @worktreePath, @branch, @baseRef, @externalId, @error, @costUsd, @createdAt, @updatedAt)`,
      )
      .run(thread);
    return thread;
  }

  getThread(id: string): Thread | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  }

  listThreads(filters: { status?: ThreadStatus; projectId?: string } = {}): Thread[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filters.status) {
      conditions.push("status = ?");
      values.push(filters.status);
    }
    if (filters.projectId) {
      conditions.push("projectId = ?");
      values.push(filters.projectId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM threads ${where} ORDER BY createdAt DESC`)
      .all(...values) as ThreadRow[];
  }

  updateThread(id: string, update: Partial<Thread>): Thread {
    const current = this.getThread(id);
    if (!current) throw new Error(`Thread not found: ${id}`);
    const next = { ...current, ...update, id, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE threads SET kind = @kind, title = @title, projectId = @projectId,
          agentId = @agentId, model = @model, runtime = @runtime, status = @status,
          worktreePath = @worktreePath, branch = @branch, baseRef = @baseRef,
          externalId = @externalId, error = @error, costUsd = @costUsd,
          updatedAt = @updatedAt WHERE id = @id`,
      )
      .run(next);
    return next;
  }

  appendEvent(threadId: string, type: ThreadEventType, data: unknown): ThreadEvent {
    const at = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM events WHERE threadId = ? ORDER BY seq DESC LIMIT 1")
      .get(threadId) as EventRow | undefined;
    if (existing?.type === type && (type === "agent_message" || type === "agent_thought")) {
      const previous = JSON.parse(existing.data) as { text?: string };
      const incoming = data as { text?: string };
      if (typeof previous.text === "string" && typeof incoming?.text === "string") {
        const merged = { ...previous, ...incoming, text: previous.text + incoming.text };
        this.db
          .prepare("UPDATE events SET data = ?, at = ? WHERE threadId = ? AND seq = ?")
          .run(JSON.stringify(merged), at, threadId, existing.seq);
        return { threadId, seq: existing.seq, at, type, data: merged };
      }
    }
    const seq = (existing?.seq ?? 0) + 1;
    this.db
      .prepare("INSERT INTO events (threadId, seq, at, type, data) VALUES (?, ?, ?, ?, ?)")
      .run(threadId, seq, at, type, JSON.stringify(data));
    return { threadId, seq, at, type, data };
  }

  listEvents(threadId: string): ThreadEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE threadId = ? ORDER BY seq")
      .all(threadId) as EventRow[];
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }
}

export function isActiveStatus(status: ThreadStatus): boolean {
  return status === "starting" || status === "running" || status === "needs_you";
}

export type { ThreadKind };
