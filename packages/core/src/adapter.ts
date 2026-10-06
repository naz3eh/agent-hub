import type {
  AgentAvailability,
  PermissionRequest,
  Runtime,
  Thread,
  ThreadEventType,
  ThreadStatus,
} from "./types.js";

export interface AgentAdapter {
  id: string;
  name: string;
  runtime: Runtime;
  detect(): Promise<AgentAvailability>;
  start(context: AdapterContext): Promise<AgentRun>;
}

export interface AdapterContext {
  thread: Thread;
  cwd: string;
  prompt: string;
  emit(type: ThreadEventType, data: unknown): void;
  setStatus(status: ThreadStatus, error?: string): void;
  requestPermission(request: PermissionRequest): Promise<string | null>;
  signal: AbortSignal;
}

export interface AgentRun {
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
