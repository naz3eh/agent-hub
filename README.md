# agent-hub

One desktop app to run and review AI agents. You give a task to a coding agent
(Claude Code, Codex, Gemini CLI, OpenCode, or any agent that speaks ACP), it
works in its own copy of your repo, and you approve, review, accept or discard
the result from one place.

This is phase 1. It covers coding tasks in local git projects. Chats, cowork
tasks, workflows, cloud agents and model routing come in later phases.

## How it works

- A small background service (the daemon) runs on `127.0.0.1`. It starts
  agents, keeps track of every thread and stores them in SQLite.
- Each task runs in a new git worktree on a `hub/<threadId>` branch, so several
  agents can work on the same repo at once without touching your checkout.
- Agents are driven over ACP (Agent Client Protocol). When an agent asks to do
  something, the thread moves to "needs you" until you answer.
- When an agent finishes, you see the diff. Accept merges the branch into your
  project. Discard deletes the worktree and the branch.
- The desktop app (Electron) talks to the daemon over HTTP. Right now it only
  lists agents and threads; the full UI comes next.

## Requirements

- Node.js 20 or newer
- git
- The agent CLIs you want to use, already installed and signed in
  (`claude`, `codex`, `gemini`, `opencode`)

## Run it

```bash
npm install
npm run dev:daemon      # starts the daemon on port 47321
npm run dev:desktop     # opens the desktop app
```

To try it without any real agent, start the daemon with `AGENT_HUB_DEV=1`.
That adds a mock agent that writes a small file and can ask for permission.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `AGENT_HUB_HOME` | `~/.agent-hub` | Where the database, token and worktrees live |
| `AGENT_HUB_PORT` | `47321` | Daemon port |
| `AGENT_HUB_DEV` | unset | Set to `1` to add the mock agent |

Every API call needs the token from `~/.agent-hub/token`. The file is only
readable by you.

To add another ACP agent, list it in `~/.agent-hub/agents.json`:

```json
[{ "id": "my-agent", "name": "My Agent", "command": "my-agent", "args": ["acp"], "detect": { "bin": "my-agent" } }]
```

## Project layout

```text
apps/desktop      Electron app
packages/daemon   Local HTTP service
packages/core     Threads, SQLite store, worktrees, ACP adapter
docs/             Architecture notes
```

## Development

```bash
npm run build
npm run lint
npm test
```

## License

MIT
