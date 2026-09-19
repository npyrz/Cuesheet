import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectRegistry,
  mintProjectId,
  PROJECT_REGISTRY_VERSION,
  ProjectRegistryError,
  slugForRoot,
  type ProjectRegistry,
} from "./project.js";
import {
  isProjectId,
  PROJECT_ID_PATTERN,
  projectConfigFile,
  projectDir,
  type HostEnv,
} from "./paths.js";

const WINDOWS: HostEnv = { platform: "win32", homedir: "C:\\Users\\noah" };

/**
 * `realpath` because macOS resolves `/tmp` to `/private/tmp`, and the registry
 * stores resolved roots. Without this every assertion comparing a stored root
 * against a path the test built would fail for a reason that has nothing to do
 * with the code under test.
 */
async function scratch(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "cuesheet-project-")));
}

async function registry(): Promise<{
  reg: ProjectRegistry;
  file: string;
  home: string;
}> {
  const home = await scratch();
  const file = join(home, "projects.json");
  return { reg: createProjectRegistry({ file }), file, home };
}

async function folder(home: string, name: string): Promise<string> {
  const path = join(home, name);
  await mkdir(path, { recursive: true });
  return path;
}

describe("project ids", () => {
  it("is a safe path segment", () => {
    // The id becomes a directory name under `~/.cuesheet/projects`, so it is
    // gated the way `isRunId` gates anything reaching the filesystem.
    expect(isProjectId("api-3f2a1b")).toBe(true);
    expect(isProjectId("../etc-3f2a1b")).toBe(false);
    expect(isProjectId("api/3f2a1b")).toBe(false);
    expect(isProjectId("api-3f2a1b/..")).toBe(false);
    expect(isProjectId("")).toBe(false);
    expect(isProjectId(null)).toBe(false);
  });

  it("rejects uppercase, because Windows would fold it into a collision", () => {
    // `API-3f2a1b` and `api-3f2a1b` are two ids and one directory on Windows.
    // Restricting the alphabet makes that unrepresentable rather than handled.
    expect(isProjectId("API-3f2a1b")).toBe(false);
    expect(mintProjectId("/code/API")).toMatch(PROJECT_ID_PATTERN);
  });

  it("keeps the folder name readable in the id", () => {
    expect(mintProjectId("/code/api", undefined, "3f2a1b")).toBe("api-3f2a1b");
  });

  it("survives folder names that slug to nothing", () => {
    // A root of `/` has no basename, and a folder named in a non-Latin script
    // has no `[a-z0-9]` at all. Both still have to produce a valid segment.
    expect(slugForRoot("/")).toBe("project");
    expect(slugForRoot("/code/日本語")).toBe("project");
    expect(mintProjectId("/", undefined, "3f2a1b")).toMatch(PROJECT_ID_PATTERN);
    expect(mintProjectId("/code/日本語", undefined, "3f2a1b")).toMatch(
      PROJECT_ID_PATTERN,
    );
  });

  it("makes a Windows device name harmless rather than illegal", () => {
    // `con` and `lpt1` cannot be directory names on Windows at all. The suffix
    // is what keeps a folder called `con` from minting one — the reservation
    // matches the whole name, not a prefix.
    expect(mintProjectId("C:\\code\\con", WINDOWS, "3f2a1b")).toBe(
      "con-3f2a1b",
    );
    expect(mintProjectId("C:\\code\\lpt1", WINDOWS, "3f2a1b")).toBe(
      "lpt1-3f2a1b",
    );
  });

  it("refuses to build a path from anything that is not one", () => {
    // The point of the pattern. Step 32 hands `/projects/:id/...` straight to
    // these builders, so a documented obligation is not enough — an earlier
    // draft asked callers to validate first, which is a guard nobody runs.
    expect(() => projectDir("../../etc")).toThrow(/not a project id/i);
    expect(() => projectConfigFile("..")).toThrow(/not a project id/i);
    expect(() => projectDir("api-3f2a1b/..")).toThrow(/not a project id/i);
    expect(() => projectDir("API-3f2a1b")).toThrow(/not a project id/i);
    expect(() => projectDir("api-3f2a1b")).not.toThrow();
  });

  it("trims a long folder name without leaving a trailing dash", () => {
    const id = mintProjectId(`/code/${"a-".repeat(40)}`, undefined, "3f2a1b");
    expect(id).toMatch(PROJECT_ID_PATTERN);
    expect(id).not.toMatch(/--/);
  });
});

