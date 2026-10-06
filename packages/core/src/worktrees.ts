import { execFile as callbackExecFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Project, Thread } from "./types.js";

const execFile = promisify(callbackExecFile);

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface ThreadDiff {
  files: DiffFile[];
  patch: string;
}

export class WorktreeConflictError extends Error {
  readonly statusCode = 409;
}

export class WorktreeManager {
  constructor(private readonly home: string) {}

  async validateProjectPath(path: string): Promise<{ path: string; head: string }> {
    const absolute = resolve(path);
    try {
      const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: absolute });
      const root = resolve(stdout.trim());
      const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      return { path: root, head };
    } catch {
      throw new Error("Project path must be a git repository with at least one commit");
    }
  }

  async create(project: Project, thread: Thread, baseRef: string): Promise<string> {
    const directory = join(this.home, "worktrees", project.id, thread.id);
    await mkdir(join(this.home, "worktrees", project.id), { recursive: true });
    await execFile("git", ["worktree", "add", "-b", `hub/${thread.id}`, directory, baseRef], {
      cwd: project.path,
    });
    return directory;
  }

  async diff(thread: Thread): Promise<ThreadDiff> {
    if (!thread.worktreePath || !thread.baseRef) throw new Error("Thread has no worktree");
    const cwd = thread.worktreePath;
    const tracked = await execFile("git", ["diff", "--no-color", "--name-status", thread.baseRef], {
      cwd,
    });
    const trackedNumstat = await execFile("git", ["diff", "--numstat", thread.baseRef], { cwd });
    const files = new Map<string, DiffFile>();
    for (const line of tracked.stdout.split("\n").filter(Boolean)) {
      const [status = "M", ...pathParts] = line.split("\t");
      const path = pathParts.at(-1) ?? "";
      const stat = trackedNumstat.stdout.split("\n").find((item) => item.endsWith(`\t${path}`));
      const [added = "0", removed = "0"] = stat?.split("\t") ?? [];
      files.set(path, {
        path,
        status: status[0] ?? "M",
        additions: Number(added) || 0,
        deletions: Number(removed) || 0,
      });
    }
    const untrackedResult = await execFile(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd },
    );
    const untracked = untrackedResult.stdout.split("\0").filter(Boolean);
    const patches: string[] = [];
    const trackedPatch = await execFile("git", ["diff", "--no-color", thread.baseRef], { cwd });
    if (trackedPatch.stdout) patches.push(trackedPatch.stdout);
    for (const path of untracked) {
      const absolute = resolve(cwd, path);
      if (!isWithin(cwd, absolute)) continue;
      const result = await execFile(
        "git",
        ["diff", "--no-color", "--no-index", "--", "/dev/null", path],
        {
          cwd,
          encoding: "utf8",
        },
      ).catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || !error.stdout) throw error;
        return { stdout: error.stdout, stderr: error.stderr };
      });
      patches.push(result.stdout);
      const text = await readFile(absolute, "utf8");
      const additions =
        text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      files.set(path, { path, status: "A", additions, deletions: 0 });
    }
    return { files: [...files.values()], patch: patches.join("") };
  }

  async accept(project: Project, thread: Thread, message?: string): Promise<void> {
    if (!thread.worktreePath || !thread.branch) throw new Error("Thread has no worktree");
    const projectStatus = await execFile(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      {
        cwd: project.path,
      },
    );
    if (projectStatus.stdout.trim())
      throw new WorktreeConflictError("Project working tree is dirty");
    const worktreeStatus = await execFile(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: thread.worktreePath },
    );
    if (worktreeStatus.stdout.trim()) {
      await execFile("git", ["add", "-A"], { cwd: thread.worktreePath });
      await execFile("git", ["commit", "-m", `agent-hub: ${thread.title}`], {
        cwd: thread.worktreePath,
      });
    }
    try {
      await execFile(
        "git",
        ["merge", "--no-ff", thread.branch, "-m", message || `Merge ${thread.branch}`],
        { cwd: project.path },
      );
    } catch (error) {
      await execFile("git", ["merge", "--abort"], { cwd: project.path }).catch(() => undefined);
      throw new WorktreeConflictError(
        `Merge conflict while accepting thread: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.remove(project, thread);
  }

  async discard(project: Project, thread: Thread): Promise<void> {
    await this.remove(project, thread);
  }

  private async remove(project: Project, thread: Thread): Promise<void> {
    if (thread.worktreePath) {
      await execFile("git", ["worktree", "remove", "--force", thread.worktreePath], {
        cwd: project.path,
      });
    }
    if (thread.branch) {
      await execFile("git", ["branch", "-D", thread.branch], { cwd: project.path }).catch(
        () => undefined,
      );
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}
