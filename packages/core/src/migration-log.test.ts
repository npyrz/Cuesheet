import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createMigrationLog } from "./migration-log.js";
import { migrationLogFile, type HostEnv } from "./paths.js";

let home: string;
let env: HostEnv;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "cuesheet-miglog-"));
  env = { platform: process.platform, homedir: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const at = () => new Date("2026-09-24T12:00:00.000Z");

it("reads nothing from an install that never migrated", async () => {
  expect(await createMigrationLog({ build: "x", env }).read()).toEqual([]);
});

it("stamps each record with the build and the time, one JSON line apiece", async () => {
  const log = createMigrationLog({ build: "0.5.0-beta", env, now: at });
  await log.record({
    kind: "runs-move",
    project: "api-1",
    from: "/a",
    to: "/b",
  });

  const text = await readFile(migrationLogFile(env), "utf8");
  expect(text.split("\n")).toHaveLength(2);
  expect(await log.read()).toEqual([
    {
      at: "2026-09-24T12:00:00.000Z",
      build: "0.5.0-beta",
      kind: "runs-move",
      project: "api-1",
      from: "/a",
      to: "/b",
    },
  ]);
});

it("keeps concurrent records whole and in the order they were asked for", async () => {
  // Two projects opening at once both migrate their stores. Interleaved
  // appends would leave a line nobody can parse.
  const log = createMigrationLog({ build: "x", env });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      log.record({ kind: "runs-schema", from: String(i), to: String(i + 1) }),
    ),
  );
  expect((await log.read()).map((r) => r.from)).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
});

it("skips a truncated last line rather than refusing the whole log", async () => {
  const log = createMigrationLog({ build: "x", env });
  await log.record({ kind: "config-move", from: "/a", to: "/b" });
  await appendFile(migrationLogFile(env), '{"at":"2026-09-24T', "utf8");

  expect((await log.read()).map((r) => r.kind)).toEqual(["config-move"]);
});
