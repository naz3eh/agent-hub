import assert from "node:assert/strict";
import { execFile as callbackExecFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createDaemon, listenPort } from "../src/server.js";

const execFile = promisify(callbackExecFile);

function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const poll = async () => {
      const value = await read();
      if (predicate(value)) {
        resolveWait(value);
        return;
      }
      if (Date.now() - started >= timeout) {
        reject(new Error(`Timed out; latest value: ${JSON.stringify(value)}`));
        return;
      }
      setTimeout(poll, 20);
    };
    void poll();
  });
}

test("daemon routes, concurrent worktrees, permissions, SSE, review, and restart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-hub-daemon-project-"));
  const home = await mkdtemp(join(tmpdir(), "agent-hub-daemon-home-"));
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: root });
  await execFile("git", ["commit", "-m", "initial"], { cwd: root });

  let daemon = await createDaemon({ home, port: 0, dev: true });
  const base = `http://127.0.0.1:${listenPort(daemon.server)}`;
  const token = daemon.token;
  const request = async (path: string, method = "GET", body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    const badKind = await request("/api/threads", "POST", {
      kind: "chat",
      projectId: "none",
      agentId: "mock",
      prompt: "chat",
    });
    assert.equal(badKind.status, 400);
    assert.deepEqual(await badKind.json(), { error: "kind_not_enabled" });
    const badProject = await request("/api/projects", "POST", { path: join(home, "not-a-repo") });
    assert.equal(badProject.status, 400);

    const added = await request("/api/projects", "POST", { path: root });
    assert.equal(added.status, 201);
    const project = (await added.json()) as { id: string; path: string };
    assert.equal(project.path, root);

    const eventResponse = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`);
    assert.equal(eventResponse.status, 200);
    const reader = eventResponse.body!.getReader();
    const events: string[] = [];
    let reading = true;
    const readEvents = (async () => {
      const decoder = new TextDecoder();
      while (reading) {
        const result = await reader.read();
        if (result.done) break;
        events.push(decoder.decode(result.value));
      }
    })();

    const starts = await Promise.all(
      ["parallel one", "ask parallel approval", "parallel three"].map((prompt) =>
        request("/api/threads", "POST", {
          kind: "project_task",
          projectId: project.id,
          agentId: "mock",
          prompt,
        }),
      ),
    );
    assert.ok(starts.every((response) => response.status === 201));
    const threads = (await Promise.all(starts.map((response) => response.json()))) as {
      id: string;
      worktreePath: string;
    }[];
    assert.equal(new Set(threads.map((thread) => thread.worktreePath)).size, 3);

    const getThread = async (id: string) =>
      (await (await request(`/api/threads/${encodeURIComponent(id)}`)).json()) as {
        thread: { status: string; error: string | null };
        events: { type: string; data: { requestId?: string } }[];
      };
    const askThread = threads[1]!;
    await waitFor(
      async () => (await getThread(askThread.id)).thread.status,
      (status) => status === "needs_you",
    );
    const askState = await getThread(askThread.id);
    const permission = askState.events.find((event) => event.type === "permission_request")!;
    const approved = await request(`/api/threads/${askThread.id}/permission`, "POST", {
      requestId: permission.data.requestId,
      optionId: "allow_once",
    });
    assert.equal(approved.status, 200);
    await Promise.all(
      [threads[0]!, threads[2]!, askThread].map((thread) =>
        waitFor(
          async () => (await getThread(thread.id)).thread.status,
          (status) => status === "ready_for_review",
        ),
      ),
    );
    await waitFor(() => events.join("").includes("ready_for_review"), Boolean);
    assert.ok(events.some((event) => event.includes("thread_updated")));
    assert.ok(events.some((event) => event.includes("ready_for_review")));

    const diff = await request(`/api/threads/${threads[0]!.id}/diff`);
    assert.equal(diff.status, 200);
    assert.ok(((await diff.json()) as { files: unknown[] }).files.length > 0);
    assert.equal((await request(`/api/threads/${threads[0]!.id}/accept`, "POST", {})).status, 200);
    assert.equal((await request(`/api/threads/${threads[2]!.id}/discard`, "POST", {})).status, 200);

    const slowResponse = await request("/api/threads", "POST", {
      kind: "project_task",
      projectId: project.id,
      agentId: "mock",
      prompt: "slow while daemon restarts",
    });
    const slow = (await slowResponse.json()) as { id: string };
    await waitFor(
      async () => (await getThread(slow.id)).thread.status,
      (status) => status === "running",
    );

    reading = false;
    await reader.cancel();
    await readEvents;
    await daemon.close();
    daemon = await createDaemon({ home, port: 0, dev: true });
    const restartedBase = `http://127.0.0.1:${listenPort(daemon.server)}`;
    const restarted = await fetch(`${restartedBase}/api/threads/${slow.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const recovered = (await restarted.json()) as {
      thread: { status: string; error: string | null };
    };
    assert.equal(recovered.thread.status, "stopped");
    assert.equal(recovered.thread.error, "daemon_restarted");
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
