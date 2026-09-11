/**
 * Where the daemon is, from wherever this bundle happens to be running.
 *
 * The Desk has three hosts and they disagree about what a relative URL means:
 *
 * - **Vite dev server** — same origin, and `/api` + `/ws` are proxied to
 *   `:7373`. A relative URL is correct and a absolute one would break the
 *   proxy.
 * - **Electron (Step 21)** — the page is loaded from `file://`, where
 *   `fetch("/api/runs")` resolves to `file:///api/runs` and fails with an
 *   error that names neither the daemon nor the port. The preload exposes the
 *   bound port, and that is what the absolute URL is built from.
 * - **Served by the daemon, or a paired phone (M3)** — same origin again, and
 *   relative is right for the same reason as dev.
 *
 * Every fetch and the WebSocket URL go through here. This is one module now
 * and a scavenger hunt across a finished UI later, which is the only reason
 * it exists before there is an Electron shell to need it.
 */

/** What Step 21's preload will expose on `window`. */
export interface CuesheetBridge {
  /** `process.platform` from the main process — "darwin", "win32", … */
  platform: string;
  daemonPort?: number;
  chooseDirectory?: () => Promise<string | null>;
}

declare global {
  interface Window {
    cuesheet?: CuesheetBridge;
  }
}

export function bridge(): CuesheetBridge | undefined {
  return typeof window === "undefined" ? undefined : window.cuesheet;
}

/**
 * The origin to prefix every daemon URL with. Empty string means "relative",
 * which is the answer in a browser and the answer we want in a browser.
 */
export function apiOrigin(): string {
  const port = bridge()?.daemonPort;
  if (typeof port === "number") return `http://127.0.0.1:${port}`;

  // A `file://` page with no bridge has no sensible origin to guess, but
  // falling back to the default port is strictly better than emitting
  // `file:///api/...` and failing with a confusing error.
  if (typeof location !== "undefined" && location.protocol === "file:") {
    return "http://127.0.0.1:7373";
  }
  return "";
}

/** An HTTP URL for a daemon path — always pass a leading slash. */
export function apiUrl(path: string): string {
  return `${apiOrigin()}/api${path}`;
}

/**
 * The WebSocket URL.
 *
 * `/ws` is registered at the daemon's root, not under `/api`, and the dev
 * proxy forwards it there — so this deliberately does not go through
 * {@link apiUrl}.
 */
export function socketUrl(): string {
  const origin = apiOrigin();
  if (origin !== "") return `${origin.replace(/^http/, "ws")}/ws`;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}
