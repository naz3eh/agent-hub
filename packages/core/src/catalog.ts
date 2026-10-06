import { constants, readFileSync as readFileSyncFromFs } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpAgentSpec } from "./acp-adapter.js";
import { AcpAdapter } from "./acp-adapter.js";
import type { AgentAdapter } from "./adapter.js";
import type { AgentAvailability, AgentSummary } from "./types.js";

export interface AgentDefinition extends AcpAgentSpec {
  runtime?: "local";
}

const builtIns: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    detect: { bin: "claude" },
  },
  {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    detect: { bin: "codex" },
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: ["--experimental-acp"],
    detect: { bin: "gemini" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    detect: { bin: "opencode" },
  },
];

export class AgentCatalog {
  private readonly adapters: AgentAdapter[];

  constructor(home: string, dev = false) {
    const definitions = [...builtIns, ...loadCustomDefinitions(join(home, "agents.json"))];
    this.adapters = definitions.map((definition) => new AcpAdapter(definition));
    if (dev) {
      const executable = process.execPath;
      const agentScript = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
      this.adapters.push(
        new AcpAdapter({
          id: "mock",
          name: "Mock ACP Agent",
          command: executable,
          args: [agentScript],
          detect: { bin: executable },
        }),
      );
    }
  }

  listAdapters(): AgentAdapter[] {
    return this.adapters;
  }

  async list(): Promise<AgentSummary[]> {
    return Promise.all(
      this.adapters.map(async (adapter) => {
        const availability = await adapter.detect();
        return {
          id: adapter.id,
          name: adapter.name,
          runtime: adapter.runtime,
          installed: availability.installed,
          detail: availability.detail,
        };
      }),
    );
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }
}

export async function detectBinary(
  bin: string,
  pathValue = process.env.PATH ?? "",
): Promise<AgentAvailability> {
  if (bin.includes("/") || bin.includes("\\")) {
    try {
      await access(bin, constants.X_OK);
      return { installed: true, detail: `Found ${bin}`, command: bin };
    } catch {
      return { installed: false, detail: `${bin} was not found on PATH` };
    }
  }
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, bin);
    try {
      await access(candidate, constants.X_OK);
      return { installed: true, detail: `Found ${candidate}`, command: candidate };
    } catch {}
  }
  return { installed: false, detail: `${bin} was not found on PATH` };
}

function loadCustomDefinitions(path: string): AgentDefinition[] {
  try {
    const raw = readFileSync(path);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAgentDefinition);
  } catch {
    return [];
  }
}

function readFileSync(path: string): string {
  try {
    return readFileSyncFromFs(path, "utf8");
  } catch {
    return "";
  }
}

function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentDefinition>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.command === "string" &&
    Array.isArray(candidate.args) &&
    candidate.args.every((argument) => typeof argument === "string") &&
    !!candidate.detect &&
    typeof candidate.detect.bin === "string"
  );
}
