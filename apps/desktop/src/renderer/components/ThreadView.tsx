import type { Project, Thread, ThreadEvent } from "@agent-hub/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  acceptThread,
  answerPermission,
  cancelThread,
  discardThread,
  getDiff,
  getThread,
  sendMessage,
} from "../api.js";
import {
  buildTranscript,
  type DiffFile,
  errorText,
  isActive,
  isClosed,
  relativeTime,
  STATUS_META,
  type TranscriptItem,
} from "../ui.js";
import { DiffView } from "./DiffView.js";
import { Icon, Spinner } from "./Icon.js";

type Notify = (text: string, tone?: "info" | "success" | "error") => void;

export function ThreadView({
  thread,
  project,
  agentName,
  now,
  onEvent,
  notify,
}: {
  thread: Thread;
  project: Project | undefined;
  agentName: string;
  now: number;
  onEvent: (listener: (event: ThreadEvent) => void) => () => void;
  notify: Notify;
}) {
  const threadId = thread.id;
  const status = thread.status;
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [tab, setTab] = useState<"activity" | "changes">("activity");
  const [diff, setDiff] = useState<{ files: DiffFile[]; patch: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        pending.current = false;
        const result = await getThread(threadId);
        setEvents(result.events);
      } while (pending.current);
    } catch {
      // The next event or status change triggers another refresh.
    } finally {
      inFlight.current = false;
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
    return onEvent((event) => {
      if (event.threadId === threadId) void refresh();
    });
  }, [onEvent, refresh, threadId]);

  const hasWorktree = Boolean(thread.worktreePath) && !isClosed(status);
  const loadDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      setDiff(await getDiff(threadId));
    } catch {
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (hasWorktree && (tab === "changes" || status === "ready_for_review")) void loadDiff();
  }, [hasWorktree, tab, status, loadDiff]);

  useEffect(() => {
    if (!confirmDiscard) return;
    const timer = setTimeout(() => setConfirmDiscard(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDiscard]);

  const items = useMemo(() => buildTranscript(events), [events]);
  const lastItem = items.at(-1);
  const transcriptSize = items.length + (lastItem && "text" in lastItem ? lastItem.text.length : 0);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || transcriptSize === 0 || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [transcriptSize]);

  async function run(label: string, action: () => Promise<unknown>, success?: string) {
    setBusy(label);
    try {
      await action();
      if (success) notify(success, "success");
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setBusy(null);
    }
  }

  const meta = STATUS_META[status];
  const working = status === "starting" || status === "running";
  const canSend = status === "ready_for_review";
  const fileCount = diff?.files.length ?? 0;

  function submitDraft() {
    const text = draft.trim();
    if (!text || !canSend || busy) return;
    void run("send", async () => {
      await sendMessage(threadId, text);
      setDraft("");
    });
  }

  return (
    <section className="detail">
      <header className="detail-header">
        <div className="detail-title-row">
          <h1 title={thread.title}>{thread.title}</h1>
          <span className={`pill tone-${meta.tone}`}>
            {working ? <Spinner size={10} /> : <span className="dot" />}
            {meta.label}
          </span>
        </div>
        <div className="detail-meta">
          <span>
            <Icon name="cpu" size={13} />
            {agentName}
            {thread.model ? <span className="muted"> · {thread.model}</span> : null}
          </span>
          <span>
            <Icon name="folder" size={13} />
            {project?.name ?? "No project"}
          </span>
          {thread.branch ? (
            <span className="mono">
              <Icon name="branch" size={13} />
              {thread.branch}
            </span>
          ) : null}
          <span className="muted">Started {relativeTime(thread.createdAt, now)}</span>
        </div>
        <div className="detail-actions">
          {isActive(status) ? (
            <button
              type="button"
              className="button"
              disabled={busy !== null}
              onClick={() => void run("stop", () => cancelThread(threadId), "Stopped the agent")}
            >
              {busy === "stop" ? <Spinner /> : <Icon name="stop" />}
              Stop
            </button>
          ) : null}
          {!isClosed(status) ? (
            <button
              type="button"
              className={confirmDiscard ? "button danger-solid" : "button danger"}
              disabled={busy !== null}
              onClick={() => {
                if (!confirmDiscard) {
                  setConfirmDiscard(true);
                  return;
                }
                setConfirmDiscard(false);
                void run(
                  "discard",
                  () => discardThread(threadId),
                  "Discarded. The worktree and branch were removed.",
                );
              }}
            >
              {busy === "discard" ? <Spinner /> : <Icon name="trash" />}
              {confirmDiscard ? "Click again to discard" : "Discard"}
            </button>
          ) : null}
          {status === "ready_for_review" ? (
            <button
              type="button"
              className="button primary"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "accept",
                  () => acceptThread(threadId),
                  `Merged into ${project?.name ?? "the project"}`,
                )
              }
            >
              {busy === "accept" ? <Spinner /> : <Icon name="merge" />}
              Accept and merge
            </button>
          ) : null}
        </div>
      </header>

      {thread.error && (status === "failed" || status === "stopped") ? (
        <div className={status === "failed" ? "banner banner-danger" : "banner"}>
          <Icon name="alert" />
          <span>
            {thread.error === "daemon_restarted"
              ? "The daemon restarted while this thread was running."
              : thread.error}
          </span>
        </div>
      ) : null}

      <nav className="tabs">
        <button
          type="button"
          className={tab === "activity" ? "tab active" : "tab"}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        <button
          type="button"
          className={tab === "changes" ? "tab active" : "tab"}
          onClick={() => setTab("changes")}
        >
          Changes
          {fileCount > 0 && hasWorktree ? <span className="tab-count">{fileCount}</span> : null}
        </button>
        {tab === "changes" && hasWorktree ? (
          <button
            type="button"
            className="icon-button tab-refresh"
            aria-label="Refresh changes"
            onClick={() => void loadDiff()}
          >
            {diffLoading ? <Spinner /> : <Icon name="refresh" size={14} />}
          </button>
        ) : null}
      </nav>

      <div
        className="detail-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {tab === "activity" ? (
          <div className="transcript">
            {items.map((item) => (
              <TranscriptRow
                key={item.key}
                item={item}
                agentName={agentName}
                now={now}
                waiting={status === "needs_you"}
                busy={busy !== null}
                onAnswer={(requestId, optionId) =>
                  void run("permission", () => answerPermission(threadId, requestId, optionId))
                }
              />
            ))}
            {working ? (
              <div className="typing">
                <span />
                <span />
                <span />
                <em>{agentName} is working</em>
              </div>
            ) : null}
          </div>
        ) : isClosed(status) ? (
          <div className="empty-inline">
            <Icon name={status === "accepted" ? "merge" : "trash"} size={20} />
            <p>
              {status === "accepted"
                ? `These changes were merged into ${project?.name ?? "the project"}.`
                : "This thread was discarded. Its worktree and branch were removed."}
            </p>
          </div>
        ) : diff ? (
          <DiffView files={diff.files} patch={diff.patch} />
        ) : (
          <div className="empty-inline">
            {diffLoading ? <Spinner size={18} /> : <Icon name="file" size={20} />}
            <p>{diffLoading ? "Loading changes" : "No changes to show yet."}</p>
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <textarea
          value={draft}
          rows={1}
          disabled={!canSend}
          placeholder={
            canSend
              ? `Send a follow-up to ${agentName}…`
              : isClosed(status)
                ? "This thread is closed."
                : status === "needs_you"
                  ? "Answer the request above to continue."
                  : working
                    ? `${agentName} is working. You can reply when it's done.`
                    : "This agent session has ended."
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
        <button
          type="submit"
          className="button primary icon-only"
          disabled={!canSend || !draft.trim() || busy !== null}
          aria-label="Send"
        >
          {busy === "send" ? <Spinner /> : <Icon name="send" />}
        </button>
      </form>
    </section>
  );
}

