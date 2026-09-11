/**
 * The `/ws` connection, with reconnect.
 *
 * Framework-free and dependency-free so it can be reasoned about on its own:
 * React's job is to start it and stop it, not to own the retry timer.
 */
import type { RunEvent } from "@cuesheet/core";
import { socketUrl } from "./base.js";

export interface SocketHandlers {
  onEvent(event: RunEvent): void;
  /** Fired on every successful open, including reconnects — resync here. */
  onOpen(): void;
  onClose(): void;
}

/**
 * Backoff schedule, in milliseconds.
 *
 * Capped at five seconds rather than growing without bound: the daemon this
 * is reconnecting to is on loopback and usually came back a moment ago
 * (Step 23 restarts it on quit), so a minute-long backoff would leave a dead
 * UI in front of a live daemon. Jitter is not needed — there is exactly one
 * client per daemon here, so there is no thundering herd to avoid.
 */
const BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;

export interface SocketController {
  close(): void;
}

export function connectEvents(handlers: SocketHandlers): SocketController {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;

  function open(): void {
    if (disposed) return;
    socket = new WebSocket(socketUrl());

    socket.addEventListener("open", () => {
      if (disposed) return;
      attempt = 0;
      handlers.onOpen();
    });

    socket.addEventListener("message", (message: MessageEvent<unknown>) => {
      if (typeof message.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        // A frame we cannot parse is a bug on the wire, not a reason to tear
        // down a working connection.
        return;
      }
      if (isRunEvent(parsed)) handlers.onEvent(parsed);
    });

    // `close` fires after `error` too, so retrying is wired here only —
    // scheduling from both handlers opens two sockets per failure.
    socket.addEventListener("close", () => {
      socket = null;
      // A close that arrives *after* teardown must stay silent. Clearing the
      // local binding in `close()` does not remove this listener, so without
      // the guard a disposed socket still reports "closed" — and under
      // StrictMode's mount/unmount/mount, the first socket's close can land
      // after the second one has already opened, leaving the banner stuck on
      // "daemon unreachable" with no later `open` to correct it.
      if (disposed) return;
      handlers.onClose();
      schedule();
    });
  }

  function schedule(): void {
    if (disposed || timer !== null) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 5000;
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  open();

  return {
    close() {
      // Set before closing: the `close` event this triggers is dispatched
      // asynchronously, and the flag is what tells those handlers the
      // teardown was deliberate rather than a daemon that went away.
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}

/**
 * A structural check, not a validator.
 *
 * The union is wide and the daemon is the only writer, so confirming the
 * three fields every variant must carry is enough to file the event. A full
 * schema here would be a second copy of `RunEvent` to keep in step.
 */
function isRunEvent(value: unknown): value is RunEvent {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["t"] === "string" &&
    typeof record["runId"] === "string" &&
    typeof record["at"] === "string"
  );
}
