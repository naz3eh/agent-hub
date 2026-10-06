import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentCatalog, Hub, Store, WorktreeManager } from "../src/index.js";
import { makeGitProject, waitFor } from "./helpers.js";

test("mock ACP streaming, permissions, path restrictions, failures, cancellation, and follow-up turns", async () => {
  const fixture = await makeGitProject();
  const home = await mkdtemp(join(tmpdir(), "agent-hub-acp-"));
  const store = new Store(join(home, "hub.db"));
  const hub = new Hub(store, new WorktreeManager(home), new AgentCatalog(home, true));
  const streamed: string[] = [];
  hub.on("thread_event", (event) => {
    if (event.type === "agent_message")
      streamed.push(String((event.data as { text: string }).text));
  });
  try {
    const project = hub.store.createProject(fixture.project);
    const start = (prompt: string) =>
      hub.startThread({ kind: "project_task", projectId: project.id, agentId: "mock", prompt });
    const first = await start("implement plain change");
    await waitFor(
      () => hub.getThread(first.id)?.thread,
      (thread) => thread?.status === "ready_for_review",
    );
    assert.ok(streamed.length >= 3);
    assert.match(streamed.join(""), /Working on: implement plain change/);
    await readFile(join(first.worktreePath!, "hub-mock", "1.md"), "utf8");
    await hub.send(first.id, "follow-up");
    await readFile(join(first.worktreePath!, "hub-mock", "2.md"), "utf8");
    const messages = hub
      .getThread(first.id)!
      .events.filter((event) => event.type === "agent_message")
      .map((event) => (event.data as { text: string }).text);
    assert.deepEqual(messages, ["Working on: implement plain change", "Working on: follow-up"]);

    const approved = await start("ask then write");
    await waitFor(
      () => hub.getThread(approved.id)?.thread,
      (thread) => thread?.status === "needs_you",
    );
    const request = hub
      .getThread(approved.id)!
      .events.find((event) => event.type === "permission_request")!.data as { requestId: string };
    await hub.answerPermission(approved.id, request.requestId, "allow_once");
    await waitFor(
      () => hub.getThread(approved.id)?.thread,
      (thread) => thread?.status === "ready_for_review",
    );
    await readFile(join(approved.worktreePath!, "hub-mock", "1.md"), "utf8");

    const rejected = await start("ask and reject this write");
    await waitFor(
      () => hub.getThread(rejected.id)?.thread,
      (thread) => thread?.status === "needs_you",
    );
    const rejectedRequest = hub
      .getThread(rejected.id)!
      .events.find((event) => event.type === "permission_request")!.data as { requestId: string };
    await hub.answerPermission(rejected.id, rejectedRequest.requestId, "reject_once");
    await waitFor(
      () => hub.getThread(rejected.id)?.thread,
      (thread) => thread?.status === "ready_for_review",
    );
    await assert.rejects(readFile(join(rejected.worktreePath!, "hub-mock", "1.md")), {
      code: "ENOENT",
    });

    const priorOutsideFiles = new Set(
      (await readdir("/tmp")).filter((path) => path.startsWith("outside-")),
    );
    const escapeThread = await start("escape worktree");
    await waitFor(
      () => hub.getThread(escapeThread.id)?.thread,
      (thread) => thread?.status === "failed",
    );
    assert.deepEqual(
      (await readdir("/tmp")).filter(
        (path) => path.startsWith("outside-") && !priorOutsideFiles.has(path),
      ),
      [],
    );

    const failure = await start("fail this turn");
    await waitFor(
      () => hub.getThread(failure.id)?.thread,
      (thread) => thread?.status === "failed",
    );

    const slow = await start("slow operation");
    await waitFor(
      () => hub.getThread(slow.id)?.thread,
      (thread) => thread?.status === "running",
    );
    await hub.cancel(slow.id);
    await waitFor(
      () => hub.getThread(slow.id)?.thread,
      (thread) => thread?.status === "stopped",
    );
  } finally {
    await hub.dispose();
    store.close();
    await fixture.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("catalog detects missing agent binaries from PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-hub-catalog-"));
  const originalPath = process.env.PATH;
  process.env.PATH = home;
  try {
    const agents = await new AgentCatalog(home).list();
    assert.ok(agents.length >= 4);
    assert.ok(agents.every((agent) => !agent.installed));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(home, { recursive: true, force: true });
  }
});