function TranscriptRow({
  item,
  agentName,
  now,
  waiting,
  busy,
  onAnswer,
}: {
  item: TranscriptItem;
  agentName: string;
  now: number;
  waiting: boolean;
  busy: boolean;
  onAnswer: (requestId: string, optionId: string | null) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="message message-user">
          <div className="message-head">
            <strong>You</strong>
            <span className="muted">{relativeTime(item.at, now)}</span>
          </div>
          <p>{item.text}</p>
        </div>
      );
    case "agent":
      return (
        <div className="message message-agent">
          <div className="message-head">
            <span className="avatar">
              <Icon name="sparkle" size={12} />
            </span>
            <strong>{agentName}</strong>
          </div>
          <p>{item.text}</p>
        </div>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>
            <Icon name="brain" size={13} />
            Thinking
          </summary>
          <p>{item.text}</p>
        </details>
      );
    case "plan":
      return (
        <div className="card plan">
          <div className="card-title">
            <Icon name="list" size={14} />
            Plan
          </div>
          <ul>
            {item.entries.map((entry) => (
              <li key={entry.content} className={`plan-${entry.status ?? "pending"}`}>
                <span className="plan-check">
                  {entry.status === "completed" ? <Icon name="check" size={11} /> : null}
                </span>
                {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "tool":
      return (
        <div className={`tool tool-${item.status}`}>
          <span className="tool-icon">
            {item.status === "completed" ? (
              <Icon name="check" size={12} />
            ) : item.status === "failed" ? (
              <Icon name="x" size={12} />
            ) : (
              <Spinner size={11} />
            )}
          </span>
          <Icon name="tool" size={13} />
          <span>{item.title}</span>
          {item.toolKind ? <span className="chip">{item.toolKind}</span> : null}
        </div>
      );
    case "permission": {
      const open = item.answer === undefined && waiting;
      const chosen = item.request.options.find((option) => option.optionId === item.answer);
      return (
        <div className={open ? "card permission permission-open" : "card permission"}>
          <div className="card-title">
            <Icon name="shield" size={14} />
            {open ? `${agentName} needs your permission` : "Permission request"}
          </div>
          <p>
            <span className="muted">Wants to run:</span>{" "}
            <strong>{item.request.toolCall.title}</strong>
            {item.request.toolCall.kind ? (
              <span className="chip">{item.request.toolCall.kind}</span>
            ) : null}
          </p>
          {open ? (
            <div className="permission-actions">
              {item.request.options.map((option) => (
                <button
                  type="button"
                  key={option.optionId}
                  disabled={busy}
                  className={option.kind.startsWith("allow") ? "button primary" : "button"}
                  onClick={() => onAnswer(item.request.requestId, option.optionId)}
                >
                  {option.kind.startsWith("allow") ? <Icon name="check" /> : <Icon name="x" />}
                  {option.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="permission-answer">
              {item.answer === undefined
                ? "No longer waiting."
                : chosen
                  ? `You chose “${chosen.name}”.`
                  : "Dismissed."}
            </p>
          )}
        </div>
      );
    }
    case "status": {
      const meta = STATUS_META[item.status];
      return (
        <div className={`status-divider tone-${meta.tone}`}>
          <span>
            {meta.label}
            {item.error ? ` · ${item.error}` : ""}
          </span>
        </div>
      );
    }
  }
}
