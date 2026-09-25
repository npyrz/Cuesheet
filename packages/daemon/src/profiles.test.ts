/**
 * Step 53's done-when: every released version's state opens on the current
 * build with nothing lost — proven by keeping the old profiles around and
 * running them in CI.
 *
 * Each directory under `fixtures/profiles` is what one *released* build left
 * on disk, captured by `scripts/capture-profile.mjs` driving that build's own
 * daemon over HTTP and then killing it with SIGKILL. Step 33 could only claim
 * its real-profile upgrade as a one-off, because CI cannot build an old tag;
 * CI can carry what an old tag wrote, which is the same move the harness
 * fixtures make for vendor streams.
 *
 * **The oracle is the old build, not this repository.** `manifest.json` is
 * what that build answered over its own routes just before it was killed, and
 * the current build is held to it route for route. Asserting against the
 * files instead would test this codebase's reading of an old format against
 * itself.
 *
 * **"Nothing lost" is checked as four separate claims**, because each has
 * failed separately somewhere in this plan: the project is still there and
 * rooted where it was; its Stations are the same Stations; every run is
 * listed, with every event and the same diff; and the Commons facts and the
 * pending inbox are intact. A run the old build left non-terminal comes back
 * `interrupted` — the one change the current build is *supposed* to make.
 *
 * **Each profile runs against both run stores.** SQLite is the default and
 * imports what the file store wrote; files is the operator's documented
 * escape hatch, and an escape hatch that loses history on the way out is not
 * one.
 *
 * Adding a release is adding a directory. Nothing in this file names one.
 */
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_VERSION,
  createProjectRegistry,
  projectConfigFile,
  projectRunsDir,
  type HostEnv,
  type MigrationRecord,
  type Run,
} from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import {
  openSqliteRunStore,
  RUNS_DB_FILENAME,
  RUNS_SCHEMA_VERSION,
  sqliteAvailable,
} from "./store-sqlite.js";
import type { RunStoreBackend } from "./store-backend.js";

const PROFILES = fileURLToPath(new URL("./fixtures/profiles", import.meta.url));
const TOKEN = "{{HOME}}";

interface ManifestRun {
  id: string;
  status: string;
  events: number;
  diff: string | null;
  run: Run;
}

interface ManifestProject {
  /** `null` for a build that had no projects — the alpha. */
  id: string | null;
  name: string | null;
  root: string | null;
  stations: unknown[];
  runs: ManifestRun[];
}

interface Manifest {
  tag: string;
  daemonVersion: string;
  workspaces: string[];
  projects: ManifestProject[];
  commons: { facts: unknown[]; pending: unknown[] } | null;
}

const NON_TERMINAL = new Set(["queued", "running", "standby"]);

const profiles = readdirSync(PROFILES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const backends: RunStoreBackend[] = (await sqliteAvailable())
  ? ["sqlite", "files"]
  : ["files"];

let home: string | null = null;
let daemon: DaemonHandle | null = null;

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
});

/**
 * The home as it appears inside a JSON or TOML string. Both formats escape a
 * backslash the same way, so on Windows `C:\Users\…` must arrive as
 * `C:\\Users\\…` or the file stops parsing; on POSIX this is the path itself.
 */
function escaped(dir: string): string {
  return JSON.stringify(dir).slice(1, -1);
}

/** Copy a profile into a fresh home, turning it back into what was captured. */
async function materialize(name: string): Promise<{
  home: string;
  env: HostEnv;
  manifest: Manifest;
}> {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-profile-")),
  );
  const state = path.join(dir, ".cuesheet");
  await cp(path.join(PROFILES, name, "cuesheet"), state, { recursive: true });
  await restore(state, dir);

  const manifest = JSON.parse(
    (await readFile(path.join(PROFILES, name, "manifest.json"), "utf8"))
      .split(TOKEN)
      .join(escaped(dir)),
  ) as Manifest;

  // The Stations' workspaces. They are the user's code rather than Cuesheet
  // state, so the profile does not carry them — but Step 33's root derivation
  // reads whether they exist, so they must, or the alpha profile would take a
  // different migration than a real alpha user gets.
  for (const workspace of manifest.workspaces) {
    await mkdir(path.join(dir, workspace), { recursive: true });
  }

  return {
    home: dir,
    env: { platform: process.platform, homedir: dir },
    manifest,
  };
}

/**
 * Undo the capture's scrub: `{{HOME}}` back to a path, and every `dot-git*`
 * back to `.git*` — the Commons store's repository and its `.gitattributes`,
 * both stored renamed so this repository neither nests a repo nor reads the
 * fixture's attributes as its own.
 */
