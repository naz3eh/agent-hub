import assert from "node:assert/strict";
import { execFile as callbackExecFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createId, WorktreeConflictError, WorktreeManager } from "../src/index.js";
import type { Thread } from "../src/types.js";
import { makeGitProject } from "./helpers.js";

const execFile = promisify(callbackExecFile);

test("worktree diff, dirty-tree refusal, accept merge, and discard", async () => {
  const fixture = await makeGitProject();
  const home = await mkdtemp(join(tmpdir(), "agent-hub-worktrees-"));
  const manager = new WorktreeManager(home);
  const now = new Date().toISOString();
  const makeThread = (): Thread => ({
    id: createId(),
    kind: "project_task",
    title: "change files",
    projectId: fixture.project.id,
    agentId: "mock",
    model: null,
    runtime: "local",
    status: "ready_for_review",
    worktreePath: null,
    branch: null,
    baseRef: null,
    externalId: null,
    error: null,
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
  });
  try {
    const baseRef = (await manager.validateProjectPath(fixture.root)).head;
    const accepted = makeThread();
    accepted.branch = `hub/${accepted.id}`;
    accepted.baseRef = baseRef;
    accepted.worktreePath = await manager.create(fixture.project, accepted, baseRef);
    await writeFile(join(accepted.worktreePath, "README.md"), "changed\n", "utf8");
    await writeFile(join(accepted.worktreePath, "new.txt"), "untracked line\n", "utf8");
    const diff = await manager.diff(accepted);
    assert.deepEqual(
      diff.files.map((file) => [file.path, file.status]),
      [
        ["README.md", "M"],
        ["new.txt", "A"],
      ],
    );
    assert.match(diff.patch, /changed/);
    assert.match(diff.patch, /new\.txt/);

    await writeFile(join(fixture.root, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(manager.accept(fixture.project, accepted), (error: unknown) => {
      assert.ok(error instanceof WorktreeConflictError);
      assert.equal(error.statusCode, 409);
      return true;
    });
    await rm(join(fixture.root, "dirty.txt"));
    await manager.accept(fixture.project, accepted);
    assert.equal(
      await execFile("git", ["show", "HEAD:README.md"], { cwd: fixture.root }).then(
        (r) => r.stdout,
      ),
      "changed\n",
    );
    await assert.rejects(access(accepted.worktreePath), { code: "ENOENT" });
    const mergeParents = (
      await execFile("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: fixture.root })
    ).stdout
      .trim()
      .split(" ");
    assert.equal(mergeParents.length, 3);

    const discarded = makeThread();
    discarded.branch = `hub/${discarded.id}`;
    discarded.baseRef = baseRef;
    discarded.worktreePath = await manager.create(fixture.project, discarded, baseRef);
    await manager.discard(fixture.project, discarded);
    await assert.rejects(access(discarded.worktreePath), { code: "ENOENT" });
    await assert.rejects(
      execFile("git", ["show-ref", "--verify", `refs/heads/${discarded.branch}`], {
        cwd: fixture.root,
      }),
    );
  } finally {
    await fixture.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});
