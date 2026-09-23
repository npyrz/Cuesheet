import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  openRunStore,
  resolveRunStoreBackend,
  RUN_STORE_ENV_VAR,
} from "./store-backend.js";
import { RUNS_DB_FILENAME } from "./store-sqlite.js";
import { createRunIdFactory } from "./ids.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-backend-"));
});

describe("resolveRunStoreBackend", () => {
  it("reads the operator's choice", () => {
    expect(resolveRunStoreBackend({ [RUN_STORE_ENV_VAR]: "files" })).toBe(
      "files",
    );
    expect(resolveRunStoreBackend({ [RUN_STORE_ENV_VAR]: "sqlite" })).toBe(
      "sqlite",
    );
  });

  it("tolerates the shape a shell actually produces", () => {
    expect(resolveRunStoreBackend({ [RUN_STORE_ENV_VAR]: " SQLite " })).toBe(
      "sqlite",
    );
  });

  it("is undefined for absent, empty or unrecognised", () => {
    expect(resolveRunStoreBackend({})).toBeUndefined();
    expect(resolveRunStoreBackend({ [RUN_STORE_ENV_VAR]: "" })).toBeUndefined();
    // A typo starts the daemon on the default rather than refusing to boot:
    // this is read once, at startup, and there is nobody at a prompt to fix it.
    expect(
      resolveRunStoreBackend({ [RUN_STORE_ENV_VAR]: "postgres" }),
    ).toBeUndefined();
  });
});

describe("openRunStore", () => {
  it("defaults to a database", async () => {
    const store = await openRunStore({ root, newId: createRunIdFactory(0) });
    try {
      await store.create({ prompt: "hi", workspace: "/ws" });
      expect(await readdir(root)).toContain(RUNS_DB_FILENAME);
      expect(store.unfinished).toBeTypeOf("function");
    } finally {
      await store.close?.();
    }
  });

  it("gives an operator who asks for files exactly that", async () => {
    const store = await openRunStore({
      root,
      backend: "files",
      newId: createRunIdFactory(0),
    });
    const created = await store.create({ prompt: "hi", workspace: "/ws" });

    const entries = await readdir(root);
    expect(entries).toContain(created.id);
    expect(entries).not.toContain(RUNS_DB_FILENAME);
    // Not a crippled store: it simply cannot answer this one cheaply, so it
    // does not claim to, and `reconcile` keeps its bounded scan.
    expect(store.unfinished).toBeUndefined();
  });

  it("hands both backends the same run id factory and clock", async () => {
    // The seam is only worth having if a caller can swap backends without
    // changing anything else it passes.
    const at = new Date("2026-01-02T03:04:05.006Z");
    for (const backend of ["sqlite", "files"] as const) {
      const where = await mkdtemp(path.join(tmpdir(), "cuesheet-backend-"));
      const store = await openRunStore({
        root: where,
        backend,
        newId: createRunIdFactory(7),
        now: () => at,
      });
      try {
        const created = await store.create({ prompt: "hi", workspace: "/ws" });
        expect(created.id).toBe("20260102T030405006Z-0007");
        expect(created.createdAt).toBe(at.toISOString());
      } finally {
        await store.close?.();
      }
    }
  });
});
