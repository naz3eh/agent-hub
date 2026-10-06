import electron = require("electron");

electron.contextBridge.exposeInMainWorld("hub", {
  ...(electron.ipcRenderer.sendSync("agent-hub:get-config") as {
    baseUrl: string;
    token: string;
  }),
  pickFolder: () => electron.ipcRenderer.invoke("agent-hub:pick-folder") as Promise<string | null>,
});
