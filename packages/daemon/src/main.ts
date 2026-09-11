/**
 * The `cuesheetd` entry point for running the daemon as its own process.
 *
 * The only place `process.exit` is called. `startDaemon` throws
 * {@link PortInUseError} rather than exiting so that the Electron shell — which
 * runs the daemon in-process and must not take the app down with it — can
 * decide for itself. A standalone daemon has no such nuance: print the reason
 * and stop.
 */
import { startDaemon } from "./server.js";
import { PortInUseError } from "./lockfile.js";
import { harnessRuntime } from "./runtime.js";

async function main(): Promise<void> {
  let handle;
  try {
    // The standalone daemon runs real harnesses. `startDaemon`'s own defaults
    // are the inert ones its tests rely on; this is where the app's behaviour
    // is chosen, not in the library.
    handle = await startDaemon({ logger: true, ...harnessRuntime() });
  } catch (error) {
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
