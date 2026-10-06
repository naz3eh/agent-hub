import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AdapterContext, AgentAdapter, AgentRun } from "./adapter.js";
import { detectBinary } from "./catalog.js";
import type { AgentAvailability, PermissionRequest } from "./types.js";
import { createId } from "./types.js";

export interface AcpAgentSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  detect: { bin: string };
  modelEnv?: string;
}

export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly runtime = "local" as const;

  constructor(private readonly spec: AcpAgentSpec) {
    this.id = spec.id;
    this.name = spec.name;
  }

  detect(): Promise<AgentAvailability> {
    return detectBinary(this.spec.detect.bin);
  }

  async start(context: AdapterContext): Promise<AgentRun> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.spec.env };
    if (context.thread.model && this.spec.modelEnv) env[this.spec.modelEnv] = context.thread.model;
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: context.cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (!child.stdin || !child.stdout) throw new Error("Unable to open ACP process pipes");
    const handlers = new ClientHandlers(context);
    const connection = acp
      .client({ name: "agent-hub" })
      .onRequest(acp.methods.client.session.requestPermission, (request) =>
        handlers.requestPermission(request.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (request) =>
        handlers.readTextFile(request.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (request) =>
        handlers.writeTextFile(request.params),
      )
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));

    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      const session = await connection.agent.buildSession(context.cwd).start();
      context.emit("status", { externalId: session.sessionId });
      let disposed = false;
      let currentTurn: Promise<void> | undefined;
      let cancelled = false;
      let cancelSent = false;
      const cancelTurn = async () => {
        if (cancelSent) return;
        cancelSent = true;
        await connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: session.sessionId,
        });
      };
      const markFailure = (error: unknown) => {
        if (disposed || cancelled || context.signal.aborted) return;
        context.setStatus("failed", error instanceof Error ? error.message : String(error));
      };
      child.once("error", markFailure);
      child.once("exit", (code, signal) => {
        if (!disposed && !cancelled && !context.signal.aborted) {
          markFailure(new Error(`ACP process exited (${signal ?? code ?? "unknown"})`));
        }
      });
      context.signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          void cancelTurn().catch(() => undefined);
        },
        { once: true },
      );
      currentTurn = this.runTurn(session, context, context.prompt);
      void currentTurn.catch(markFailure);

      return {
        send: async (text) => {
          if (disposed) throw new Error("Agent run is disposed");
          if (currentTurn) await currentTurn;
          if (context.signal.aborted) throw new Error("Thread has been cancelled");
          currentTurn = this.runTurn(session, context, text);
          await currentTurn;
        },
        cancel: async () => {
          if (disposed) return;
          cancelled = true;
          await cancelTurn();
        },
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          session.dispose();
          connection.close();
          child.kill();
        },
      };
    } catch (error) {
      connection.close(error);
      child.kill();
      throw error;
    }
  }

  private async runTurn(
    session: acp.ActiveSession,
    context: AdapterContext,
    prompt: string,
  ): Promise<void> {
    context.setStatus("running");
    const response = session.prompt(prompt);
    const failed = response.then(
      () => new Promise<never>(() => undefined),
      (error: unknown) => Promise.reject(error),
    );
    for (;;) {
      const message = await Promise.race([session.nextUpdate(), failed]);
      if (message.kind === "stop") {
        if (message.stopReason === "cancelled") context.setStatus("stopped");
        else if (context.signal.aborted) context.setStatus("stopped");
        else context.setStatus("ready_for_review");
        return;
      }
      const update = message.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") {
            context.emit("agent_message", { text: update.content.text });
          }
          break;
        case "agent_thought_chunk":
          if (update.content.type === "text") {
            context.emit("agent_thought", { text: update.content.text });
          }
          break;
        case "tool_call":
          context.emit("tool_call", update);
          break;
        case "tool_call_update":
          context.emit("tool_call_update", update);
          break;
        case "plan":
          context.emit("plan", update);
          break;
        default:
          break;
      }
    }
  }
}

class ClientHandlers {
  constructor(private readonly context: AdapterContext) {}

  async requestPermission(params: acp.ClientRequestParamsByMethod["session/request_permission"]) {
    const request: PermissionRequest = {
      requestId: createId(),
      toolCall: { title: params.toolCall.title ?? "Agent request" },
      options: params.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    };
    return this.context.requestPermission(request).then((optionId) => ({
      outcome: optionId
        ? { outcome: "selected" as const, optionId }
        : { outcome: "cancelled" as const },
    }));
  }

  async readTextFile(params: acp.ClientRequestParamsByMethod["fs/read_text_file"]) {
    const path = await this.safePath(params.path, false);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const selected = lines.slice(start, params.limit ? start + params.limit : undefined);
    return { content: selected.join("\n") };
  }

  async writeTextFile(params: acp.ClientRequestParamsByMethod["fs/write_text_file"]) {
    const path = await this.safePath(params.path, true);
    await mkdir(dirname(path), { recursive: true });
    const parent = await realpath(dirname(path));
    if (!isWithin(this.context.cwd, parent))
      throw new Error("File access outside the worktree is denied");
    await writeFile(path, params.content, "utf8");
    return {};
  }

  private async safePath(path: string, allowMissing: boolean): Promise<string> {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.context.cwd, path);
    if (!isWithin(this.context.cwd, absolute)) {
      throw new Error("File access outside the worktree is denied");
    }
    try {
      const canonical = await realpath(absolute);
      if (!isWithin(this.context.cwd, canonical)) {
        throw new Error("File access outside the worktree is denied");
      }
      return canonical;
    } catch (error) {
      if (!allowMissing) throw error;
      let existingParent = dirname(absolute);
      for (;;) {
        try {
          existingParent = await realpath(existingParent);
          break;
        } catch (parentError) {
          if (
            !(parentError instanceof Error) ||
            !("code" in parentError) ||
            parentError.code !== "ENOENT"
          ) {
            throw parentError;
          }
          const nextParent = dirname(existingParent);
          if (nextParent === existingParent) throw parentError;
          existingParent = nextParent;
        }
      }
      const parent = existingParent;
      if (!isWithin(this.context.cwd, parent)) {
        throw new Error("File access outside the worktree is denied");
      }
      return absolute;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}
