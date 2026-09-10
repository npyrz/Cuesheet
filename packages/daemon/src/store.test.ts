import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { runsDir, type HostEnv, type RunEvent } from "@cuesheet/core";
import { createFileRunStore, readEvents, RunNotFoundError } from "./store.js";
import { createRunIdFactory } from "./ids.js";

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-store-"));
});

function store(startAt = 0) {
  return createFileRunStore({ root, newId: createRunIdFactory(startAt) });
}

function text(runId: string, chunk: string): RunEvent {
  return {
    t: "text",
    at: "2026-09-10T14:22:33.104Z",
    runId,
    stationId: "opus",
    chunk,
  };
}

describe("layout", () => {
  it("honours the HostEnv seam instead of the real home directory", () => {
    // The reason this seam matters: without it a store test writes into the
    // developer's actual `~/.cuesheet` and quietly pollutes real run history.
    const fake: HostEnv = { platform: "darwin", homedir: "/Users/nobody" };
    expect(runsDir(fake)).toBe("/Users/nobody/.cuesheet/runs");
  });

  it("creates the run directory tree on a fresh install", async () => {
    // No `~/.cuesheet` exists yet — `root` is an empty temp dir.
    const created = await store().create({ prompt: "hi", workspace: "/ws" });
    const entries = await readdir(path.join(root, created.id));
    expect(entries.sort()).toEqual(["events.jsonl", "run.json"]);
  });

  it("writes a queued run with zeroed cost", async () => {
    const created = await store().create({
      prompt: "ship it",
      workspace: "/ws",
    });
    expect(created.status).toBe("queued");
    expect(created.cost).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(created.kind).toBe("prompt");
  });

  it("omits absent optional fields rather than storing undefined", async () => {
    const created = await store().create({ prompt: "hi", workspace: "/ws" });
    const raw = JSON.parse(
      await readFile(path.join(root, created.id, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("cuesheetId" in raw).toBe(false);
    expect("finishedAt" in raw).toBe(false);
  });
});

describe("append and read back", () => {
  it("round-trips events in order", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    await s.append(created.id, text(created.id, "one"));
    await s.append(created.id, text(created.id, "two"));

    const stored = await s.get(created.id);
    expect(stored?.events.map((e) => (e.t === "text" ? e.chunk : e.t))).toEqual(
      ["one", "two"],
    );
  });

  it("serializes concurrent appends without dropping or interleaving", async () => {
    // Concurrent append streams throw EBUSY on Windows, where file locking is
    // stricter than macOS. One write chain per run is the fix, and this is
    // what proves it: 50 un-awaited appends must all land, in order.
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        s.append(created.id, text(created.id, String(i))),
      ),
    );

    const stored = await s.get(created.id);
    expect(stored?.events).toHaveLength(50);
    expect(stored?.events.map((e) => (e.t === "text" ? e.chunk : ""))).toEqual(
      Array.from({ length: 50 }, (_, i) => String(i)),
    );
  });

  it("returns null for a run that does not exist", async () => {
    expect(await store().get("20260910T142233104Z-9999")).toBeNull();
  });
});

describe("a damaged log is still readable", () => {
  it("drops a truncated final line and keeps everything before it", async () => {
    // A process killed mid-append leaves bytes with no trailing newline.
    // Written directly rather than by killing a process: this asserts the
    // actual invariant, and does it identically on both OSes.
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const log = path.join(root, created.id, "events.jsonl");

    const good = JSON.stringify(text(created.id, "survived"));
    const partial = JSON.stringify(text(created.id, "lost")).slice(0, 30);
    await writeFile(log, `${good}\n${partial}`, "utf8");

    const events = await readEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]?.t === "text" && events[0].chunk).toBe("survived");
  });

  it("skips a corrupt line in the middle and keeps the rest", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const log = path.join(root, created.id, "events.jsonl");
    const a = JSON.stringify(text(created.id, "a"));
    const b = JSON.stringify(text(created.id, "b"));
    await writeFile(log, `${a}\n{"t":"tex\n${b}\n`, "utf8");

    const events = await readEvents(log);
    expect(events.map((e) => (e.t === "text" ? e.chunk : e.t))).toEqual([
      "a",
      "b",
    ]);
  });

  it("parses a log written with Windows line endings", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const log = path.join(root, created.id, "events.jsonl");
    const a = JSON.stringify(text(created.id, "a"));
    await writeFile(log, `${a}\r\n`, "utf8");

    expect(await readEvents(log)).toHaveLength(1);
  });

  it("returns an empty list for a missing log rather than throwing", async () => {
    expect(await readEvents(path.join(root, "nope", "events.jsonl"))).toEqual(
      [],
    );
  });

  it("ignores a JSON line that is not a RunEvent", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const log = path.join(root, created.id, "events.jsonl");
    await writeFile(log, `{"hello":"world"}\n[1,2,3]\nnull\n`, "utf8");
    expect(await readEvents(log)).toEqual([]);
  });
});

