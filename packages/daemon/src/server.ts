import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hub, HubRequestError, type ThreadStatus } from "@agent-hub/core";

const VERSION = "0.1.0";

export interface DaemonOptions {
  home?: string;
  port?: number;
  dev?: boolean;
}

export interface RunningDaemon {
  server: Server;
  hub: Hub;
  token: string;
  home: string;
  close(): Promise<void>;
}

export async function createDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = options.home ?? process.env.AGENT_HUB_HOME ?? join(homedir(), ".agent-hub");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const token = await loadOrCreateToken(join(home, "token"));
  const { Store, WorktreeManager, AgentCatalog } = await import("@agent-hub/core");
  const store = new Store(join(home, "hub.db"));
  const worktrees = new WorktreeManager(home);
  const catalog = new AgentCatalog(home, options.dev ?? process.env.AGENT_HUB_DEV === "1");
  const hub = new Hub(store, worktrees, catalog);
  hub.markInterruptedThreadsStopped();
  const server = createServer((request, response) => {
    void route(request, response, hub, token).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof HttpError || error instanceof HubRequestError) {
        sendJson(response, error.statusCode, { error: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    });
  });
  const port = options.port ?? Number.parseInt(process.env.AGENT_HUB_PORT ?? "47321", 10);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closed = false;
  return {
    server,
    hub,
    token,
    home,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of sseClients) client.end();
      await hub.dispose();
      store.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function listenPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") return 0;
  return address.port;
}

const sseClients = new Set<ServerResponse>();

async function route(request: IncomingMessage, response: ServerResponse, hub: Hub, token: string) {
  setCors(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const eventSource = url.pathname === "/api/events";
  const authorized = eventSource
    ? url.searchParams.get("token") === token
    : hasBearerToken(request, token);
  if (!authorized) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, version: VERSION });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    sendJson(response, 200, await hub.listAgents());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, hub.listProjects());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(request);
    if (typeof body.path !== "string") throw new HttpError(400, "path_required");
    try {
      sendJson(
        response,
        201,
        await hub.addProject(body.path, typeof body.name === "string" ? body.name : undefined),
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_project");
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/threads") {
    const status = url.searchParams.get("status") ?? undefined;
    const projectId = url.searchParams.get("projectId") ?? undefined;
    sendJson(
      response,
      200,
      hub.listThreads({
        ...(status === undefined ? {} : { status: status as ThreadStatus }),
        ...(projectId === undefined ? {} : { projectId }),
      }),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/threads") {
    const body = await readJson(request);
    try {
      const thread = await hub.startThread({
        kind: String(body.kind) as never,
        projectId: String(body.projectId ?? ""),
        agentId: String(body.agentId ?? ""),
        prompt: String(body.prompt ?? ""),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
      });
      sendJson(response, 201, thread);
    } catch (error) {
      if (error instanceof HubRequestError) throw error;
      sendJson(response, 400, { error: "thread_start_failed" });
    }
    return;
  }
  if (request.method === "GET" && eventSource) {
    streamEvents(response, hub);
    return;
  }

  const match =
    /^\/api\/threads\/([^/]+)(?:\/(messages|permission|cancel|diff|accept|discard))?$/.exec(
      url.pathname,
    );
  if (!match) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  const id = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  try {
    if (!action && request.method === "GET") {
      const thread = hub.getThread(id);
      if (!thread) throw new HubRequestError(404, "thread_not_found");
      sendJson(response, 200, thread);
    } else if (action === "messages" && request.method === "POST") {
      const body = await readJson(request);
      if (typeof body.text !== "string") throw new HubRequestError(400, "text_required");
      sendJson(response, 200, await hub.send(id, body.text));
    } else if (action === "permission" && request.method === "POST") {
      const body = await readJson(request);
      if (typeof body.requestId !== "string") {
        throw new HubRequestError(400, "request_id_required");
      }
      if (body.optionId !== null && typeof body.optionId !== "string") {
        throw new HubRequestError(400, "option_id_required");
      }
      await hub.answerPermission(id, body.requestId, body.optionId);
      sendJson(response, 200, hub.getThread(id)?.thread);
    } else if (action === "cancel" && request.method === "POST") {
      sendJson(response, 200, await hub.cancel(id));
    } else if (action === "diff" && request.method === "GET") {
      sendJson(response, 200, await hub.diff(id));
    } else if (action === "accept" && request.method === "POST") {
      const body = await readOptionalJson(request);
      sendJson(
        response,
        200,
        await hub.accept(id, typeof body.message === "string" ? body.message : undefined),
      );
    } else if (action === "discard" && request.method === "POST") {
      sendJson(response, 200, await hub.discard(id));
    } else {
      sendJson(response, 404, { error: "not_found" });
    }
  } catch (error) {
    if (error instanceof HubRequestError) {
      sendJson(response, error.statusCode, { error: error.message });
    } else if (error instanceof Error && "statusCode" in error) {
      sendJson(response, Number(error.statusCode), { error: error.message });
    } else {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "internal_error" });
    }
  }
}

async function readOptionalJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-length"] && !request.headers["transfer-encoding"]) return {};
  if (request.method === "POST" && Number(request.headers["content-length"] ?? 0) === 0) return {};
  return readJson(request);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad body");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function streamEvents(response: ServerResponse, hub: Hub) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.write(": connected\n\n");
  const onThread = (thread: unknown) => writeEvent(response, "thread_updated", thread);
  const onEvent = (event: unknown) => writeEvent(response, "thread_event", event);
  hub.on("thread_updated", onThread);
  hub.on("thread_event", onEvent);
  sseClients.add(response);
  response.on("close", () => {
    hub.off("thread_updated", onThread);
    hub.off("thread_event", onEvent);
    sseClients.delete(response);
  });
}

function writeEvent(response: ServerResponse, name: string, data: unknown) {
  if (!response.destroyed) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function hasBearerToken(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function loadOrCreateToken(path: string): Promise<string> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    await chmod(path, 0o600);
    return token;
  } catch {
    const token = randomUUID() + randomUUID();
    try {
      await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      return (await readFile(path, "utf8")).trim();
    }
    return token;
  }
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
