/**
 * Step 46's done-when: a fact written through the store is a committed file on
 * disk, and `git log` explains where it came from.
 *
 * Every test here gets its own root. `commonsDir(env)` resolves under
 * `homedir`, and the testing conventions are explicit that writing into the
 * developer's real `~/.cuesheet` is invisible locally and permanent.
 */
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, which } from "@cuesheet/harness";
import { createCommonsStore, CommonsError } from "./commons.js";
import { createCommonsInbox } from "./commons-inbox.js";
import { startDaemon, type DaemonHandle } from "./server.js";

let root: string;

beforeEach(async () => {
  // `realpath` because /var is a symlink to /private/var on macOS and git
  // reports the resolved path back.
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-commons-")),
  );
});

const store = (over: Parameters<typeof createCommonsStore>[0] = {}) =>
  createCommonsStore({ root, ...over });

/** Skipped where git is absent rather than failing for the environment. */
const hasGit = async () => (await which("git")) !== null;

describe("the Commons store", () => {
  it("writes a fact as a file an operator could have typed", async () => {
    const written = await store().write({
      title: "Rate limiting is keyed on account",
      body: "IP keys break behind the proxy.",
      tags: ["api"],
      station: "opus",
      run: "20260916T101500000Z-0001",
    });

    expect(written.fact.id).toBe("rate-limiting-is-keyed-on-account");
    const text = await readFile(
      path.join(root, "rate-limiting-is-keyed-on-account.md"),
      "utf8",
    );
    expect(text).toContain("+++");
    expect(text).toContain("IP keys break behind the proxy.");
    // Provenance in the frontmatter — what Step 47's projection and Step 48's
    // inbox read.
    expect(text).toContain('station = "opus"');
  });

  it("reads back what it wrote", async () => {
    const s = store();
    await s.write({
      id: "leash",
      title: "Leashes are enforced",
      body: "In the daemon.",
    });
    const fact = await s.get("leash");
    expect(fact).toMatchObject({
      id: "leash",
      title: "Leashes are enforced",
      body: "In the daemon.",
    });
  });

  it("lists facts and skips a file somebody hand-edited into something else", async () => {
    const s = store();
    await s.write({ id: "good", title: "A good fact", body: "body" });
    await writeFile(path.join(root, "broken.md"), "not frontmatter\n", "utf8");
    await writeFile(path.join(root, "notes.txt"), "ignored", "utf8");

    const ids = (await s.list()).map((fact) => fact.id);
    // One bad file must not make the whole store unlistable — Step 48's inbox
    // is where a malformed fact gets shown to a human, and it is unreachable
    // if listing throws.
    expect(ids).toEqual(["good"]);
  });

  it("is empty rather than broken before anything has been written", async () => {
    const fresh = createCommonsStore({ root: path.join(root, "nothing-here") });
    expect(await fresh.list()).toEqual([]);
    expect(await fresh.get("anything")).toBeNull();
  });

  it("survives being destructured, which `this` would not have", async () => {
    // `remove` used to call `this.get(...)`. That works only while the method
    // is called *as* a method — destructure the store, or hand `remove` to a
    // callback, and `this` is undefined. Nothing in these tests did that, so
    // nothing caught it.
    const s = store();
    await s.write({ id: "loose", title: "Loose", body: "x" });
    const { get, remove } = s;
    expect(await get("loose")).toMatchObject({ title: "Loose" });
    expect((await remove("loose"))?.fact.title).toBe("Loose");
  });

  it("removes a fact and says it existed", async () => {
    const s = store();
    await s.write({ id: "gone", title: "Temporary", body: "x" });
    expect((await s.remove("gone"))?.fact.title).toBe("Temporary");
    expect(await s.get("gone")).toBeNull();
    expect(await s.remove("gone")).toBeNull();
  });

  it("refuses an id that could leave the commons directory", async () => {
    // The path-traversal surface. Without this, a route handing through a user
    // string could delete the project registry.
    const s = store();
    await expect(s.get("../../projects")).rejects.toBeInstanceOf(CommonsError);
    await expect(s.remove("../../projects")).rejects.toBeInstanceOf(
      CommonsError,
    );
    await expect(
      s.write({ id: "../escape", title: "x", body: "y" }),
    ).rejects.toBeInstanceOf(CommonsError);
  });

  it("asks for an explicit id rather than inventing one", async () => {
    await expect(store().write({ title: "///", body: "y" })).rejects.toThrow(
      /explicit "id"/,
    );
  });

  it("does not fail a write when git is missing, and says why", async () => {
    // The README's promise is plain markdown in a folder. Losing history is a
    // degraded store; a write that throws because `git` is not on somebody's
    // PATH would be the wrong failure at the worst moment.
    const s = store({ gitBin: path.join(root, "definitely-not-git") });
    const written = await s.write({
      id: "offline",
      title: "Still a fact",
      body: "x",
    });

    expect(written.committed).toBe(false);
    expect(written.reason).toBeTruthy();
    // And the file is there regardless.
    expect(await s.get("offline")).toMatchObject({ title: "Still a fact" });
    expect(await s.history()).toEqual({
      commits: [],
      reason: expect.any(String),
    });
  });
});

