/**
 * The event bus — one `RunEvent` stream, many consumers.
 *
 * In-process and synchronous on purpose. `RunEvent` is the wire format for the
 * WebSocket, `events.jsonl`, and later the phone; keeping the fan-out
 * synchronous is what lets a client attach without racing the emitter.
 *
 * ## The replay race, and why `attach` is shaped the way it is
 *
 * A client that connects mid-run must not stare at a blank tile, so the bus
 * keeps a short ring buffer per active run and hands it over on connect. The
 * bug in the obvious implementation is an `await` between "send the buffered
 * events" and "start listening" — anything emitted in that gap is lost, and
 * anything re-read is duplicated.
 *
 * So there is no `getBacklog()` + `subscribe()` pair to misuse. {@link
 * EventBus.attach} does both in one synchronous call and returns the backlog,
 * which makes the gap structurally impossible rather than a rule someone has
 * to remember.
 */
import { isTerminalStatus, type RunEvent, type RunId } from "@cuesheet/core";

export type RunEventListener = (event: RunEvent) => void;
export type Unsubscribe = () => void;

export interface BusAttachment {
  /** Buffered events for still-active runs, oldest first. */
  backlog: RunEvent[];
  unsubscribe: Unsubscribe;
}

export interface EventBus {
  emit(event: RunEvent): void;
  /** Subscribe and receive the replay backlog in the same tick. */
  attach(listener: RunEventListener): BusAttachment;
  /** Buffered events for one run. For tests and `GET /runs/:id`. */
  buffered(runId: RunId): RunEvent[];
  subscriberCount(): number;
}

/** Events retained per active run. Enough to redraw a tile, not a log store. */
export const DEFAULT_REPLAY_LIMIT = 200;

export interface EventBusOptions {
  replayLimit?: number;
  /** Where to report a throwing listener. Defaults to `console.error`. */
  onListenerError?: (error: unknown, event: RunEvent) => void;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT;
  const onListenerError =
    options.onListenerError ??
    ((error: unknown) => {
      console.error("[cuesheetd] event listener threw:", error);
    });

  // A Set rather than an EventEmitter: unsubscribe is identity-based, and a
  // listener that throws must not stop the others from being called.
  const listeners = new Set<RunEventListener>();
  const buffers = new Map<RunId, RunEvent[]>();

  function remember(event: RunEvent): void {
    // A run that has finished needs no replay — Step 18's client refetches
    // `/runs` on reconnect rather than trusting this buffer, so holding
    // terminal runs here would only be an unbounded memory leak.
    if (isTerminal(event)) {
      buffers.delete(event.runId);
      return;
    }
    const existing = buffers.get(event.runId);
    if (!existing) {
      buffers.set(event.runId, [event]);
      return;
    }
    existing.push(event);
    if (existing.length > replayLimit)
      existing.splice(0, existing.length - replayLimit);
  }

  return {
    emit(event) {
      remember(event);
      // Snapshot: a listener that unsubscribes during dispatch (a socket
      // closing as it is written to) must not perturb this iteration.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onListenerError(error, event);
        }
      }
    },

    attach(listener) {
      // No `await`, no `async`, nothing between these two statements. That is
      // the entire correctness argument for replay.
      const backlog = [...buffers.values()].flat();
      listeners.add(listener);
      return {
        backlog,
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },

    buffered(runId) {
      return [...(buffers.get(runId) ?? [])];
    },

    subscriberCount() {
      return listeners.size;
    },
  };
}

/**
 * Whether an event ends its run.
 *
 * Both arms are needed: `done` is the summary event, but a run can also reach
 * a terminal state through a plain `status` event (`stopped` by the user,
 * `interrupted` by a crash) without a `done` ever being emitted.
 */
function isTerminal(event: RunEvent): boolean {
  if (event.t === "done") return true;
  return event.t === "status" && isTerminalStatus(event.status);
}
