import { createDaemon, listenPort } from "./server.js";

const daemon = await createDaemon();
console.log(`agent-hub daemon listening on http://127.0.0.1:${listenPort(daemon.server)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void daemon.close().finally(() => process.exit(0));
  });
}

process.on("uncaughtException", (error) => {
  console.error(error);
});

process.on("unhandledRejection", (error) => {
  console.error(error);
});