describe("update and finish", () => {
  it("stamps startedAt on the queued to running transition", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const updated = await s.update(created.id, {
      status: "running",
      startedAt: "2026-09-10T14:22:34.000Z",
    });
    expect(updated.status).toBe("running");
    expect(updated.startedAt).toBe("2026-09-10T14:22:34.000Z");
  });

  it("writes the diff and the terminal state", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const finished = await s.finish(created.id, {
      status: "done",
      cost: { tokensIn: 10, tokensOut: 20, usd: 0.5 },
      result: {
        status: "done",
        cost: { tokensIn: 10, tokensOut: 20, usd: 0.5 },
        durationMs: 1234,
        diff: { filesChanged: 1, insertions: 3, deletions: 0 },
      },
      diff: "--- a/x\n+++ b/x\n",
    });

    expect(finished.status).toBe("done");
    expect(finished.finishedAt).toBeTypeOf("string");
    expect(finished.cost.usd).toBe(0.5);

    const stored = await s.get(created.id);
    expect(stored?.diff).toBe("--- a/x\n+++ b/x\n");
  });

  it("records an error message on a failed run", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    const finished = await s.finish(created.id, {
      status: "failed",
      error: "harness exited 1",
    });
    expect(finished.error).toBe("harness exited 1");
  });

  it("throws for a run that was never created", async () => {
    await expect(
      store().update("20260910T142233104Z-9999", { status: "running" }),
    ).rejects.toThrow(RunNotFoundError);
  });

  it("orders finish after every append issued before it", async () => {
    // The per-run write chain is what guarantees this, which is why the queue
    // can fire-and-forget appends and still trust `finish` to come last.
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    void s.append(created.id, text(created.id, "streamed"));
    await s.finish(created.id, { status: "done" });

    const stored = await s.get(created.id);
    expect(stored?.events).toHaveLength(1);
    expect(stored?.run.status).toBe("done");
  });
});

describe("run.json is written atomically", () => {
  it("leaves no temp file behind", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    await s.update(created.id, { status: "running" });
    await s.finish(created.id, { status: "done" });

    const entries = await readdir(path.join(root, created.id));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("still reads correctly if a stale temp file is present", async () => {
    // A crash between the write and the rename leaves the temp file behind.
    // The committed `run.json` must still be the one that is read — that is
    // the whole point of renaming rather than writing in place.
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    await writeFile(
      path.join(root, created.id, "run.json.tmp"),
      "{ truncated",
      "utf8",
    );

    const stored = await s.get(created.id);
    expect(stored?.run.status).toBe("queued");
    expect((await s.list()).map((r) => r.id)).toEqual([created.id]);
  });

  it("keeps the record readable across many rewrites", async () => {
    const s = store();
    const created = await s.create({ prompt: "hi", workspace: "/ws" });
    for (let i = 0; i < 20; i += 1) {
      await s.update(created.id, { cost: { tokensIn: i, tokensOut: i } });
      // Never a parse failure, which is what a mid-write truncation produces.
      expect((await s.get(created.id))?.run.cost.tokensIn).toBe(i);
    }
  });
});

describe("list", () => {
  it("returns runs newest first without opening a run.json to sort", async () => {
    const s = store();
    const first = await s.create({ prompt: "a", workspace: "/ws" });
    const second = await s.create({ prompt: "b", workspace: "/ws" });
    const third = await s.create({ prompt: "c", workspace: "/ws" });

    const listed = await s.list();
    expect(listed.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
  });

  it("honours a limit", async () => {
    const s = store();
    await s.create({ prompt: "a", workspace: "/ws" });
    const second = await s.create({ prompt: "b", workspace: "/ws" });
    expect((await s.list(1)).map((r) => r.id)).toEqual([second.id]);
  });

  it("is an empty list when no runs directory exists yet", async () => {
    const fresh = createFileRunStore({
      root: path.join(root, "never-created"),
    });
    expect(await fresh.list()).toEqual([]);
  });

  it("ignores stray directories that are not run ids", async () => {
    const s = store();
    const created = await s.create({ prompt: "a", workspace: "/ws" });
    await writeFile(path.join(root, ".DS_Store"), "junk", "utf8");
    expect((await s.list()).map((r) => r.id)).toEqual([created.id]);
  });
});

describe("cross-process durability", () => {
  it("is fully readable by a second process", async () => {
    // Step 10's done-when. The reader is a bare `node -e` using nothing but
    // `fs`, so it proves the on-disk format itself is portable — not that our
    // own code can read what our own code wrote.
    const s = store();
    const created = await s.create({ prompt: "ship it", workspace: "/ws" });
    await s.append(created.id, text(created.id, "streamed"));
    await s.finish(created.id, { status: "done", diff: "patch" });

    const dir = path.join(root, created.id);
    const script = `
      const fs = require("node:fs");
      const p = require("node:path");
      const dir = process.argv[1];
      const run = JSON.parse(fs.readFileSync(p.join(dir, "run.json"), "utf8"));
      const lines = fs.readFileSync(p.join(dir, "events.jsonl"), "utf8")
        .split("\\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
      process.stdout.write(JSON.stringify({
        id: run.id, status: run.status, prompt: run.prompt, events: lines.length,
      }));
    `;
    const { stdout } = await run(process.execPath, ["-e", script, dir]);

    expect(JSON.parse(stdout)).toEqual({
      id: created.id,
      status: "done",
      prompt: "ship it",
      events: 1,
    });
  });
});
