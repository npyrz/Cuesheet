import { describe, expect, it, vi } from "vitest";
import type { RunEvent, RunStatus } from "@cuesheet/core";
import { createEventBus } from "./bus.js";

const runId = "20260910T142233104Z-0000";

function text(chunk: string, id = runId): RunEvent {
  return {
    t: "text",
    at: "2026-09-10T14:22:33.104Z",
    runId: id,
    stationId: "opus",
    chunk,
  };
}

function status(s: RunStatus, id = runId): RunEvent {
  return { t: "status", at: "2026-09-10T14:22:33.104Z", runId: id, status: s };
}

describe("fan-out", () => {
  it("delivers to every subscriber", () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.attach(a);
    bus.attach(b);

    const event = text("hello");
    bus.emit(event);

    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("keeps delivering when one listener throws", () => {
    const onListenerError = vi.fn();
    const bus = createEventBus({ onListenerError });
    const healthy = vi.fn();

    bus.attach(() => {
      throw new Error("socket exploded");
    });
    bus.attach(healthy);
    bus.emit(text("hi"));

    // A dead socket must not take the run's other consumers — including the
    // run store — down with it.
    expect(healthy).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it("tolerates a listener unsubscribing mid-dispatch", () => {
    const bus = createEventBus();
    const second = vi.fn();
    const first = bus.attach(() => first.unsubscribe());
    bus.attach(second);

    expect(() => bus.emit(text("hi"))).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
    expect(bus.subscriberCount()).toBe(1);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const { unsubscribe } = bus.attach(listener);
    unsubscribe();
    bus.emit(text("hi"));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("replay", () => {
  it("hands a late subscriber the events it missed", () => {
    const bus = createEventBus();
    bus.emit(text("one"));
    bus.emit(text("two"));

    const { backlog } = bus.attach(vi.fn());
    expect(backlog.map((e) => (e.t === "text" ? e.chunk : e.t))).toEqual([
      "one",
      "two",
    ]);
  });

  it("leaves no gap between the backlog and the live stream", () => {
    // This is the bug the `attach` shape exists to prevent: with a separate
    // `getBacklog()` then `subscribe()`, anything emitted in between is lost.
    // Emitting from inside the listener proves the two happen in one tick.
    const bus = createEventBus();
    bus.emit(text("before"));

    const seen: string[] = [];
    const { backlog } = bus.attach((event) => {
      if (event.t === "text") seen.push(event.chunk);
    });
    bus.emit(text("after"));

    const all = [
      ...backlog.map((e) => (e.t === "text" ? e.chunk : e.t)),
      ...seen,
    ];
    expect(all).toEqual(["before", "after"]);
  });

  it("does not duplicate an event across backlog and live delivery", () => {
    const bus = createEventBus();
    bus.emit(text("once"));
    const seen: string[] = [];
    const { backlog } = bus.attach((event) => {
      if (event.t === "text") seen.push(event.chunk);
    });
    expect(backlog).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it("buffers each active run separately", () => {
    const bus = createEventBus();
    const other = "20260910T142233105Z-0001";
    bus.emit(text("a", runId));
    bus.emit(text("b", other));

    expect(bus.buffered(runId)).toHaveLength(1);
    expect(bus.buffered(other)).toHaveLength(1);
    expect(bus.attach(vi.fn()).backlog).toHaveLength(2);
  });

  it("drops a run's buffer once it reaches a terminal status", () => {
    const bus = createEventBus();
    bus.emit(text("working"));
    expect(bus.buffered(runId)).toHaveLength(1);

    bus.emit(status("done"));

    // Step 18's client refetches `/runs` on reconnect rather than trusting
    // this buffer, so retaining finished runs would be a pure memory leak.
    expect(bus.buffered(runId)).toHaveLength(0);
    expect(bus.attach(vi.fn()).backlog).toHaveLength(0);
  });

  it("drops the buffer on a `done` event too, not only on a status", () => {
    const bus = createEventBus();
    bus.emit(text("working"));
    bus.emit({
      t: "done",
      at: "2026-09-10T14:22:34.000Z",
      runId,
      result: {
        status: "done",
        cost: { tokensIn: 1, tokensOut: 2 },
        durationMs: 5,
      },
    });
    expect(bus.buffered(runId)).toHaveLength(0);
  });

  it("keeps buffering through a non-terminal status", () => {
    const bus = createEventBus();
    bus.emit(status("running"));
    bus.emit(text("working"));
    expect(bus.buffered(runId)).toHaveLength(2);
  });

  it("caps the buffer at the replay limit, keeping the newest", () => {
    const bus = createEventBus({ replayLimit: 3 });
    for (const n of [1, 2, 3, 4, 5]) bus.emit(text(String(n)));

    const chunks = bus
      .buffered(runId)
      .map((e) => (e.t === "text" ? e.chunk : e.t));
    expect(chunks).toEqual(["3", "4", "5"]);
  });

  it("returns a copy, so a caller cannot mutate the buffer", () => {
    const bus = createEventBus();
    bus.emit(text("one"));
    bus.buffered(runId).push(text("forged"));
    expect(bus.buffered(runId)).toHaveLength(1);
  });
});
