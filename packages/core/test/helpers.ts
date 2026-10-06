import { execFile as callbackExecFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Project } from "../src/types.js";
import { createId } from "../src/types.js";

const execFile = promisify(callbackExecFile);

export async function makeGitProject(): Promise<{
  root: string;
  project: Project;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-hub-test-"));
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: root });
  await execFile("git", ["commit", "-m", "initial"], { cwd: root });
  return {
    root,
    project: {
      id: createId(),
      name: "fixture",
      path: root,
      createdAt: new Date().toISOString(),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function waitFor<T>(
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
