import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

const currentDir = dirname(fileURLToPath(import.meta.url));
const baseUrl = `http://127.0.0.1:${process.env.AGENT_HUB_PORT ?? "47321"}`;
let token = "";

app.whenReady().then(async () => {
  const home = process.env.AGENT_HUB_HOME ?? join(homedir(), ".agent-hub");
  await ensureDaemon(home);
  token = (await readFile(join(home, "token"), "utf8")).trim();
  process.env.AGENT_HUB_TOKEN = token;
  ipcMain.on("agent-hub:get-config", (event) => {
    event.returnValue = { baseUrl, token };
  });
  ipcMain.handle("agent-hub:pick-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: "agent-hub",
    backgroundColor: "#0e1014",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  await window.loadFile(resolve(currentDir, "../renderer/index.html"));
});

async function ensureDaemon(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  const tokenPath = join(home, "token");
  let existingToken = "";
  try {
    existingToken = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    // The daemon creates its token on first launch.
  }
  if (existingToken && (await healthCheck(existingToken))) return;

  const entry = process.env.AGENT_HUB_DAEMON
    ? resolve(process.env.AGENT_HUB_DAEMON)
    : resolve(currentDir, "../../../../packages/daemon/dist/index.js");
  await access(entry);
  const logFd = openSync(join(home, "daemon.log"), "a");
  const daemon = spawn("node", [entry], {
    cwd: dirname(entry),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, AGENT_HUB_HOME: home },
  });
  daemon.unref();
  closeSync(logFd);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    try {
      const startedToken = (await readFile(tokenPath, "utf8")).trim();
      if (await healthCheck(startedToken)) return;
    } catch {
      // Continue waiting while the detached daemon starts.
    }
  }
  throw new Error("agent-hub daemon did not start; see daemon.log");
}

async function healthCheck(candidate: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${candidate}` },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
