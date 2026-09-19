/**
 * Step 33 — the upgrade that loses nothing.
 *
 * These cover the decisions: where a migrated project gets rooted, and that
 * every move is guarded, idempotent and non-destructive. The done-when's
 * "verified by upgrading a real alpha profile, not a fixture" clause is **not**
 * what this file proves — a synthesized legacy layout is a fixture by
 * definition, and CI cannot build the `v0.1.0-alpha` tag to make a real one.
 * That clause is discharged by the recorded upgrade of an actual alpha profile
 * in PLAN-STEP.MD's retrospective; this file is what keeps it from regressing.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import {
  legacyProjectRoot,
  migrateLegacyConfig,
  migrateLegacyRuns,
} from "./migrate.js";
import {
  configDir,
  configFile,
  projectConfigFile,
  projectRunsDir,
  runsDir,
  type HostEnv,
} from "./paths.js";

let home: string;
let env: HostEnv;

const ID = "api-3f2a1b";

beforeEach(async () => {
  // `realpath` because macOS resolves `/tmp` to `/private/tmp`, and the
  // derivation compares resolved paths — a test that skipped this would fail
  // for a reason that has nothing to do with the code.
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-mig-")));
  env = { platform: process.platform, homedir: home };
  await mkdir(configDir(env), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A legacy global config naming `stations`, written where alpha kept it. */
async function legacyConfig(
  stations: { id: string; workspace?: string }[],
): Promise<string> {
  const text = stations
    .map(
      (station) =>
        `[[station]]\nid = ${JSON.stringify(station.id)}\n` +
        `harness = "claude-code"\nrole = "engineer"\n` +
        (station.workspace === undefined
          ? ""
          : `workspace = ${JSON.stringify(station.workspace)}\n`),
    )
    .join("\n");
  await writeFile(configFile(env), text, "utf8");
  return text;
}