describe("the Commons as a git repository", () => {
  it("commits a written fact, and git log says where it came from", async () => {
    if (!(await hasGit())) return;
    const s = store();
    const written = await s.write({
      title: "Gates count who acted",
      body: "Author included.",
      station: "codex",
      run: "20260916T120000000Z-0002",
    });

    expect(written.committed).toBe(true);

    // The literal done-when, asked of git rather than of our own return value.
    const bin = (await which("git")) as string;
    const log = await run(bin, ["log", "--pretty=format:%an <%ae>%n%s%n%b"], {
      cwd: root,
    });
    expect(log.code).toBe(0);
    expect(log.stdout).toContain("Cuesheet <commons@cuesheet.local>");
    expect(log.stdout).toContain("gates-count-who-acted");
    expect(log.stdout).toContain("Station: codex");
    expect(log.stdout).toContain("Run: 20260916T120000000Z-0002");

    // And the file is tracked, not merely sitting in the directory.
    const tracked = await run(bin, ["ls-files"], { cwd: root });
    expect(tracked.stdout).toContain("gates-count-who-acted.md");
  });

  it("commits without touching the operator's global git identity", async () => {
    // A fresh machine has no `user.email`, so an identity has to be supplied —
    // but writing one into the operator's global config to get it would be
    // Cuesheet changing how every other repository on the machine commits.
    if (!(await hasGit())) return;
    await store().write({ id: "identity", title: "x", body: "y" });

    const bin = (await which("git")) as string;
    const local = await run(bin, ["config", "--local", "user.email"], {
      cwd: root,
    });
    // Nothing written into the repo's config either: the identity rides on the
    // commit command itself.
    expect(local.stdout.trim()).toBe("");
  });

  it("pins line endings — including on the commit that introduces the rule", async () => {
    // Step 47 requires that re-running a projection twice produces no diff.
    // Without this the promise fails on Windows for a reason that has nothing
    // to do with projections.
    //
    // The non-obvious half is the *first* commit: `.gitattributes` is staged
    // in the same `git add -A` as the first fact, so it is fair to ask whether
    // it governs its own commit. It does — git reads attributes from the
    // working tree at stage time, not from HEAD — and this asserts the
    // committed bytes rather than the file's presence, because "the rule is
    // written down" and "the rule was applied" are different claims.
    if (!(await hasGit())) return;
    const s = store();
    await s.write({ id: "eol", title: "x", body: "line one\r\nline two" });

    expect(await readFile(path.join(root, ".gitattributes"), "utf8")).toContain(
      "eol=lf",
    );

    const bin = (await which("git")) as string;
    const blob = await run(bin, ["show", ":eol.md"], { cwd: root });
    expect(blob.code).toBe(0);
    expect(blob.stdout).not.toContain("\r");
  });

  it("does not re-initialise a repository that already exists", async () => {
    if (!(await hasGit())) return;
    const s = store();
    await s.write({ id: "first", title: "First", body: "x" });
    await s.write({ id: "second", title: "Second", body: "y" });

    const { commits } = await s.history();
    expect(commits).toHaveLength(2);
    expect(commits[0]).toContain("second");
    expect(commits[1]).toContain("first");
  });

  it("treats an unchanged rewrite as committed rather than as a failure", async () => {
    // Writing the same fact twice changes no bytes, so `git commit` exits
    // non-zero with "nothing to commit". The caller asked for the fact to be
    // true, and it is.
    if (!(await hasGit())) return;
    const s = store({ now: () => new Date("2026-09-16T10:00:00.000Z") });
    await s.write({ id: "stable", title: "Stable", body: "x" });
    const again = await s.write({ id: "stable", title: "Stable", body: "x" });
    expect(again.committed).toBe(true);
    expect(again.reason).toBeUndefined();
  });

  it("records a removal in history too", async () => {
    if (!(await hasGit())) return;
    const s = store();
    await s.write({ id: "temporary", title: "Temporary", body: "x" });
    await s.remove("temporary");
    expect((await s.history()).commits[0]).toContain("Remove temporary");
  });
});

