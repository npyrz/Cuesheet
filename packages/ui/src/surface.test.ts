import { describe, expect, it } from "vitest";
import { COPY, describeSurface, LOADING, READY, type Load } from "./surface.js";

const failed: Load = { status: "failed", error: "connect ECONNREFUSED" };

describe("describeSurface", () => {
  it("draws the real thing once there is something to draw", () => {
    expect(describeSurface(READY, 3, COPY.runs)).toBeNull();
  });

  it("says what it is reading before it knows whether there is anything", () => {
    const state = describeSurface(LOADING, 0, COPY.runs);
    expect(state?.kind).toBe("loading");
    expect(state?.title).toBe("Reading this project’s runs…");
  });

  it("never calls a fetch in flight an empty project", () => {
    // The bug this module exists for. `runs: []` is the initial state, so a
    // list keyed on length alone announces "No runs yet." before the first
    // request has been answered — a claim about the project, made before the
    // project was asked.
    expect(describeSurface(LOADING, 0, COPY.runs)?.kind).not.toBe("empty");
  });

  it("never calls a failure a fetch in flight", () => {
    // And the other half: `/stations` throwing left `stations === null`, which
    // the project view rendered as "Reading this project's configuration…" —
    // a progress sentence that never resolves, promising all the while that it
    // will.
    const state = describeSurface(failed, 0, COPY.stations);
    expect(state?.kind).toBe("error");
    expect(state?.title).toBe(
      "This project’s configuration could not be read.",
    );
  });

  it("keeps the daemon's own words under its own sentence", () => {
    const state = describeSurface(failed, 0, COPY.stations);
    // Two sentences answering two questions: what is missing from this
    // screen, and why. `ECONNREFUSED` alone, centred in a pane, answers
    // neither.
    expect(state?.detail).toBe("connect ECONNREFUSED");
    expect(state?.retry).toBe(true);
  });

  it("falls back to its own sentence when the cause is blank", () => {
    const state = describeSurface(
      { status: "failed", error: "  " },
      0,
      COPY.runs,
    );
    expect(state?.detail).toBeNull();
    expect(state?.title).toBe("This project’s runs could not be read.");
  });

  it("does not blank a list that already holds something true", () => {
    // A poll that fails over a list on screen leaves the list there. It is
    // still true, it is merely a minute old, and trading it for a loud red
    // panel is a worse deal than it looks. The error banner in the shell is
    // where that belongs.
    expect(describeSurface(failed, 4, COPY.runs)).toBeNull();
    expect(describeSurface(LOADING, 4, COPY.runs)).toBeNull();
  });

  it("offers the action that fills an empty surface, and only then", () => {
    expect(describeSurface(READY, 0, COPY.stations)?.action).toBe(
      "Add a Station",
    );
    expect(describeSurface(failed, 0, COPY.stations)?.action).toBeNull();
    expect(describeSurface(LOADING, 0, COPY.stations)?.action).toBeNull();
  });

  it("leaves retry off every state that is not an error", () => {
    expect(describeSurface(READY, 0, COPY.runs)?.retry).toBe(false);
    expect(describeSurface(LOADING, 0, COPY.runs)?.retry).toBe(false);
  });

  it("has an empty, a loading and a failed line for every surface", () => {
    // The done-when, as an assertion rather than a walk-through: adding a
    // surface without all three now fails here rather than at the moment
    // somebody's daemon goes down.
    for (const [name, copy] of Object.entries(COPY)) {
      for (const kind of ["loading", "empty", "failed"] as const) {
        expect(copy[kind], `${name}.${kind}`).not.toBe("");
      }
    }
  });
});