describe("opening a project", () => {
  it("adds it, names it after the folder, and records it as opened", async () => {
    const { reg, home } = await registry();
    const root = await folder(home, "api");

    const project = await reg.open(root);

    expect(project.id).toMatch(PROJECT_ID_PATTERN);
    expect(project.name).toBe("api");
    expect(project.root).toBe(root);
    expect(project.lastOpenedAt).not.toBeNull();
    expect(await reg.lastOpened()).toMatchObject({ id: project.id });
  });

  it("is idempotent — the same folder is one project, opened twice", async () => {
    const { reg, home } = await registry();
    const root = await folder(home, "api");

    const first = await reg.open(root, {
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const second = await reg.open(root, {
      now: new Date("2026-02-02T00:00:00Z"),
    });

    expect(second.id).toBe(first.id);
    expect(second.addedAt).toBe(first.addedAt);
    expect(second.lastOpenedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(await reg.list()).toHaveLength(1);
  });

  it("treats a symlink and its target as one project", async () => {
    // The `observe.ts` lesson, applied before it costs anything: a path and a
    // link to it are the same folder. Resolving at open time is what stops a
    // linked checkout from minting a second project every time it is opened.
    const { reg, home } = await registry();
    const root = await folder(home, "api");
    const link = join(home, "api-link");
    // A junction rather than a symlink on Windows: a directory symlink needs
    // Developer Mode or elevation, a junction needs neither.
    await symlink(
      root,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const direct = await reg.open(root);
    const viaLink = await reg.open(link);

    expect(viaLink.id).toBe(direct.id);
    expect(viaLink.root).toBe(root);
    expect(await reg.list()).toHaveLength(1);
  });

  it("accepts a display name that is not the folder name", async () => {
    const { reg, home } = await registry();
    const root = await folder(home, "api");
    expect((await reg.open(root, { name: "Payments API" })).name).toBe(
      "Payments API",
    );
  });

  it("refuses a folder that is not there, distinctly from one that went away", async () => {
    const { reg, home } = await registry();
    await expect(reg.open(join(home, "nope"))).rejects.toThrow(
      ProjectRegistryError,
    );
    await expect(reg.open(join(home, "nope"))).rejects.toThrow(
      /no such folder/i,
    );
  });

  it("refuses a file", async () => {
    const { reg, home } = await registry();
    const file = join(home, "cuesheet.toml");
    await writeFile(file, "", "utf8");
    await expect(reg.open(file)).rejects.toThrow(/not a folder/i);
  });

  it("matches roots case-insensitively on Windows only", async () => {
    // Two entries differing only in case are one folder on Windows. The env is
    // injected rather than mocked, because mocking `process.platform` would not
    // change which `path` implementation is bound.
    const { home } = await registry();
    const file = join(home, "win.json");
    await writeFile(
      file,
      JSON.stringify({
        version: PROJECT_REGISTRY_VERSION,
        lastOpenedId: "api-aaaaaa",
        projects: [
          {
            id: "api-aaaaaa",
            name: "api",
            root: join(home, "api").toUpperCase(),
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: null,
          },
        ],
      }),
      "utf8",
    );
    const root = await folder(home, "api");

    const onWindows = createProjectRegistry({ file, env: WINDOWS });
    expect((await onWindows.open(root)).id).toBe("api-aaaaaa");
  });

  it("keeps a case-differing root distinct everywhere else", async () => {
    // The negative half, without which the test above proves only that *some*
    // match happened. This file already has a retrospective about a test that
    // asserted one side of a platform switch and looked like it covered both.
    const { home } = await registry();
    const file = join(home, "posix.json");
    await writeFile(
      file,
      JSON.stringify({
        version: PROJECT_REGISTRY_VERSION,
        lastOpenedId: "api-aaaaaa",
        projects: [
          {
            id: "api-aaaaaa",
            name: "api",
            root: join(home, "api").toUpperCase(),
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: null,
          },
        ],
      }),
      "utf8",
    );
    const root = await folder(home, "api");

    const onPosix = createProjectRegistry({
      file,
      env: { platform: "linux", homedir: home },
    });
    expect((await onPosix.open(root)).id).not.toBe("api-aaaaaa");
    expect(await onPosix.list()).toHaveLength(2);
  });

  it("holds a display name to the same rule as renaming does", async () => {
    // Two entry points writing one field. `rename` rejected a blank name from
    // the start; `open` used to store whatever it was handed.
    const { reg, home } = await registry();
    const root = await folder(home, "api");
    await expect(reg.open(root, { name: "   " })).rejects.toThrow(
      /cannot be empty/i,
    );
    expect((await reg.open(root, { name: "  Payments  " })).name).toBe(
      "Payments",
    );
  });
});

describe("listing", () => {
  it("reports a project whose folder is gone as missing, and does not throw", async () => {
    // Step 31's done-when. A picker that crashes because somebody deleted a
    // folder is worse than one that says so.
    const { reg, home } = await registry();
    const kept = await folder(home, "kept");
    const removed = await folder(home, "removed");
    await reg.open(kept);
    await reg.open(removed);
    await rm(removed, { recursive: true });

    const listed = await reg.list();

    expect(listed).toHaveLength(2);
    expect(listed.find((p) => p.name === "kept")?.status).toBe("ok");
    expect(listed.find((p) => p.name === "removed")?.status).toBe("missing");
  });

  it("cannot tell a renamed folder from a deleted one, and does not pretend to", async () => {
    // There is no `moved` status on purpose. A rename leaves exactly the same
    // evidence as a delete, so claiming to distinguish them would be a guess
    // presented to the user as a fact.
    const { reg, home } = await registry();
    const root = await folder(home, "before");
    await reg.open(root);
    await rm(root, { recursive: true });
    await folder(home, "after");

    const [only] = await reg.list();
    expect(only?.status).toBe("missing");
  });

  it("puts the most recently opened first", async () => {
    const { reg, home } = await registry();
    const a = await folder(home, "alpha");
    const b = await folder(home, "beta");
    await reg.open(a, { now: new Date("2026-01-01T00:00:00Z") });
    await reg.open(b, { now: new Date("2026-03-03T00:00:00Z") });
    await reg.open(a, { now: new Date("2026-05-05T00:00:00Z") });

    expect((await reg.list()).map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  it("answers on a fresh install rather than failing on a missing file", async () => {
    const { reg } = await registry();
    expect(await reg.list()).toEqual([]);
    expect(await reg.lastOpened()).toBeNull();
  });
});

describe("durability", () => {
  it("reads back what a previous registry wrote over the same file", async () => {
    // Not the daemon restart Step 31's done-when describes — there is no daemon
    // in this step. This is the mechanism that restart will rely on: nothing is
    // held in memory that is not on disk.
    const { reg, file, home } = await registry();
    const root = await folder(home, "api");
    const written = await reg.open(root, { name: "Payments" });

    const reopened = createProjectRegistry({ file });

    expect(await reopened.get(written.id)).toEqual(written);
    expect(await reopened.lastOpened()).toEqual(written);
  });

  it("serializes concurrent opens instead of losing one", async () => {
    // Every mutation is a read-modify-write of one file, and two windows
    // opening two projects at once is the realistic way to race it.
    const { reg, home } = await registry();
    const roots = await Promise.all(
      ["a", "b", "c", "d", "e"].map((name) => folder(home, name)),
    );

    await Promise.all(roots.map((root) => reg.open(root)));

    expect(await reg.list()).toHaveLength(5);
  });

  it("writes a BOM-tolerant reader, because Windows tools write one", async () => {
    // The lesson `parseConfig` learned the expensive way, applied on day one.
    const { file } = await registry();
    await writeFile(
      file,
      `\uFEFF${JSON.stringify({
        version: PROJECT_REGISTRY_VERSION,
        lastOpenedId: null,
        projects: [],
      })}`,
      "utf8",
    );
    await expect(createProjectRegistry({ file }).list()).resolves.toEqual([]);
  });

  it("drops an unreadable entry rather than the whole list", async () => {
    const { file, home } = await registry();
    const root = await folder(home, "api");
    await writeFile(
      file,
      JSON.stringify({
        version: PROJECT_REGISTRY_VERSION,
        lastOpenedId: null,
        projects: [
          { id: "NOT A VALID ID", name: "junk", root: "/x" },
          {
            id: "api-aaaaaa",
            name: "api",
            root,
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: null,
          },
        ],
      }),
      "utf8",
    );
    expect(
      (await createProjectRegistry({ file }).list()).map((p) => p.id),
    ).toEqual(["api-aaaaaa"]);
  });
});

describe("refusing to destroy a list it cannot read", () => {
  it("throws on invalid JSON and leaves the file byte-for-byte", async () => {
    // Deliberately a different answer from `config.ts`'s, for a different
    // reason: that one throws so a typo is not hidden, this one throws so a
    // project list is not discarded. Starting from empty would be data loss,
    // which the beta bar forbids outright.
    const { file } = await registry();
    const damaged = '{"version":1,"projects":[';
    await writeFile(file, damaged, "utf8");
    const reg = createProjectRegistry({ file });

    await expect(reg.list()).rejects.toThrow(ProjectRegistryError);
    await expect(reg.list()).rejects.toThrow(/left untouched/i);
    expect(await readFile(file, "utf8")).toBe(damaged);
  });

  it("refuses a registry written by a newer build, and says which way to go", async () => {
    // Step 53 promises this as a mechanism. It is three lines here and a
    // migration later.
    const { file } = await registry();
    const future = JSON.stringify({
      version: PROJECT_REGISTRY_VERSION + 1,
      lastOpenedId: null,
      projects: [],
    });
    await writeFile(file, future, "utf8");

    await expect(createProjectRegistry({ file }).list()).rejects.toThrow(
      /newer version/i,
    );
    expect(await readFile(file, "utf8")).toBe(future);
  });

  it("refuses a file that parses but is not a registry", async () => {
    const { file } = await registry();
    await writeFile(file, "[]", "utf8");
    await expect(createProjectRegistry({ file }).list()).rejects.toThrow(
      /not a project registry/i,
    );
  });

  it("does not write through a mutation either", async () => {
    const { file, home } = await registry();
    const damaged = "not json at all";
    await writeFile(file, damaged, "utf8");
    const root = await folder(home, "api");

    await expect(createProjectRegistry({ file }).open(root)).rejects.toThrow(
      ProjectRegistryError,
    );
    expect(await readFile(file, "utf8")).toBe(damaged);
  });
});

describe("renaming and forgetting", () => {
  it("renames without touching anything else", async () => {
    const { reg, home } = await registry();
    const project = await reg.open(await folder(home, "api"));
    const renamed = await reg.rename(project.id, "  Payments API  ");

    expect(renamed.name).toBe("Payments API");
    expect(renamed.id).toBe(project.id);
    expect(renamed.root).toBe(project.root);
  });

  it("refuses an empty name and an unknown id", async () => {
    const { reg, home } = await registry();
    const project = await reg.open(await folder(home, "api"));
    await expect(reg.rename(project.id, "   ")).rejects.toThrow(
      /cannot be empty/i,
    );
    await expect(reg.rename("nope-aaaaaa", "x")).rejects.toThrow(/No project/i);
  });

  it("forgets the entry and clears it as last-opened", async () => {
    // Otherwise the next launch reopens a project that is no longer listed.
    const { reg, home } = await registry();
    const project = await reg.open(await folder(home, "api"));

    expect(await reg.forget(project.id)).toBe(true);
    expect(await reg.list()).toEqual([]);
    expect(await reg.lastOpened()).toBeNull();
    expect(await reg.forget(project.id)).toBe(false);
  });

  it("leaves the folder alone", async () => {
    const { reg, home } = await registry();
    const root = await folder(home, "api");
    const project = await reg.open(root);
    await reg.forget(project.id);
    expect(await realpath(root)).toBe(root);
  });
});
