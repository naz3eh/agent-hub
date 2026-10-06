import type {
  AgentSummary,
  PermissionRequest,
  Project,
  Thread,
  ThreadEvent,
  ThreadStatus,
} from "@agent-hub/core";

export type Tone = "active" | "attention" | "review" | "success" | "danger" | "muted";

export const STATUS_META: Record<ThreadStatus, { label: string; tone: Tone }> = {
  starting: { label: "Starting", tone: "active" },
  running: { label: "Running", tone: "active" },
  needs_you: { label: "Needs you", tone: "attention" },
  ready_for_review: { label: "Ready for review", tone: "review" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "muted" },
  accepted: { label: "Accepted", tone: "success" },
  discarded: { label: "Discarded", tone: "muted" },
};

export type InboxFilter = "all" | "needs_you" | "active" | "review" | "closed";

export const FILTERS: { id: InboxFilter; label: string; statuses: ThreadStatus[] | null }[] = [
  { id: "all", label: "All threads", statuses: null },
  { id: "needs_you", label: "Needs you", statuses: ["needs_you"] },
  { id: "active", label: "Running", statuses: ["starting", "running"] },
  { id: "review", label: "Ready for review", statuses: ["ready_for_review"] },
  { id: "closed", label: "Closed", statuses: ["failed", "stopped", "accepted", "discarded"] },
];

export const GROUPS: { id: string; label: string; statuses: ThreadStatus[] }[] = [
  { id: "needs_you", label: "Needs you", statuses: ["needs_you"] },
  { id: "active", label: "Running", statuses: ["starting", "running"] },
  { id: "review", label: "Ready for review", statuses: ["ready_for_review"] },
  { id: "problem", label: "Failed or stopped", statuses: ["failed", "stopped"] },
  { id: "done", label: "Done", statuses: ["accepted", "discarded"] },
];

export function isActive(status: ThreadStatus): boolean {
  return status === "starting" || status === "running" || status === "needs_you";
}

export function isClosed(status: ThreadStatus): boolean {
  return status === "accepted" || status === "discarded";
}

export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  return sortThreads([thread, ...threads.filter((item) => item.id !== thread.id)]);
}

export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function agentName(agents: AgentSummary[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

export function projectName(projects: Project[], id: string | null): string {
  if (!id) return "No project";
  return projects.find((project) => project.id === id)?.name ?? "Unknown project";
}

const ERROR_TEXT: Record<string, string> = {
  thread_not_ready: "The agent is still working on this thread.",
  thread_not_running: "This thread is not running.",
  thread_already_closed: "This thread is already closed.",
  agent_session_unavailable: "The agent session ended. Start a new thread to continue.",
  kind_not_enabled: "Only project tasks are available in this version.",
  project_not_found: "That project no longer exists.",
  agent_not_found: "That agent is not available.",
  "Project working tree is dirty":
    "Your project has uncommitted changes. Commit or stash them, then accept again.",
};

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (ERROR_TEXT[message]) return ERROR_TEXT[message];
  if (message === "Failed to fetch") return "Can't reach the agent-hub daemon.";
  return message.replaceAll("_", " ");
}

export interface PlanEntry {
  content: string;
  status?: string;
  priority?: string;
}

export type TranscriptItem =
  | { key: string; kind: "user"; text: string; at: string }
  | { key: string; kind: "agent"; text: string; at: string }
  | { key: string; kind: "thought"; text: string }
  | { key: string; kind: "plan"; entries: PlanEntry[] }
  | { key: string; kind: "tool"; title: string; toolKind?: string; status: string }
  | {
      key: string;
      kind: "permission";
      request: PermissionRequest;
      answer: string | null | undefined;
    }
  | { key: string; kind: "status"; status: ThreadStatus; error?: string };

const SHOWN_STATUSES = new Set<ThreadStatus>([
  "ready_for_review",
  "failed",
  "stopped",
  "accepted",
  "discarded",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildTranscript(events: ThreadEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  const permissions = new Map<string, Extract<TranscriptItem, { kind: "permission" }>>();
  let plan: Extract<TranscriptItem, { kind: "plan" }> | undefined;

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const key = `${event.type}-${event.seq}`;
    const last = items.at(-1);
    switch (event.type) {
      case "user_message":
        items.push({ key, kind: "user", text: text(data.text), at: event.at });
        break;
      case "agent_message":
        if (last?.kind === "agent") last.text += text(data.text);
        else items.push({ key, kind: "agent", text: text(data.text), at: event.at });
        break;
      case "agent_thought":
        if (last?.kind === "thought") last.text += text(data.text);
        else items.push({ key, kind: "thought", text: text(data.text) });
        break;
      case "plan": {
        const entries = Array.isArray(data.entries) ? (data.entries as PlanEntry[]) : [];
        if (plan) plan.entries = entries;
        else {
          plan = { key: "plan", kind: "plan", entries };
          items.push(plan);
        }
        break;
      }
      case "tool_call": {
        const id = text(data.toolCallId) || key;
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          key: `tool-${id}`,
          kind: "tool",
          title: text(data.title) || "Tool call",
          toolKind: text(data.kind) || undefined,
          status: text(data.status) || "pending",
        };
        if (!tools.has(id)) items.push(item);
        tools.set(id, item);
        break;
      }
      case "tool_call_update": {
        const item = tools.get(text(data.toolCallId));
        if (item) {
          if (text(data.status)) item.status = text(data.status);
          if (text(data.title)) item.title = text(data.title);
        }
        break;
      }
      case "permission_request": {
        const request = data as unknown as PermissionRequest;
        const item: Extract<TranscriptItem, { kind: "permission" }> = {
          key: `permission-${request.requestId}`,
          kind: "permission",
          request,
          answer: undefined,
        };
        permissions.set(request.requestId, item);
        items.push(item);
        break;
      }
      case "permission_response": {
        const item = permissions.get(text(data.requestId));
        if (item) item.answer = typeof data.optionId === "string" ? data.optionId : null;
        break;
      }
      case "status":
      case "error": {
        const status = data.status as ThreadStatus | undefined;
        if (status && SHOWN_STATUSES.has(status)) {
          items.push({ key, kind: "status", status, error: text(data.error) || undefined });
        }
        break;
      }
    }
  }
  return items;
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "context" | "note";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export function parsePatch(patch: string): Map<string, DiffLine[]> {
  const files = new Map<string, DiffLine[]>();
  let current: DiffLine[] | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) {
      current = [];
      files.set(header[2] ?? "", current);
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.push({ kind: "hunk", text: raw });
      continue;
    }
    if (isPatchMetadata(raw)) continue;
    if (raw.startsWith("+")) {
      current.push({ kind: "add", text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      current.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++ });
    } else if (raw.startsWith("\\")) {
      current.push({ kind: "note", text: raw.slice(2) });
    } else if (raw.startsWith(" ")) {
      current.push({ kind: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (raw.startsWith("Binary files")) {
      current.push({ kind: "note", text: "Binary file" });
    }
  }
  return files;
}

function isPatchMetadata(line: string): boolean {
  return (
    line.startsWith("+++ ") ||
    line.startsWith("--- ") ||
    /^(index|new file|deleted file|similarity|rename|old mode|new mode) /.test(line)
  );
}