describe("the Commons through the API", () => {
  let daemon: DaemonHandle | null = null;

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
  });

  /** An isolated home *and* an explicit commons root. Never the developer's. */
  async function boot(): Promise<{ url: string; home: string }> {
    const home = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-commons-api-")),
    );
    daemon = await startDaemon({
      port: 0,
      env: { platform: process.platform, homedir: home },
      cwd: home,
      writeLockFile: false,
      commons: createCommonsStore({ root }),
      commonsInbox: createCommonsInbox({
        root: path.join(home, ".cuesheet", "commons-inbox"),
      }),
      contextFiles: () => [
        { path: "CLAUDE.md", scope: "project" },
        { path: "AGENTS.md", scope: "project" },
      ],
    });
    return { url: daemon.url, home };
  }

  const post = (url: string, body: unknown) =>
    fetch(`${url}/commons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("writes a fact, commits it, and git log explains where it came from", async () => {
    // Step 46's done-when, end to end and through HTTP, which is what "written
    // through the API" means.
    const { url } = await boot();
    const response = await post(url, {
      title: "A worker never writes",
      body: "The facade refuses before the leash is consulted.",
      tags: ["roles"],
      station: "opus",
      run: "20260916T090000000Z-0001",
    });
    expect(response.status).toBe(201);

    const written = (await response.json()) as {
      fact: { id: string };
      committed: boolean;
    };
    expect(written.fact.id).toBe("a-worker-never-writes");

    if (await hasGit()) {
      expect(written.committed).toBe(true);
      const log = await run(
        (await which("git")) as string,
        ["log", "-1", "--pretty=%s%n%b"],
        {
          cwd: root,
        },
      );
      expect(log.stdout).toContain("a-worker-never-writes");
      expect(log.stdout).toContain("Station: opus");
    }

    // And it is readable back over the same surface.
    const listed = (await (await fetch(`${url}/commons`)).json()) as {
      facts: { id: string }[];
    };
    expect(listed.facts.map((f) => f.id)).toEqual(["a-worker-never-writes"]);
  });

  it("400s a fact id that could escape the commons directory", async () => {
    // The path traversal, at the boundary where a user string arrives. Without
    // the check this deletes whatever the path resolves to.
    const { url } = await boot();
    for (const bad of ["..%2f..%2fprojects", "not a slug", "UPPER"]) {
      expect((await fetch(`${url}/commons/${bad}`)).status).toBe(400);
      expect(
        (await fetch(`${url}/commons/${bad}`, { method: "DELETE" })).status,
      ).toBe(400);
    }
    expect(
      (await post(url, { id: "../escape", title: "x", body: "y" })).status,
    ).toBe(400);
  });

  it("404s a fact nobody wrote, and 400s a body that is not one", async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/commons/absent`)).status).toBe(404);
    expect((await post(url, { body: "no title" })).status).toBe(400);
    expect((await post(url, { title: "no body" })).status).toBe(400);
  });

  it("removes a fact and reports the removal", async () => {
    const { url } = await boot();
    await post(url, { id: "temporary", title: "Temporary", body: "x" });
    const removed = await fetch(`${url}/commons/temporary`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect((await fetch(`${url}/commons/temporary`)).status).toBe(404);
  });

  it("serves the history the store recorded", async () => {
    const { url } = await boot();
    await post(url, { id: "first", title: "First", body: "x" });
    const { commits } = (await (
      await fetch(`${url}/commons/history`)
    ).json()) as { commits: string[] };
    if (await hasGit()) {
      expect(commits[0]).toContain("first");
    } else {
      expect(commits).toEqual([]);
    }
  });

  async function openProject(
    url: string,
    home: string,
    config = "",
  ): Promise<{ id: string; root: string }> {
    const projectRoot = await mkdtemp(path.join(home, "project-"));
    const station = [
      "[[station]]",
      'id = "codex"',
      'harness = "mock"',
      'role = "engineer"',
      `workspace = '${projectRoot}'`,
      'paths = ["**"]',
      'deny = [".git/**"]',
      "",
    ].join("\n");
    await writeFile(
      path.join(projectRoot, "cuesheet.toml"),
      `${station}${config}`,
      "utf8",
    );
    const response = await fetch(`${url}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: projectRoot }),
    });
    const { project } = (await response.json()) as {
      project: { id: string; root: string };
    };
    return project;
  }

  const capture = (
    url: string,
    projectId: string,
    run: string,
    over: Record<string, unknown> = {},
  ) =>
    fetch(`${url}/projects/${projectId}/commons/captures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "The queue is per project",
        body: "Switching projects never stops a run.",
        station: "codex",
        run,
        ...over,
      }),
    });

  async function sourceRun(url: string, projectId: string): Promise<string> {
    const response = await fetch(`${url}/projects/${projectId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Capture a memory." }),
    });
    expect(response.status).toBe(202);
    return ((await response.json()) as { runId: string }).runId;
  }

  it("keeps captures pending and out of projections until approval", async () => {
    const { url, home } = await boot();
    const project = await openProject(url, home);
    const runId = await sourceRun(url, project.id);

    const captured = await capture(url, project.id, runId);
    expect(captured.status).toBe(202);
    const pending = (await captured.json()) as {
      status: string;
      memory: { id: string; suggestedId: string };
    };
    expect(pending.status).toBe("pending");
    expect(pending.memory.suggestedId).toBe("the-queue-is-per-project");
    expect((await store().list()).map(({ id }) => id)).toEqual([]);
    await expect(
      readFile(path.join(project.root, "CLAUDE.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const inbox = (await (await fetch(`${url}/commons/inbox`)).json()) as {
      pending: { id: string }[];
    };
    expect(inbox.pending.map(({ id }) => id)).toEqual([pending.memory.id]);

    const approved = await fetch(
      `${url}/commons/inbox/${pending.memory.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "queues-survive-switches",
          title: "Queues survive project switches",
          body: "A switch changes only the client subscription.",
          tags: ["projects"],
        }),
      },
    );
    expect(approved.status).toBe(200);
    expect((await store().get("queues-survive-switches"))?.provenance).toEqual({
      station: "codex",
      run: runId,
      at: expect.any(String),
    });
    expect(
      await readFile(path.join(project.root, "CLAUDE.md"), "utf8"),
    ).toContain("A switch changes only the client subscription.");
    expect(
      (
        (await (await fetch(`${url}/commons/inbox`)).json()) as {
          pending: unknown[];
        }
      ).pending,
    ).toEqual([]);
  });

  it("discards a capture without writing or projecting it", async () => {
    const { url, home } = await boot();
    const project = await openProject(url, home);
    const response = await capture(
      url,
      project.id,
      await sourceRun(url, project.id),
    );
    const { memory } = (await response.json()) as { memory: { id: string } };

    expect(
      (await fetch(`${url}/commons/inbox/${memory.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(await store().list()).toEqual([]);
    await expect(
      readFile(path.join(project.root, "AGENTS.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honours explicit auto approval while keeping inbox as the default", async () => {
    const { url, home } = await boot();
    const project = await openProject(
      url,
      home,
      '[commons]\napproval = "auto"\n',
    );
    const runId = await sourceRun(url, project.id);

    const response = await capture(url, project.id, runId, {
      title: "Auto is explicit",
      body: "Only this project opted out of review.",
    });
    expect(response.status).toBe(201);
    expect((await response.json()) as { status: string }).toMatchObject({
      status: "approved",
    });
    expect(await store().get("auto-is-explicit")).toMatchObject({
      body: "Only this project opted out of review.",
    });
    expect(
      (
        (await (await fetch(`${url}/commons/inbox`)).json()) as {
          pending: unknown[];
        }
      ).pending,
    ).toEqual([]);
    expect(
      await readFile(path.join(project.root, "AGENTS.md"), "utf8"),
    ).toContain("Only this project opted out of review.");
  });
});
