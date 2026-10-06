import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createId, Store } from "../src/index.js";
import type { Project, Thread } from "../src/types.js";

test("store CRUD, chunk merging, and event sequence ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hub-store-"));
  const store = new Store(join(directory, "hub.db"));
  try {
    const project: Project = {
      id: createId(),
      name: "sample",
      path: directory,
      createdAt: new Date().toISOString(),
    };
    store.createProject(project);
    assert.equal(store.getProject(project.id)?.name, "sample");
    assert.equal(store.listProjects().length, 1);

    const now = new Date().toISOString();
    const thread: Thread = {
      id: createId(),
      kind: "project_task",
      title: "sample task",
      projectId: project.id,
      agentId: "mock",
      model: null,
      runtime: "local",
      status: "starting",
      worktreePath: null,
      branch: "hub/sample",
      baseRef: null,
      externalId: null,
      error: null,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.createThread(thread);
    assert.equal(store.getThread(thread.id)?.title, "sample task");
    assert.equal(store.listThreads({ projectId: project.id }).length, 1);
    assert.equal(store.updateThread(thread.id, { status: "running" }).status, "running");
    const first = store.appendEvent(thread.id, "agent_message", { text: "Hello " });
    const merged = store.appendEvent(thread.id, "agent_message", { text: "world" });
    const next = store.appendEvent(thread.id, "tool_call", { title: "write" });
    assert.equal(first.seq, merged.seq);
    assert.deepEqual(merged.data, { text: "Hello world" });
    assert.equal(next.seq, merged.seq + 1);
    assert.deepEqual(
      store.listEvents(thread.id).map((event) => [event.seq, event.type]),
      [
        [1, "agent_message"],
        [2, "tool_call"],
      ],
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