async function workspace(name: string): Promise<string> {
  const dir = path.join(home, "code", name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** What `loadConfig` would have returned for the legacy global file. */
async function loadedGlobal() {
  return parseConfig(await readFile(configFile(env), "utf8"), configFile(env));
}

describe("legacyProjectRoot", () => {
  it("is null when there is no config anywhere", async () => {
    const loaded = parseConfig("", null);
    expect(await legacyProjectRoot(loaded, env)).toBeNull();
  });

  it("uses the containing folder when the config is in a repo", async () => {
    const repo = await workspace("api");
    const loaded = parseConfig("[desk]\n", path.join(repo, "cuesheet.toml"));
    expect(await legacyProjectRoot(loaded, env)).toBe(repo);
  });

  it("derives the root from a unanimous Station workspace", async () => {
    const repo = await workspace("api");
    await legacyConfig([
      { id: "eng", workspace: repo },
      { id: "rev", workspace: repo },
    ]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(repo);
  });

  it("ignores Stations with no workspace rather than counting them as disagreement", async () => {
    const repo = await workspace("api");
    await legacyConfig([{ id: "eng", workspace: repo }, { id: "rev" }]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(repo);
  });

  it("expands `~` in a workspace before comparing", async () => {
    await workspace("api");
    await legacyConfig([{ id: "eng", workspace: "~/code/api" }]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(
      await realpath(path.join(home, "code", "api")),
    );
  });

  it("falls back to ~/.cuesheet when Stations disagree", async () => {
    await legacyConfig([
      { id: "eng", workspace: await workspace("api") },
      { id: "web", workspace: await workspace("web") },
    ]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(
      configDir(env),
    );
  });

  it("falls back to ~/.cuesheet when no Station names a workspace", async () => {
    await legacyConfig([{ id: "eng" }]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(
      configDir(env),
    );
  });

  /**
   * The guard that matters most. `projectConfigSearchPaths` prefers
   * `<root>/cuesheet.toml`, so rooting a migrated project at a folder that has
   * one would hand it the project and make every alpha Station vanish. Staying
   * at `~/.cuesheet` keeps the legacy file as candidate one.
   */
  it("refuses a derived root that already has its own cuesheet.toml", async () => {
    const repo = await workspace("api");
    await writeFile(path.join(repo, "cuesheet.toml"), "[desk]\n", "utf8");
    await legacyConfig([{ id: "eng", workspace: repo }]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(
      configDir(env),
    );
  });

  it("skips a workspace that is no longer on disk", async () => {
    const repo = await workspace("api");
    await legacyConfig([
      { id: "eng", workspace: repo },
      { id: "gone", workspace: path.join(home, "code", "deleted") },
    ]);
    expect(await legacyProjectRoot(await loadedGlobal(), env)).toBe(repo);
  });
});

describe("migrateLegacyConfig", () => {
  it("moves the global config to the project's private path, byte for byte", async () => {
    const text = await legacyConfig([{ id: "eng", workspace: home }]);
    const moved = await migrateLegacyConfig({
      projectId: ID,
      root: path.join(home, "code"),
      sourcePath: configFile(env),
      env,
    });

    expect(moved).toEqual({
      from: configFile(env),
      to: projectConfigFile(ID, env),
    });
    expect(await readFile(projectConfigFile(ID, env), "utf8")).toBe(text);
    await expect(readFile(configFile(env), "utf8")).rejects.toThrow();
  });

  it("does nothing when the project is rooted at ~/.cuesheet", async () => {
    // The legacy file is already candidate one for that root, so moving it
    // would take a live config out of the search path for no gain.
    await legacyConfig([{ id: "eng" }]);
    expect(
      await migrateLegacyConfig({
        projectId: ID,
        root: configDir(env),
        sourcePath: configFile(env),
        env,
      }),
    ).toBeNull();
    expect(await readFile(configFile(env), "utf8")).toContain("eng");
  });

  it("does nothing when there is no legacy config", async () => {
    expect(
      await migrateLegacyConfig({
        projectId: ID,
        root: home,
        sourcePath: configFile(env),
        env,
      }),
    ).toBeNull();
  });

  /**
   * The case the first draft got wrong. A user can have a repo config *and* a
   * leftover global one — alpha's `addStation` wrote the global file whenever
   * the loader found nothing, which is what a Finder-launched app always got.
   * Guarding on "is this project rooted somewhere other than `~/.cuesheet`"
   * moved that global file under a project whose repo config shadows it.
   */
  it("leaves the global config alone when the repo's is what loaded", async () => {
    const repo = await workspace("api");
    await writeFile(path.join(repo, "cuesheet.toml"), "[desk]\n", "utf8");
    await legacyConfig([{ id: "eng" }]);

    expect(
      await migrateLegacyConfig({
        projectId: ID,
        root: repo,
        sourcePath: path.join(repo, "cuesheet.toml"),
        env,
      }),
    ).toBeNull();
    expect(await readFile(configFile(env), "utf8")).toContain("eng");
  });

  it("never overwrites a config the project already has", async () => {
    await legacyConfig([{ id: "old" }]);
    await mkdir(path.dirname(projectConfigFile(ID, env)), { recursive: true });
    await writeFile(
      projectConfigFile(ID, env),
      "[desk]\nname = 'new'\n",
      "utf8",
    );

    expect(
      await migrateLegacyConfig({
        projectId: ID,
        root: home,
        sourcePath: configFile(env),
        env,
      }),
    ).toBeNull();
    expect(await readFile(projectConfigFile(ID, env), "utf8")).toContain("new");
  });
});

describe("migrateLegacyRuns", () => {
  async function legacyRun(id: string): Promise<void> {
    await mkdir(path.join(runsDir(env), id), { recursive: true });
    await writeFile(
      path.join(runsDir(env), id, "run.json"),
      JSON.stringify({ id, status: "done" }),
      "utf8",
    );
  }

  it("moves the whole history under the project", async () => {
    await legacyRun("20250101T000000Z-aaaaaa");
    await legacyRun("20250102T000000Z-bbbbbb");

    const moved = await migrateLegacyRuns({ projectId: ID, env });

    expect(moved).toEqual({ from: runsDir(env), to: projectRunsDir(ID, env) });
    expect(
      await readFile(
        path.join(
          projectRunsDir(ID, env),
          "20250102T000000Z-bbbbbb",
          "run.json",
        ),
        "utf8",
      ),
    ).toContain("bbbbbb");
  });

  it("is idempotent — a second call moves nothing", async () => {
    await legacyRun("20250101T000000Z-aaaaaa");
    await migrateLegacyRuns({ projectId: ID, env });
    expect(await migrateLegacyRuns({ projectId: ID, env })).toBeNull();
  });

  it("leaves a project that already has runs alone", async () => {
    await legacyRun("20250101T000000Z-aaaaaa");
    await mkdir(projectRunsDir(ID, env), { recursive: true });

    expect(await migrateLegacyRuns({ projectId: ID, env })).toBeNull();
    // And the legacy history is still there to be rescued by hand.
    expect(
      await readFile(
        path.join(runsDir(env), "20250101T000000Z-aaaaaa", "run.json"),
        "utf8",
      ),
    ).toContain("aaaaaa");
  });

  it("does nothing for an empty legacy directory", async () => {
    await mkdir(runsDir(env), { recursive: true });
    expect(await migrateLegacyRuns({ projectId: ID, env })).toBeNull();
  });

  it("does nothing when there is no legacy directory", async () => {
    expect(await migrateLegacyRuns({ projectId: ID, env })).toBeNull();
  });
});
