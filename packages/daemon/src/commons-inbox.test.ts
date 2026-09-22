import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createCommonsInbox } from "./commons-inbox.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function inbox(id = "memory-00000000-0000-0000-0000-000000000001") {
  const root = await mkdtemp(path.join(tmpdir(), "cuesheet-inbox-"));
  roots.push(root);
  return createCommonsInbox({
    root,
    idFactory: () => id,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
  });
}

describe("Commons approval inbox", () => {
  it("persists a captured memory separately with its run provenance", async () => {
    const store = await inbox();
    const memory = await store.capture({
      title: "Reviewers never write",
      body: "A reviewer gets a read-only sandbox.",
      tags: ["roles"],
      projects: ["api-123456"],
      station: "codex-review",
      run: "20260918-120000-abcd",
    });

    expect(memory).toMatchObject({
      suggestedId: "reviewers-never-write",
      provenance: {
        station: "codex-review",
        run: "20260918-120000-abcd",
        at: "2026-09-18T12:00:00.000Z",
      },
    });
    expect(await store.list()).toEqual([memory]);
    expect(
      await readFile(path.join(store.root, `${memory.id}.json`), "utf8"),
    ).toContain('"suggestedId": "reviewers-never-write"');
  });

  it("removes a memory only after approval work succeeds", async () => {
    const store = await inbox();
    const memory = await store.capture({
      title: "Keep on failure",
      body: "retryable",
      station: "worker",
      run: "run-1",
    });

    await expect(
      store.resolve(memory.id, () =>
        Promise.reject(new Error("projection failed")),
      ),
    ).rejects.toThrow("projection failed");
    expect(await store.get(memory.id)).toEqual(memory);

    const result = await store.resolve(memory.id, async () => "approved");
    expect(result).toBe("approved");
    expect(await store.get(memory.id)).toBeNull();
  });

  it("discards one item without exposing malformed neighbours", async () => {
    const store = await inbox();
    const memory = await store.capture({
      title: "Temporary",
      body: "discard me",
      station: "worker",
      run: "run-1",
    });
    await writeFile(path.join(store.root, "broken.json"), "{not json", "utf8");

    expect(await store.list()).toEqual([memory]);
    expect(await store.discard(memory.id)).toEqual(memory);
    expect(await store.list()).toEqual([]);
  });

  it("refuses an id that could escape the inbox", async () => {
    const store = await inbox();
    await expect(store.get("../commons")).rejects.toThrow(/pending memory id/);
    await expect(store.discard("C:/Windows")).rejects.toThrow(
      /pending memory id/,
    );
  });
});