async function restore(dir: string, homeDir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    let full = path.join(dir, entry.name);
    if (entry.name.startsWith("dot-git")) {
      const original = path.join(dir, `.${entry.name.slice("dot-".length)}`);
      await rename(full, original);
      // A repository's internals are binary and carry no home path.
      if (entry.isDirectory()) continue;
      full = original;
    }
    if (entry.isDirectory()) {
      await restore(full, homeDir);
      continue;
    }
    const text = await readFile(full, "utf8");
    if (!text.includes(TOKEN)) continue;
    const quoted = /\.(json|jsonl|toml)$/.test(entry.name);
    await writeFile(
      full,
      text.split(TOKEN).join(quoted ? escaped(homeDir) : homeDir),
    );
  }
}

async function boot(env: HostEnv, backend: RunStoreBackend) {
  daemon = await startDaemon({
    port: 0,
    env,
    // A cwd with no config — the packaged app's situation. Nothing may be
    // bootstrapped from it.
    cwd: path.join(env.homedir, "code"),
    writeLockFile: false,
    storeBackend: backend,
  });
  return daemon;
}

async function get<T>(handle: DaemonHandle, route: string): Promise<T> {
  const response = await fetch(`${handle.url}${route}`);
  expect(response.status, route).toBe(200);
  return (await response.json()) as T;
}

async function diffOf(
  handle: DaemonHandle,
  route: string,
): Promise<string | null> {
  const response = await fetch(`${handle.url}${route}`);
  if (response.status !== 200) return null;
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("json")) return text;
  const body = JSON.parse(text) as { diff?: string | null } | string;
  return typeof body === "string" ? body : (body.diff ?? null);
}

/** Every project this daemon lists, mapped onto the manifest's projects. */
async function pairProjects(
  handle: DaemonHandle,
  manifest: Manifest,
  homeDir: string,
): Promise<Array<{ id: string; expected: ManifestProject }>> {
  const { projects } = await get<{
    projects: Array<{ id: string; name: string; root: string; status: string }>;
  }>(handle, "/projects");

  if (manifest.projects.length === 1 && manifest.projects[0]?.id === null) {
    // A build with no projects. Step 33 roots the one it becomes at the folder
    // every Station agreed on, so that is where it must be — not at
    // `~/.cuesheet`, which would mean the root derivation silently fell back.
    const [only] = projects;
    expect(projects).toHaveLength(1);
    expect(await realpath(only!.root)).toBe(
      await realpath(path.join(homeDir, manifest.workspaces[0]!)),
    );
    expect(only!.status).toBe("ok");
    return [{ id: only!.id, expected: manifest.projects[0] }];
  }

  expect(projects.map((p) => p.id).sort()).toEqual(
    manifest.projects.map((p) => p.id).sort(),
  );
  return manifest.projects.map((expected) => {
    const found = projects.find((p) => p.id === expected.id)!;
    expect(found.name).toBe(expected.name);
    expect(path.resolve(found.root)).toBe(path.resolve(expected.root!));
    expect(found.status).toBe("ok");
    return { id: found.id, expected };
  });
}

/** Everything the current build says about one project, for comparing boots. */
async function readProject(handle: DaemonHandle, id: string) {
  const scope = `/projects/${id}`;
  const stations = await get<{ stations: Array<{ station: unknown }> }>(
    handle,
    `${scope}/stations`,
  );
  const listed = await get<{ runs: Run[] }>(handle, `${scope}/runs`);
  const runs = [];
  for (const run of listed.runs) {
    const stored = await get<{ run: Run; events: unknown[] }>(
      handle,
      `${scope}/runs/${run.id}`,
    );
    runs.push({
      run: stored.run,
      events: stored.events.length,
      diff: await diffOf(handle, `${scope}/runs/${run.id}/diff`),
    });
  }
  return { stations: stations.stations.map((s) => s.station), runs };
}

