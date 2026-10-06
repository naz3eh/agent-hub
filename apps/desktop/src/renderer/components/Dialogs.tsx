import type { AgentSummary, Project, Thread } from "@agent-hub/core";
import { useState } from "react";
import { addProject, createThread } from "../api.js";
import { errorText } from "../ui.js";
import { Icon, type IconName, Spinner } from "./Icon.js";
import { Modal } from "./Modal.js";

type Notify = (text: string, tone?: "info" | "success" | "error") => void;

const KINDS: { id: string; label: string; icon: IconName; enabled: boolean }[] = [
  { id: "project_task", label: "Project task", icon: "layers", enabled: true },
  { id: "chat", label: "Chat", icon: "chat", enabled: false },
  { id: "workflow", label: "Workflow", icon: "workflow", enabled: false },
];

export function NewThreadDialog({
  projects,
  agents,
  initialProjectId,
  onClose,
  onCreated,
  onAddProject,
  notify,
}: {
  projects: Project[];
  agents: AgentSummary[];
  initialProjectId: string | null;
  onClose: () => void;
  onCreated: (thread: Thread) => void;
  onAddProject: () => void;
  notify: Notify;
}) {
  const firstInstalled = agents.find((agent) => agent.installed)?.id ?? "";
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState(firstInstalled);
  const [submitting, setSubmitting] = useState(false);
  const ready = Boolean(prompt.trim() && projectId && agentId) && !submitting;

  async function submit() {
    if (!ready) return;
    setSubmitting(true);
    try {
      const thread = await createThread({
        kind: "project_task",
        projectId,
        agentId,
        prompt: prompt.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      onCreated(thread);
    } catch (error) {
      notify(errorText(error), "error");
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="New task"
      subtitle="The agent works in its own git worktree, so your checkout stays untouched."
      onClose={onClose}
      onSubmit={() => void submit()}
      wide
      footer={
        <>
          <span className="hint">
            <kbd>Ctrl</kbd>
            <kbd>Enter</kbd> to start
          </span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!ready}>
            {submitting ? <Spinner /> : <Icon name="sparkle" />}
            Start task
          </button>
        </>
      }
    >
      <div className="segmented">
        {KINDS.map((kind) => (
          <button
            type="button"
            key={kind.id}
            disabled={!kind.enabled}
            className={kind.enabled ? "segment active" : "segment"}
            title={kind.enabled ? undefined : "Coming in a later phase"}
          >
            <Icon name={kind.icon} size={14} />
            {kind.label}
            {kind.enabled ? null : <span className="soon">Soon</span>}
          </button>
        ))}
      </div>

      <label className="field">
        <span className="field-label">What should the agent do?</span>
        <textarea
          data-autofocus
          rows={4}
          value={prompt}
          placeholder="Fix the flaky login test and explain the root cause"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Project</span>
          <div className="select-row">
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.length === 0 ? <option value="">Add a project first</option> : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button icon-only"
              aria-label="Add project"
              title="Add project"
              onClick={onAddProject}
            >
              <Icon name="plus" />
            </button>
          </div>
        </label>
        <label className="field">
          <span className="field-label">Title (optional)</span>
          <input
            value={title}
            placeholder="Defaults to the first line"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
      </div>

      <fieldset className="field">
        <legend className="field-label">Agent</legend>
        <div className="agent-grid">
          {agents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              disabled={!agent.installed}
              className={agentId === agent.id ? "agent-option selected" : "agent-option"}
              onClick={() => setAgentId(agent.id)}
              title={agent.installed ? undefined : agent.detail}
            >
              <span className={agent.installed ? "dot tone-success" : "dot tone-muted"} />
              <span className="agent-option-name">{agent.name}</span>
              <span className="agent-option-detail">
                {agent.installed ? "Ready" : "Not installed"}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span className="field-label">Model (optional)</span>
        <input
          value={model}
          placeholder="Agent default"
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
    </Modal>
  );
}

export function AddProjectDialog({
  onClose,
  onAdded,
  notify,
}: {
  onClose: () => void;
  onAdded: (project: Project) => void;
  notify: Notify;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function browse() {
    const picked = await window.hub.pickFolder();
    if (picked) setPath(picked);
  }

  async function submit() {
    if (!path.trim() || submitting) return;
    setSubmitting(true);
    try {
      onAdded(await addProject(path.trim(), name.trim() || undefined));
    } catch (error) {
      notify(errorText(error), "error");
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Add a project"
      subtitle="Pick a local git repository with at least one commit."
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!path.trim() || submitting}>
            {submitting ? <Spinner /> : <Icon name="plus" />}
            Add project
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Folder</span>
        <div className="select-row">
          <input
            data-autofocus
            className="mono"
            value={path}
            placeholder="/path/to/your/repo"
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="button" className="button" onClick={() => void browse()}>
            <Icon name="folder" />
            Browse
          </button>
        </div>
      </label>
      <label className="field">
        <span className="field-label">Name (optional)</span>
        <input
          value={name}
          placeholder="Defaults to the folder name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
    </Modal>
  );
}
