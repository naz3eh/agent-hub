import { EventEmitter } from "node:events";
import type { AdapterContext, AgentRun } from "./adapter.js";
import type { AgentCatalog } from "./catalog.js";
import { isActiveStatus, type Store } from "./store.js";
import type {
  PermissionRequest,
  Project,
  Thread,
  ThreadEvent,
  ThreadEventType,
  ThreadKind,
  ThreadStatus,
} from "./types.js";
import { createId, titleFromPrompt } from "./types.js";
import type { WorktreeManager } from "./worktrees.js";

interface PendingPermission {
  threadId: string;
  request: PermissionRequest;
  resolve(optionId: string | null): void;
}

export interface HubEvents {
  thread_updated: (thread: Thread) => void;
  thread_event: (event: ThreadEvent) => void;
}

export class Hub extends EventEmitter {
  private readonly runs = new Map<string, { run: AgentRun; controller: AbortController }>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    readonly store: Store,
    readonly worktrees: WorktreeManager,
    readonly catalog: AgentCatalog,
  ) {
    super();
  }

  async listAgents() {
    return this.catalog.list();
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  listThreads(filters: { status?: ThreadStatus; projectId?: string } = {}): Thread[] {
    return this.store.listThreads(filters);
  }

  getThread(id: string): { thread: Thread; events: ThreadEvent[] } | undefined {
    const thread = this.store.getThread(id);
    return thread ? { thread, events: this.store.listEvents(id) } : undefined;
  }

  async addProject(path: string, name?: string): Promise<Project> {
    const validated = await this.worktrees.validateProjectPath(path);
    const existing = this.store.findProjectByPath(validated.path);
    if (existing) return existing;
    const project: Project = {
      id: createId(),
      name: name?.trim() || validated.path.split("/").filter(Boolean).at(-1) || validated.path,
      path: validated.path,
      createdAt: new Date().toISOString(),
    };
    return this.store.createProject(project);
  }

  async startThread(input: {
    kind: ThreadKind;
    projectId: string;
    agentId: string;
    prompt: string;
    model?: string;
    title?: string;
  }): Promise<Thread> {
    if (input.kind !== "project_task") throw new HubRequestError(400, "kind_not_enabled");
    const project = this.store.getProject(input.projectId);
    if (!project) throw new HubRequestError(404, "project_not_found");
    const adapter = this.catalog.get(input.agentId);
    if (!adapter) throw new HubRequestError(404, "agent_not_found");
    const now = new Date().toISOString();
    const id = createId();
    const thread: Thread = {
      id,
      kind: input.kind,
      title: input.title?.slice(0, 80) || titleFromPrompt(input.prompt),
      projectId: project.id,
      agentId: adapter.id,
      model: input.model ?? null,
      runtime: adapter.runtime,
      status: "starting",
      worktreePath: null,
      branch: `hub/${id}`,
      baseRef: null,
      externalId: null,
      error: null,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createThread(thread);
    this.emitThread(thread);
    this.emitEvent(id, "user_message", { text: input.prompt });
    try {
      const baseRef = (await this.worktrees.validateProjectPath(project.path)).head;
      const worktreePath = await this.worktrees.create(project, thread, baseRef);
      this.store.updateThread(id, { worktreePath, baseRef });
      const controller = new AbortController();
      const context: AdapterContext = {
        thread: { ...thread, worktreePath, baseRef },
        cwd: worktreePath,
        prompt: input.prompt,
        emit: (type, data) => {
          if (
            type === "status" &&
            typeof data === "object" &&
            data !== null &&
            typeof (data as { externalId?: unknown }).externalId === "string"
          ) {
            this.updateThread(id, { externalId: (data as { externalId: string }).externalId });
          }
          this.emitEvent(id, type, data);
        },
        setStatus: (status, error) => this.setStatus(id, status, error),
        requestPermission: (request) => this.requestPermission(id, request),
        signal: controller.signal,
      };
      const run = await adapter.start(context);
      this.runs.set(id, { run, controller });
      return this.store.getThread(id) ?? thread;
    } catch (error) {
      this.setStatus(id, "failed", error instanceof Error ? error.message : String(error));
      return this.store.getThread(id) ?? thread;
    }
  }

  async send(id: string, text: string): Promise<Thread> {
    const thread = this.requireThread(id);
    if (thread.status !== "ready_for_review") throw new HubRequestError(409, "thread_not_ready");
    const active = this.runs.get(id);
    if (!active) throw new HubRequestError(409, "agent_session_unavailable");
    this.emitEvent(id, "user_message", { text });
    await active.run.send(text);
    return this.requireThread(id);
  }

  async answerPermission(id: string, requestId: string, optionId: string | null): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.threadId !== id) throw new HubRequestError(404, "permission_not_found");
    if (optionId && !pending.request.options.some((option) => option.optionId === optionId)) {
      throw new HubRequestError(400, "invalid_permission_option");
    }
    this.pendingPermissions.delete(requestId);
    this.emitEvent(id, "permission_response", { requestId, optionId });
    this.setStatus(id, "running");
    pending.resolve(optionId);
  }

  async cancel(id: string): Promise<Thread> {
    const thread = this.requireThread(id);
    const active = this.runs.get(id);
    if (!active || !isActiveStatus(thread.status)) {
      throw new HubRequestError(409, "thread_not_running");
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId === id) {
        this.pendingPermissions.delete(requestId);
        pending.resolve(null);
      }
    }
    active.controller.abort();
    await active.run.cancel();
    return this.requireThread(id);
  }

  async diff(id: string) {
    const thread = this.requireThread(id);
    return this.worktrees.diff(thread);
  }

  async accept(id: string, message?: string): Promise<Thread> {
    const thread = this.requireThread(id);
    if (!thread.projectId) throw new HubRequestError(400, "thread_has_no_project");
    if (thread.status !== "ready_for_review") throw new HubRequestError(409, "thread_not_ready");
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new HubRequestError(404, "project_not_found");
    try {
      await this.worktrees.accept(project, thread, message);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) {
        throw new HubRequestError(409, error.message);
      }
      throw error;
    }
    const active = this.runs.get(id);
    if (active) {
      await active.run.dispose();
      this.runs.delete(id);
    }
    return this.setStatus(id, "accepted");
  }

  async discard(id: string): Promise<Thread> {
    const thread = this.requireThread(id);
    if (!thread.projectId) throw new HubRequestError(400, "thread_has_no_project");
    if (thread.status === "accepted" || thread.status === "discarded") {
      throw new HubRequestError(409, "thread_already_closed");
    }
    const project = this.store.getProject(thread.projectId);
    if (!project) throw new HubRequestError(404, "project_not_found");
    const active = this.runs.get(id);
    if (active) {
      active.controller.abort();
      await active.run.dispose();
      this.runs.delete(id);
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.threadId === id) {
        this.pendingPermissions.delete(requestId);
        pending.resolve(null);
      }
    }
    await this.worktrees.discard(project, thread);
    return this.setStatus(id, "discarded");
  }

  async dispose(): Promise<void> {
    for (const { run, controller } of this.runs.values()) {
      controller.abort();
      await run.dispose();
    }
    this.runs.clear();
  }

  markInterruptedThreadsStopped(): void {
    for (const thread of this.store.listThreads()) {
      if (isActiveStatus(thread.status)) this.setStatus(thread.id, "stopped", "daemon_restarted");
    }
  }

  private requestPermission(id: string, request: PermissionRequest): Promise<string | null> {
    this.setStatus(id, "needs_you");
    this.emitEvent(id, "permission_request", request);
    return new Promise((resolve) => {
      this.pendingPermissions.set(request.requestId, { threadId: id, request, resolve });
    });
  }

  private setStatus(id: string, status: ThreadStatus, error: string | null = null): Thread {
    const thread = this.updateThread(id, { status, error });
    this.emitEvent(id, status === "failed" ? "error" : "status", {
      status,
      ...(error ? { error } : {}),
    });
    return thread;
  }

  private updateThread(id: string, update: Partial<Thread>): Thread {
    const thread = this.store.updateThread(id, update);
    this.emitThread(thread);
    return thread;
  }

  private emitThread(thread: Thread): void {
    this.emit("thread_updated", thread);
  }

  private emitEvent(threadId: string, type: ThreadEventType, data: unknown): void {
    const stored = this.store.appendEvent(threadId, type, data);
    const event: ThreadEvent = {
      ...stored,
      data,
      at: new Date().toISOString(),
    };
    this.emit("thread_event", event);
  }

  private requireThread(id: string): Thread {
    const thread = this.store.getThread(id);
    if (!thread) throw new HubRequestError(404, "thread_not_found");
    return thread;
  }
}

export class HubRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
