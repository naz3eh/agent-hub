import type { AgentSummary, Project, Thread, ThreadEvent } from "@agent-hub/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAgents, getHealth, getProjects, getThreads, subscribe } from "./api.js";
import { AddProjectDialog, NewThreadDialog } from "./components/Dialogs.js";
import { Icon, type IconName, Spinner } from "./components/Icon.js";
import { ThreadView } from "./components/ThreadView.js";
import {
  agentName,
  FILTERS,
  GROUPS,
  type InboxFilter,
  projectName,
  relativeTime,
  STATUS_META,
  sortThreads,
  upsertThread,
} from "./ui.js";

type Tone = "info" | "success" | "error";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const FILTER_ICONS: Record<InboxFilter, IconName> = {
  all: "inbox",
  needs_you: "alert",
  active: "sparkle",
  review: "check",
  closed: "list",
};

export default function App() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(true);
  const [version, setVersion] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"thread" | "project" | null>(null);
  const [returnToThread, setReturnToThread] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(Date.now());
  const listeners = useRef(new Set<(event: ThreadEvent) => void>());
  const connectedRef = useRef(true);
  const nextToast = useRef(0);

  const notify = useCallback((text: string, tone: Tone = "info") => {
    nextToast.current += 1;
    const id = nextToast.current;
    setToasts((current) => [...current.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
  }, []);

  const loadAll = useCallback(async () => {
    const [health, agentList, projectList, threadList] = await Promise.all([
      getHealth(),
      getAgents(),
      getProjects(),
      getThreads(),
    ]);
    setVersion(health.version);
    setAgents(agentList);
    setProjects(projectList);
    const sorted = sortThreads(threadList);
    setThreads(sorted);
    setSelectedId((current) => current ?? sorted[0]?.id ?? null);
    setLoaded(true);
    connectedRef.current = true;
    setConnected(true);
  }, []);

  useEffect(() => {
    loadAll().catch(() => {
      connectedRef.current = false;
      setConnected(false);
      setLoaded(true);
    });
  }, [loadAll]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      getHealth()
        .then(() => {
          if (!connectedRef.current) void loadAll();
        })
        .catch(() => {
          connectedRef.current = false;
          setConnected(false);
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [loadAll]);

  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  useEffect(
    () =>
      subscribe((name, data) => {
        if (name === "thread_updated") {
          const thread = data as Thread;
          const previous = threadsRef.current.find((item) => item.id === thread.id);
          if (thread.status === "needs_you" && previous?.status !== "needs_you") {
            notify(`“${thread.title}” needs your approval`, "info");
          }
          setThreads((current) => upsertThread(current, thread));
        } else if (name === "thread_event") {
          for (const listener of listeners.current) listener(data as ThreadEvent);
        }
      }),
    [notify],
  );

  const onEvent = useCallback((listener: (event: ThreadEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "n")) {
        event.preventDefault();
        setDialog("thread");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needsYou = threads.filter((thread) => thread.status === "needs_you").length;
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) agent-hub` : "agent-hub";
  }, [needsYou]);

  const scoped = useMemo(
    () =>
      projectFilter ? threads.filter((thread) => thread.projectId === projectFilter) : threads,
    [threads, projectFilter],
  );
  const counts = useMemo(() => {
    const result = {} as Record<InboxFilter, number>;
    for (const item of FILTERS) {
      result[item.id] = item.statuses
        ? scoped.filter((thread) => item.statuses?.includes(thread.status)).length
        : scoped.length;
    }
    return result;
  }, [scoped]);
  const visible = useMemo(() => {
    const statuses = FILTERS.find((item) => item.id === filter)?.statuses;
    return statuses ? scoped.filter((thread) => statuses.includes(thread.status)) : scoped;
  }, [scoped, filter]);

  const selected = threads.find((thread) => thread.id === selectedId) ?? null;
  const installedAgents = agents.filter((agent) => agent.installed).length;

  function openNewThread() {
    if (projects.length === 0) {
      setReturnToThread(true);
      setDialog("project");
    } else setDialog("thread");
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="layers" size={16} />
          </span>
          <span className="brand-name">agent-hub</span>
          <span className="brand-phase">phase 1</span>
        </div>

        <button type="button" className="button primary new-task" onClick={openNewThread}>
          <Icon name="plus" />
          New task
          <span className="kbd-hint">
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </span>
        </button>

        <nav className="nav-section">
          <div className="nav-label">Inbox</div>
          {FILTERS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={filter === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setFilter(item.id)}
            >
              <Icon name={FILTER_ICONS[item.id]} size={15} />
              <span>{item.label}</span>
              {counts[item.id] > 0 ? (
                <span className={item.id === "needs_you" ? "count count-attention" : "count"}>
                  {counts[item.id]}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <nav className="nav-section">
          <div className="nav-label">
            Projects
            <button
              type="button"
              className="icon-button small"
              aria-label="Add project"
              title="Add project"
              onClick={() => setDialog("project")}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          {projects.length === 0 ? (
            <p className="nav-empty">No projects yet</p>
          ) : (
            <>
              <button
                type="button"
                className={projectFilter === null ? "nav-item active" : "nav-item"}
                onClick={() => setProjectFilter(null)}
              >
                <Icon name="layers" size={15} />
                <span>All projects</span>
              </button>
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  title={project.path}
                  className={projectFilter === project.id ? "nav-item active" : "nav-item"}
                  onClick={() => setProjectFilter(project.id)}
                >
                  <Icon name="folder" size={15} />
                  <span>{project.name}</span>
                </button>
              ))}
            </>
          )}
        </nav>

        <nav className="nav-section agents">
          <div className="nav-label">
            Agents
            <span className="nav-label-meta">
              {installedAgents}/{agents.length} ready
            </span>
          </div>
          {agents.map((agent) => (
            <div
              key={agent.id}
              className={agent.installed ? "agent-row" : "agent-row unavailable"}
              title={agent.detail}
            >
              <span className={agent.installed ? "dot tone-success" : "dot tone-muted"} />
              <span className="agent-row-name">{agent.name}</span>
              <span className="agent-row-runtime">
                {agent.installed ? agent.runtime : "not installed"}
              </span>
            </div>
          ))}
        </nav>

        <footer className="sidebar-footer">
          <span className={connected ? "dot tone-success" : "dot tone-danger"} />
          {connected ? `Daemon connected${version ? ` · v${version}` : ""}` : "Daemon offline"}
        </footer>
      </aside>

      <section className="list-pane">
        <header className="list-header">
          <div>
            <h2>{FILTERS.find((item) => item.id === filter)?.label}</h2>
            <p className="muted">
              {projectFilter ? projectName(projects, projectFilter) : "All projects"} ·{" "}
              {visible.length} {visible.length === 1 ? "thread" : "threads"}
            </p>
          </div>
        </header>
        <div className="list-scroll">
          {!loaded ? (
            <div className="empty-inline">
              <Spinner size={18} />
              <p>Connecting to the daemon</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-inline">
              <Icon name="inbox" size={20} />
              <p>{threads.length === 0 ? "No threads yet." : "Nothing here right now."}</p>
            </div>
          ) : (
            GROUPS.map((group) => {
              const rows = visible.filter((thread) => group.statuses.includes(thread.status));
              if (rows.length === 0) return null;
              return (
                <div className="group" key={group.id}>
                  <div className="group-label">
                    {group.label}
                    <span>{rows.length}</span>
                  </div>
                  {rows.map((thread) => {
                    const meta = STATUS_META[thread.status];
                    return (
                      <button
                        type="button"
                        key={thread.id}
                        className={[
                          "thread-row",
                          `tone-${meta.tone}`,
                          thread.id === selectedId ? "selected" : "",
                        ].join(" ")}
                        onClick={() => setSelectedId(thread.id)}
                      >
                        <span className="thread-row-top">
                          <span className="thread-row-title">{thread.title}</span>
                          <span className="thread-row-time">
                            {relativeTime(thread.updatedAt, now)}
                          </span>
                        </span>
                        <span className="thread-row-bottom">
                          <span className={`pill small tone-${meta.tone}`}>
                            {thread.status === "running" || thread.status === "starting" ? (
                              <Spinner size={8} />
                            ) : (
                              <span className="dot" />
                            )}
                            {meta.label}
                          </span>
                          <span className="thread-row-meta">
                            {agentName(agents, thread.agentId)} ·{" "}
                            {projectName(projects, thread.projectId)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </section>

      <main className="detail-pane">
        {!connected && loaded && threads.length === 0 ? (
          <Welcome
            icon="alert"
            title="Can't reach the daemon"
            text="agent-hub runs a small local daemon on 127.0.0.1. Restart the app to start it again."
          />
        ) : selected ? (
          <ThreadView
            key={selected.id}
            thread={selected}
            project={projects.find((project) => project.id === selected.projectId)}
            agentName={agentName(agents, selected.agentId)}
            now={now}
            onEvent={onEvent}
            notify={notify}
          />
        ) : loaded && projects.length === 0 ? (
          <Welcome
            icon="layers"
            title="Welcome to agent-hub"
            text="Run coding agents side by side. Each task gets its own git worktree, and nothing touches your checkout until you accept it."
            steps={[
              { label: "Add a project", done: false },
              { label: "Start a task with any installed agent", done: false },
              { label: "Review the diff, then accept or discard", done: false },
            ]}
            action={{ label: "Add a project", onClick: () => setDialog("project") }}
          />
        ) : loaded ? (
          <Welcome
            icon="sparkle"
            title={threads.length === 0 ? "Start your first task" : "Pick a thread"}
            text={
              threads.length === 0
                ? "Describe what you want done, choose an agent, and it starts in its own worktree."
                : "Select a thread on the left to see its activity and changes."
            }
            action={
              threads.length === 0 ? { label: "New task", onClick: openNewThread } : undefined
            }
          />
        ) : null}
      </main>

      {dialog === "thread" ? (
        <NewThreadDialog
          projects={projects}
          agents={agents}
          initialProjectId={projectFilter}
          notify={notify}
          onClose={() => setDialog(null)}
          onAddProject={() => {
            setReturnToThread(true);
            setDialog("project");
          }}
          onCreated={(thread) => {
            setThreads((current) => upsertThread(current, thread));
            setSelectedId(thread.id);
            setFilter("all");
            setDialog(null);
            notify(`Started “${thread.title}”`, "success");
          }}
        />
      ) : null}
      {dialog === "project" ? (
        <AddProjectDialog
          notify={notify}
          onClose={() => {
            setDialog(returnToThread && projects.length > 0 ? "thread" : null);
            setReturnToThread(false);
          }}
          onAdded={(project) => {
            setProjects((current) => [
              ...current.filter((item) => item.id !== project.id),
              project,
            ]);
            notify(`Added ${project.name}`, "success");
            setDialog(returnToThread ? "thread" : null);
            setReturnToThread(false);
          }}
        />
      ) : null}

      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <Icon
              name={
                toast.tone === "error" ? "alert" : toast.tone === "success" ? "check" : "sparkle"
              }
              size={15}
            />
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Welcome({
  icon,
  title,
  text,
  steps,
  action,
}: {
  icon: IconName;
  title: string;
  text: string;
  steps?: { label: string; done: boolean }[];
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="welcome">
      <span className="welcome-icon">
        <Icon name={icon} size={22} />
      </span>
      <h1>{title}</h1>
      <p>{text}</p>
      {steps ? (
        <ol className="steps">
          {steps.map((step, index) => (
            <li key={step.label}>
              <span className="step-number">{index + 1}</span>
              {step.label}
            </li>
          ))}
        </ol>
      ) : null}
      {action ? (
        <button type="button" className="button primary" onClick={action.onClick}>
          <Icon name="plus" />
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
