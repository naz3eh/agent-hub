export type ThreadKind = "project_task" | "chat" | "cowork" | "workflow";
export type ThreadStatus =
  | "starting"
  | "running"
  | "needs_you"
  | "ready_for_review"
  | "failed"
  | "stopped"
  | "accepted"
  | "discarded";
export type Runtime = "local" | "cloud" | "in_app";
export type ThreadEventType =
  | "user_message"
  | "agent_message"
  | "agent_thought"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "permission_request"
  | "permission_response"
  | "status"
  | "error";

export interface Thread {
  id: string;
  kind: ThreadKind;
  title: string;
  projectId: string | null;
  agentId: string;
  model: string | null;
  runtime: Runtime;
  status: ThreadStatus;
  worktreePath: string | null;
  branch: string | null;
  baseRef: string | null;
  externalId: string | null;
  error: string | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface ThreadEvent {
  threadId: string;
  seq: number;
  at: string;
  type: ThreadEventType;
  data: unknown;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  requestId: string;
  toolCall: { title: string; kind?: string };
  options: PermissionOption[];
}

export interface AgentAvailability {
  installed: boolean;
  detail: string;
  command?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  runtime: Runtime;
  installed: boolean;
  detail: string;
}

export function createId(): string {
  return `${Date.now().toString(36).padStart(10, "0")}${randomSuffix()}`;
}

function randomSuffix(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

export function titleFromPrompt(prompt: string): string {
  return prompt.split(/\r?\n/, 1)[0]?.slice(0, 80) ?? "";
}
