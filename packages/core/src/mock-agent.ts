import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<
  string,
  { cwd: string; turn: number; cancelled: (() => void) | undefined }
>();
let agentConnection: acp.AgentConnection;

const app = acp
  .agent({ name: "agent-hub-mock" })
  .onConnect((ctx) => {
    agentConnection = ctx;
  })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, turn: 0, cancelled: undefined });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("Unknown session");
    session.turn += 1;
    const prompt = params.prompt
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("");
    if (prompt.includes("fail")) throw new Error("Mock agent requested failure");
    if (prompt.includes("slow")) {
      await new Promise<void>((resolveWait) => {
        session.cancelled = resolveWait;
      });
      session.cancelled = undefined;
      return { stopReason: "cancelled" as const };
    }

    const sessionId = params.sessionId;
    const message = `Working on: ${prompt}`;
    const chunkSize = Math.max(1, Math.ceil(message.length / 4));
    for (let index = 0; index < message.length; index += chunkSize) {
      await agentConnection.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message.slice(index, index + chunkSize) },
        },
      });
    }
    await agentConnection.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Write a mock result", priority: "high", status: "completed" }],
      },
    });
    const toolCallId = `mock-write-${session.turn}`;
    await agentConnection.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Write mock result",
        kind: "edit",
        status: "in_progress",
      },
    });

    if (prompt.includes("ask")) {
      const permission = await agentConnection.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: { toolCallId, title: "Write mock result", kind: "edit" },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
          ],
        },
      );
      if (
        permission.outcome.outcome !== "selected" ||
        permission.outcome.optionId === "reject_once"
      ) {
        await updateTool(toolCallId, sessionId, "completed");
        return { stopReason: "end_turn" as const };
      }
    }

    const path = prompt.includes("escape")
      ? `/tmp/outside-${randomUUID()}.txt`
      : resolve(session.cwd, "hub-mock", `${session.turn}.md`);
    await agentConnection.client.request(acp.methods.client.fs.writeTextFile, {
      sessionId,
      path,
      content: `# Mock result ${session.turn}\n\n${prompt}\n`,
    });
    await updateTool(toolCallId, sessionId, "completed");
    return { stopReason: "end_turn" as const };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.cancelled?.();
  });

async function updateTool(toolCallId: string, sessionId: string, status: "completed") {
  await agentConnection.client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "tool_call_update", toolCallId, status },
  });
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
await connection.closed;