describe.each(profiles)("the %s profile", (name) => {
  it.each(backends)(
    "opens on this build with nothing lost (%s store)",
    async (backend) => {
      const materialized = await materialize(name);
      home = materialized.home;
      const { env, manifest } = materialized;

      const first = await boot(env, backend);
      const pairs = await pairProjects(first, manifest, home);
      const seen = new Map<string, Awaited<ReturnType<typeof readProject>>>();

      for (const { id, expected } of pairs) {
        const now = await readProject(first, id);
        seen.set(id, now);

        expect(now.stations, "stations").toEqual(expected.stations);
        expect(now.runs.map((r) => r.run.id).sort(), "run ids").toEqual(
          expected.runs.map((r) => r.id).sort(),
        );

        for (const want of expected.runs) {
          const got = now.runs.find((r) => r.run.id === want.id)!;
          const label = `${want.id} (${want.status})`;
          expect(got.events, `${label} events`).toBe(want.events);
          expect(got.diff, `${label} diff`).toBe(want.diff);

          if (NON_TERMINAL.has(want.status)) {
            // What a crash left mid-flight comes back `interrupted`, keeping
            // everything else it had — the cost it had run up included.
            const { status: _status, ...rest } = want.run;
            expect(got.run.status, label).toBe("interrupted");
            expect(got.run, label).toMatchObject(rest);
          } else {
            expect(got.run, label).toEqual(want.run);
          }
        }
      }

      if (manifest.commons) {
        const { facts } = await get<{ facts: unknown[] }>(first, "/commons");
        const { pending } = await get<{ pending: unknown[] }>(
          first,
          "/commons/inbox",
        );
        expect(facts, "commons facts").toEqual(manifest.commons.facts);
        expect(pending, "commons inbox").toEqual(manifest.commons.pending);
      }

      // What the upgrade recorded. Only migrations that changed something are
      // written, so the expected list is derivable from the profile alone.
      const { migrations } = await get<{ migrations: MigrationRecord[] }>(
        first,
        "/migrations",
      );
      const alpha = manifest.projects[0]?.id === null;
      const expectedKinds = [
        ...(alpha ? ["config-move", "runs-move"] : []),
        ...(backend === "sqlite"
          ? pairs
              .filter(({ expected }) => expected.runs.length > 0)
              .map(() => "runs-import")
          : []),
      ];
      expect(migrations.map((m) => m.kind).sort(), "migrations").toEqual(
        expectedKinds.sort(),
      );
      for (const record of migrations.filter((m) => m.kind === "runs-import")) {
        const pair = pairs.find(({ id }) => id === record.project)!;
        expect(record.detail).toContain(
          `Copied ${String(pair.expected.runs.length)} run(s)`,
        );
        expect(record.detail).not.toContain("unreadable");
      }

      // A second boot changes nothing and records nothing — the migration
      // ran once. Interrupted runs stay interrupted rather than being
      // reconciled into something else.
      await first.close();
      daemon = null;
      const second = await boot(env, backend);
      for (const { id } of pairs) {
        expect(await readProject(second, id), `reboot ${id}`).toEqual(
          seen.get(id),
        );
      }
      const after = await get<{ migrations: MigrationRecord[] }>(
        second,
        "/migrations",
      );
      expect(after.migrations, "second boot").toEqual(migrations);
    },
  );
});

it("carries a profile for every release the repository has published", () => {
  // Not the list of releases — the network is not a test dependency — but a
  // floor: the alpha, and every beta prerelease cut before this step. A
  // release published after it adds its own directory; see the script.
  expect(profiles).toEqual(
    expect.arrayContaining([
      "v0.1.0-alpha",
      "build-35749614938-150f136",
      "build-35765620187-4cf40ba",
      "build-35811098632-8a7d891",
    ]),
  );
});

/**
 * The other half of versioned state: what the current build does with state
 * from a build *newer* than itself. It must not read it, must not write it,
 * and — since one project's files are that project's problem — must not stop
 * serving every other project over it.
 */
describe("state written by a newer build", () => {
  async function projectWith(
    newer: (env: HostEnv, id: string) => Promise<string>,
  ) {
    home = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-newer-")),
    );
    const env: HostEnv = { platform: process.platform, homedir: home };
    const root = path.join(home, "code", "api");
    await mkdir(root, { recursive: true });
    const project = await createProjectRegistry({ env }).open(root);
    const file = await newer(env, project.id);
    return { env, project, file, before: await readFile(file) };
  }

  const cases: Array<
    [string, (env: HostEnv, id: string) => Promise<string>, RegExp]
  > = [
    [
      "a runs.db",
      async (env, id) => {
        const store = await openSqliteRunStore({
          root: projectRunsDir(id, env),
        });
        await store.close();
        const file = path.join(projectRunsDir(id, env), RUNS_DB_FILENAME);
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(file);
        raw.exec(`PRAGMA user_version = ${String(RUNS_SCHEMA_VERSION + 1)}`);
        raw.close();
        return file;
      },
      /newer Cuesheet/,
    ],
    [
      "a cuesheet.toml",
      async (env, id) => {
        const file = projectConfigFile(id, env);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `version = ${String(CONFIG_VERSION + 1)}\n`);
        return file;
      },
      /newer version of Cuesheet/,
    ],
  ];

  it.each(cases)(
    "boots anyway, refuses that project with a 409, and leaves %s untouched",
    async (label, newer, message) => {
      if (label === "a runs.db" && !backends.includes("sqlite")) return;
      const { env, project, file, before } = await projectWith(newer);

      const handle = await boot(env, "sqlite");
      const { projects } = await get<{ projects: Array<{ id: string }> }>(
        handle,
        "/projects",
      );
      expect(projects.map((p) => p.id)).toEqual([project.id]);
      expect(handle.defaultProject).toBeNull();

      const refused = await fetch(`${handle.url}/projects/${project.id}/runs`);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toMatch(
        message,
      );

      await handle.close();
      daemon = null;
      expect(await readFile(file)).toEqual(before);
    },
  );
});
