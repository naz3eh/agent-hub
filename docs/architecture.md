# Architecture (phase 1)

Phase 1 goal: run three local coding agents side by side, each in its own git worktree, from one desktop app. Start, steer, approve and review them in one inbox.

## Pieces

```
apps/desktop      Electron + React UI. Talks to the daemon over HTTP + SSE.
packages/daemon   Local background service on 127.0.0.1. Owns threads, agents, worktrees.
packages/core     Thread model, SQLite store, adapter SDK, ACP adapter, worktree manager.
```

The daemon is a plain Node process (not Electron). The desktop app starts it if it is not already running. That keeps `better-sqlite3` on the Node ABI and lets agents keep running when the window is closed.

Data lives in `~/.agent-hub` (override with `AGENT_HUB_HOME`):

```
hub.db        SQLite
token         random bearer token for the local API (file mode 0600)
worktrees/    <projectId>/<threadId>/
agents.json   optional user-defined ACP agents
```

## Thread

Every unit of work is a thread. Kinds: `project_task`, `chat`, `cowork`, `workflow`. Phase 1 only enables `project_task`; creating another kind returns 400 `kind_not_enabled`.

```ts
type ThreadKind = "project_task" | "chat" | "cowork" | "workflow";
type ThreadStatus =
  | "starting" | "running" | "needs_you" | "ready_for_review"
  | "failed" | "stopped" | "accepted" | "discarded";
type Runtime = "local" | "cloud" | "in_app";

interface Thread {
  id: string;              // ulid-like, sortable
  kind: ThreadKind;
  title: string;           // first line of the prompt, max 80 chars, unless given
  projectId: string | null;
  agentId: string;         // e.g. "claude-code", "codex", "gemini", "mock"
  model: string | null;    // requested model; adapters may ignore it
  runtime: Runtime;
  status: ThreadStatus;
  worktreePath: string | null;
  branch: string | null;   // hub/<threadId>
  baseRef: string | null;  // commit SHA the worktree started from
  externalId: string | null; // ACP sessionId
  error: string | null;
  costUsd: number;         // 0 in phase 1 (gateway comes in phase 3)
  createdAt: string;       // ISO
  updatedAt: string;
}

interface Project { id: string; name: string; path: string; createdAt: string }

type ThreadEventType =
  | "user_message" | "agent_message" | "agent_thought"
  | "tool_call" | "tool_call_update" | "plan"
  | "permission_request" | "permission_response"
  | "status" | "error";

interface ThreadEvent { threadId: string; seq: number; at: string; type: ThreadEventType; data: unknown }
```

Consecutive `agent_message` / `agent_thought` chunks are merged into one event in the store (append text) so transcripts stay small; the SSE stream still sends each chunk.

## Adapter SDK

```ts
interface AgentAdapter {
  id: string;
  name: string;
  runtime: Runtime;
  detect(): Promise<AgentAvailability>; // { installed: boolean; detail: string; command?: string }
  start(ctx: AdapterContext): Promise<AgentRun>;
}

interface AdapterContext {
  thread: Thread;
  cwd: string;                       // the worktree
  prompt: string;
  emit(type: ThreadEventType, data: unknown): void;
  setStatus(status: ThreadStatus, error?: string): void;
  requestPermission(req: PermissionRequest): Promise<string | null>; // optionId, or null = cancelled
  signal: AbortSignal;
}

interface AgentRun {
  send(text: string): Promise<void>; // next prompt turn
  cancel(): Promise<void>;           // cancel current turn
  dispose(): Promise<void>;          // kill the agent process
}
```

## ACP adapter

One generic adapter, configured by an `AcpAgentSpec`:

```ts
interface AcpAgentSpec {
  id: string; name: string;
  command: string; args: string[];
  env?: Record<string, string>;
  detect: { bin: string };            // looked up on PATH
  modelEnv?: string;                  // env var that sets the model, if the agent supports one
}
```

Built-in catalog (verified Oct 2026; all need the vendor's own login or API key, the hub never proxies subscription tokens):

| id | command | detect |
|---|---|---|
| claude-code | `npx -y @agentclientprotocol/claude-agent-acp` | `claude` |
| codex | `npx -y @zed-industries/codex-acp` | `codex` |
| gemini | `gemini --experimental-acp` | `gemini` |
| opencode | `opencode acp` | `opencode` |

Users can add more in `~/.agent-hub/agents.json` (same shape). A `mock` agent ships for tests and demos and is shown only when `AGENT_HUB_DEV=1`.

Turn flow: spawn → `initialize` (client capabilities: `fs.readTextFile` and `fs.writeTextFile`, no terminal) → `session/new` with `cwd` = worktree → `session/prompt`. Status is `running` during a turn, `needs_you` while a permission request is open, `ready_for_review` after `end_turn`, `stopped` after `cancelled`, `failed` on a crash or JSON-RPC error. The agent process stays alive between turns so "send back" continues the same session. On daemon start, threads left in `starting`/`running`/`needs_you` become `stopped` with error `daemon_restarted`.

File access from the agent is limited to the worktree: any `fs/*` path outside it is rejected.

## Worktrees and review

- Create: `git worktree add -b hub/<threadId> <home>/worktrees/<projectId>/<threadId> <HEAD sha>`.
- Diff: everything in the worktree compared with `baseRef`, including uncommitted and untracked files.
- Accept: commit any uncommitted changes in the worktree (as the user's git identity), then merge `hub/<threadId>` into the project's checked-out branch with `--no-ff`. Refuse with 409 if the project working tree is dirty or the merge conflicts (abort the merge). Then remove the worktree and mark `accepted`.
- Discard: dispose the agent, `git worktree remove --force`, delete the branch, mark `discarded`.

## Local API

All routes need `Authorization: Bearer <token>` (SSE also accepts `?token=`). Bound to 127.0.0.1 only. Default port 47321 (`AGENT_HUB_PORT`).

```
GET  /api/health                       { ok, version }
GET  /api/agents                       [{ id, name, runtime, installed, detail }]
GET  /api/projects | POST /api/projects { path, name? }  (must be a git repo with a commit)
GET  /api/threads?status=&projectId=
POST /api/threads                      { kind, projectId, agentId, prompt, model?, title? }
GET  /api/threads/:id                  { thread, events }
POST /api/threads/:id/messages         { text }
POST /api/threads/:id/permission       { requestId, optionId | null }
POST /api/threads/:id/cancel
GET  /api/threads/:id/diff             { files: [{ path, status, additions, deletions }], patch }
POST /api/threads/:id/accept           { message? }
POST /api/threads/:id/discard
GET  /api/events                       SSE: thread_updated, thread_event
```
