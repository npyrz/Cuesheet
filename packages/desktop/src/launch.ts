/**
 * The facts the main process and the preload have to agree on.
 *
 * **This module imports nothing.** The preload runs sandboxed — no `require`,
 * no `node:*`, no filesystem — so a single `import "node:path"` anywhere in
 * its import graph is a preload that throws before it can expose the bridge,
 * and a window that comes up with no `window.cuesheet` and no error worth
 * reading. Path resolution lives next door in `ui-entry.ts`, which only the
 * main process imports.
 */

/**
 * How the bound daemon port reaches the preload.
 *
 * `additionalArguments` is the sandbox-safe channel: a sandboxed preload has
 * no Node, but it does get `process.argv`. The alternative, a synchronous IPC
 * round-trip on first paint, is a slower way to learn the same number.
 */
export const DAEMON_PORT_FLAG = "--cuesheet-daemon-port=";

/** The IPC channel behind `window.cuesheet.chooseDirectory()`. */
export const CHOOSE_DIRECTORY_CHANNEL = "cuesheet:choose-directory";

/** Where the Desk's dev server listens. Mirrors `strictPort: 5173` in the UI's vite config. */
export const DEFAULT_DEV_SERVER = "http://localhost:5173";

export function daemonPortArg(port: number): string {
  return `${DAEMON_PORT_FLAG}${port}`;
}

/**
 * What to hand the preload — which depends on where the page came from, and
 * getting this backwards costs you the whole dev loop.
 *
 * `apiOrigin()` in the UI prefers `daemonPort` over a relative URL whenever it
 * is present. That is right for a `file://` page, which has no origin to be
 * relative *to*. It is wrong for the Vite dev server: the page is served from
 * `http://localhost:5173`, an absolute `http://127.0.0.1:7373` is a different
 * origin, the daemon sends no CORS headers — deliberately, because a loopback
 * daemon that answers any website is a vulnerability, not a feature — and
 * every fetch dies as "Failed to fetch" behind a window that otherwise looks
 * fine. The dev server proxies `/api` and `/ws` precisely so relative works.
 *
 * So the dev server gets no port, and says so out loud here rather than in a
 * comment nobody reads while chasing a CORS error.
 */
export function bridgeArguments(
  source: "dev-server" | "file",
  port: number,
): string[] {
  return source === "dev-server" ? [] : [daemonPortArg(port)];
}

/**
 * The port the main process passed, or `undefined` when nothing passed one.
 *
 * `undefined` is a real answer rather than a failure: `apiOrigin()` in the UI
 * treats a missing port as "same origin", which is exactly right for the dev
 * server and for a browser pointed straight at the daemon.
 */
export function parseDaemonPort(argv: readonly string[]): number | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(DAEMON_PORT_FLAG)) continue;
    const raw = arg.slice(DAEMON_PORT_FLAG.length);
    // Digits only, deliberately: `parseInt` reads "73.7" as 73 and the Desk
    // would then fetch, forever and quietly, from a port nothing is on.
    if (!/^\d{1,5}$/.test(raw)) continue;
    const port = Number(raw);
    if (port > 0 && port <= 65535) return port;
  }
  return undefined;
}

/** Where a dev build should look for a running Vite. */
export function devServerUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env["CUESHEET_DEV_SERVER"];
  return configured !== undefined && configured !== ""
    ? configured
    : DEFAULT_DEV_SERVER;
}
