import type { AgentSummary, Project, Thread, ThreadEvent } from "@agent-hub/core";

export interface ApiBridge {
  baseUrl: string;
  token: string;
  pickFolder(): Promise<string | null>;
}

declare global {
  interface Window {
    hub: ApiBridge;
  }
}

function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return fetch(`${window.hub.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${window.hub.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }).then(async (response) => {
    const payload = (await response.json()) as T | { error: string };
    if (!response.ok) {
      const error =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `Request failed: ${response.status}`;
      throw new Error(error);
    }
    return payload as T;
  });
}

export const getHealth = () => request<{ ok: boolean; version: string }>("/api/health");
export const getAgents = () => request<AgentSummary[]>("/api/agents");
export const getProjects = () => request<Project[]>("/api/projects");
export const addProject = (path: string, name?: string) =>
  request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path, ...(name ? { name } : {}) }),
  });
export const getThreads = (filters: { status?: string; projectId?: string } = {}) => {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.projectId) params.set("projectId", filters.projectId);
  const suffix = params.size ? `?${params}` : "";
  return request<Thread[]>(`/api/threads${suffix}`);
};
export const createThread = (input: {
  kind: string;
  projectId: string;
  agentId: string;
  prompt: string;
  model?: string;
  title?: string;
}) => request<Thread>("/api/threads", { method: "POST", body: JSON.stringify(input) });
export const getThread = (id: string) =>
  request<{ thread: Thread; events: ThreadEvent[] }>(`/api/threads/${encodeURIComponent(id)}`);
export const sendMessage = (id: string, text: string) =>
  request<Thread>(`/api/threads/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
export const answerPermission = (id: string, requestId: string, optionId: string | null) =>
  request<Thread>(`/api/threads/${encodeURIComponent(id)}/permission`, {
    method: "POST",
    body: JSON.stringify({ requestId, optionId }),
  });
export const cancelThread = (id: string) =>
  request<Thread>(`/api/threads/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  });
export const getDiff = (id: string) =>
  request<{
    files: { path: string; status: string; additions: number; deletions: number }[];
    patch: string;
  }>(`/api/threads/${encodeURIComponent(id)}/diff`);
export const acceptThread = (id: string, message?: string) =>
  request<Thread>(`/api/threads/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    body: JSON.stringify(message ? { message } : {}),
  });
export const discardThread = (id: string) =>
  request<Thread>(`/api/threads/${encodeURIComponent(id)}/discard`, {
    method: "POST",
    body: "{}",
  });

export function subscribe(onEvent: (name: string, data: unknown) => void): () => void {
  const url = new URL("/api/events", window.hub.baseUrl);
  url.searchParams.set("token", window.hub.token);
  const source = new EventSource(url);
  const eventNames = ["thread_updated", "thread_event"] as const;
  for (const name of eventNames) {
    source.addEventListener(name, (event) => {
      onEvent(name, JSON.parse((event as MessageEvent<string>).data) as unknown);
    });
  }
  return () => source.close();
}
