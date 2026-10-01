#!/usr/bin/env node
/**
 * The `cuesheetd` entry point for running the daemon as its own process.
 *
 * The only place `process.exit` is called. `startDaemon` throws
 * {@link PortInUseError} rather than exiting so that the Electron shell — which
 * runs the daemon in-process and must not take the app down with it — can
 * decide for itself. A standalone daemon has no such nuance: print the reason
 * and stop.
 */
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { createSourceUpdates } from "./source-updates.js";
import { hostEnv } from "@cuesheet/core";
import { createDiagnostics } from "./diagnostics.js";
import { startDaemon } from "./server.js";
import { PortInUseError } from "./lockfile.js";
import { harnessRuntime } from "./runtime.js";

async function main(): Promise<void> {
  let handle;
  const diagnostics = createDiagnostics(hostEnv());
  try {
    // The standalone daemon runs real harnesses. `startDaemon`'s own defaults
    // are the inert ones its tests rely on; this is where the app's behaviour
    // is chosen, not in the library.
    const updates = createSourceUpdates({
      root: nodePath.resolve(
        nodePath.dirname(fileURLToPath(import.meta.url)),
        "../../..",
      ),
    });
    handle = await startDaemon({ diagnostics, updates, ...harnessRuntime() });
    void updates.check();
    const timer = setInterval(() => void updates.check(), 4 * 60 * 60 * 1000);
    timer.unref();
  } catch (error) {
    diagnostics.error("daemon-start-failed", error);
    if (error instanceof PortInUseError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  console.log(`cuesheetd listening on ${handle.url}`);

  // SIGINT/SIGTERM must land in the same place a clean quit does: stop the
  // queue, mark interrupted runs, remove the lockfile. A daemon that leaves
  // `daemon.json` behind makes the next boot probe a dead port.
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\nReceived ${signal}, shutting down.`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("Unclean shutdown:", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
