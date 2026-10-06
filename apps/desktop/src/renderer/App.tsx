import type { AgentSummary, Thread } from "@agent-hub/core";
import { useEffect, useState } from "react";
import { getAgents, getThreads, subscribe } from "./api.js";

export default function App() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);

  useEffect(() => {
    void Promise.all([getAgents(), getThreads()]).then(([agentList, threadList]) => {
      setAgents(agentList);
      setThreads(threadList);
    });
    return subscribe((name, data) => {
      if (name === "thread_updated") {
        const thread = data as Thread;
        setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      }
    });
  }, []);

  return (
    <main>
      <h1>agent-hub</h1>
      <h2>Agents</h2>
      {agents.map((agent) => (
        <div key={agent.id}>
          {agent.name} — {agent.installed ? "installed" : agent.detail}
        </div>
      ))}
      <h2>Threads</h2>
      {threads.map((thread) => (
        <div key={thread.id}>
          {thread.title} — {thread.status}
        </div>
      ))}
    </main>
  );
}
