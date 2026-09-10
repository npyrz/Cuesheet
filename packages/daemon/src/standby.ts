/**
 * Standbys — a run paused, waiting on a person.
 *
 * "Your phone buzzes, you tap GO." The transport for that is M3, but the
 * *mechanism* is needed now: `POST /standbys/:id` is in Step 12's API surface,
 * and a route that returns 501 is not a route with a smoke test.
 *
 * A standby is a promise held open across an HTTP request. The registry owns
 * the resolver so the executor can `await ctx.ask(...)` and the route can
 * answer it, without either knowing about the other.
 */
import type { Standby, StandbyAnswer } from "@cuesheet/core";
import type { StandbyRequest } from "./executor.js";

export interface OpenStandby {
  standby: Standby;
  answer: Promise<StandbyAnswer>;
}

export interface StandbyRegistry {
  open(request: StandbyRequest): OpenStandby;
  /** Answer a pending standby. `null` if it is unknown or already answered. */
  resolve(id: string, answer: StandbyAnswer): Standby | null;
  get(id: string): Standby | null;
  list(): Standby[];
  /** Fail every standby for a run — it was stopped or the daemon is quitting. */
  abandonRun(runId: string, reason: string): void;
}

export class StandbyAbandonedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StandbyAbandonedError";
  }
}

interface Pending {
  standby: Standby;
  settle: (answer: StandbyAnswer) => void;
  fail: (error: Error) => void;
}

export function createStandbyRegistry(
  nextId: () => string = defaultId,
): StandbyRegistry {
  const pending = new Map<string, Pending>();
  const answered = new Map<string, Standby>();

  return {
    open(request) {
      const id = nextId();
      const standby: Standby = {
        id,
        runId: request.runId,
        ask: request.ask,
        kind: request.kind,
        at: new Date().toISOString(),
        ...(request.stationId !== undefined && {
          stationId: request.stationId,
        }),
      };

      let settle!: (answer: StandbyAnswer) => void;
      let fail!: (error: Error) => void;
      const answer = new Promise<StandbyAnswer>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });

      pending.set(id, { standby, settle, fail });
      return { standby, answer };
    },

    resolve(id, answer) {
      const entry = pending.get(id);
      if (!entry) return null;
      pending.delete(id);
      const settled: Standby = {
        ...entry.standby,
        answer,
        answeredAt: new Date().toISOString(),
      };
      answered.set(id, settled);
      entry.settle(answer);
      return settled;
    },

    get(id) {
      return pending.get(id)?.standby ?? answered.get(id) ?? null;
    },

    list() {
      return [...pending.values()].map((entry) => entry.standby);
    },

    abandonRun(runId, reason) {
      for (const [id, entry] of [...pending.entries()]) {
        if (entry.standby.runId !== runId) continue;
        pending.delete(id);
        entry.fail(new StandbyAbandonedError(reason));
      }
    },
  };
}

let counter = 0;
function defaultId(): string {
  counter += 1;
  return `sb_${Date.now().toString(36)}_${counter.toString(36)}`;
}
