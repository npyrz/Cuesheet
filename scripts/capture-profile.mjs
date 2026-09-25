#!/usr/bin/env node
/**
 * Capture the state a *released* Cuesheet leaves on disk — Step 53.
 *
 * The same rule as the harness fixtures, applied to state: a migration is
 * written against a profile a real build actually wrote, never against this
 * repository's memory of what that build wrote. CI cannot build an old tag, but
 * it can carry what an old tag produced, so this script produces it once per
 * release and `packages/daemon/src/profiles.test.ts` replays it on every run.
 *
 *   git worktree add --detach /tmp/cs-old <tag>
 *   (cd /tmp/cs-old && npm ci && npm run build -w @cuesheet/core \
 *     -w @cuesheet/harness -w @cuesheet/daemon)
 *   node scripts/capture-profile.mjs <tag> /tmp/cs-old
 *   git worktree remove /tmp/cs-old
 *
 * What it does, and why each part is the way it is:
 *
 * - **It runs the release's own `startDaemon` and `harnessRuntime`**, in a
 *   child process whose `HOME` is a scratch directory. That is `main.ts` minus
 *   the fixed port, so nothing here is a reimplementation of the old build.
 * - **It drives the daemon only over HTTP**, through the routes that build
 *   shipped — Stations are added the way the Desk adds them, so the config on
 *   disk is the one the release's own writer produced.
 * - **It records what the old build answered** (`manifest.json`) before it
 *   kills it. The test holds the current build to *that*, rather than to a
 *   reading of the files that this repository would have to get right first.
 * - **It ends with SIGKILL, not a clean close,** leaving one run `standby` and
 *   one `queued` — the state a crash leaves, and the one a migration most
 *   needs to carry forward and reconcile.
 * - **It scrubs rather than redacts:** the scratch home becomes the token
 *   `{{HOME}}` wherever it appears in a text file, and the Commons store's
 *   `.git` is stored as `dot-git`, because a nested `.git` cannot be committed
 *   inside this repository. The test reverses both.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [tag, worktreeArg] = process.argv.slice(2);
if (!tag || !worktreeArg) {
  console.error(
    "usage: node scripts/capture-profile.mjs <tag> <built-worktree>",
  );
  process.exit(2);
}
const worktree = path.resolve(worktreeArg);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "packages/daemon/src/fixtures/profiles", tag);

const home = await realpath(await mkdtemp(path.join(tmpdir(), "cs-profile-")));
const code = path.join(home, "code");
const api = path.join(code, "api");
const web = path.join(code, "web");

/** A workspace is the user's code, not Cuesheet state, but a diff needs git. */
function gitRepo(dir) {
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  // `commit.gpgsign=false` because this runs with the capturing person's
  // global git config, and a signing prompt hangs the script with no output.
  git(
    "-c",
    "user.name=capture",
    "-c",
    "user.email=capture@invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
}

for (const dir of [api, web]) {
  await mkdir(dir, { recursive: true });
  gitRepo(dir);
}

// ── the old daemon ──────────────────────────────────────────────────────────

const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
    const { startDaemon } = await import(${JSON.stringify(pathToFileURL(path.join(worktree, "packages/daemon/dist/server.js")).href)});
    const { harnessRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(worktree, "packages/daemon/dist/runtime.js")).href)});
    const handle = await startDaemon({ port: 0, logger: false, ...harnessRuntime() });
    console.log("URL " + handle.url);
    `,
  ],
  {
    // A cwd with no config in it — the packaged app's situation, and the
    // reason nothing is ever bootstrapped from the working directory.
    cwd: code,
    // Git identity for the Commons store, which commits. Fixed rather than
    // inherited so the fixture never carries the capturing person's name.
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_AUTHOR_NAME: "capture",
      GIT_AUTHOR_EMAIL: "capture@invalid",
      GIT_COMMITTER_NAME: "capture",
      GIT_COMMITTER_EMAIL: "capture@invalid",
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);

// Whatever happens below, the old daemon does not outlive this script.
// Nor does its scratch home, which `fs.rm` cannot be awaited for from an
// `exit` handler, hence the synchronous one.
process.on("exit", () => {
  child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});
process.on("uncaughtException", (error) => {
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  process.exit(1);
});

const base = await new Promise((resolve, reject) => {
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const match = /URL (\S+)/.exec(buffer);
    if (match) resolve(match[1]);
  });
  child.on("exit", (code) => reject(new Error(`daemon exited ${code}`)));
});

async function call(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  // The diff route answers with the patch itself rather than JSON.
  const isJson = response.headers.get("content-type")?.includes("json");
  const json = text === "" ? null : isJson ? JSON.parse(text) : text;
  return { status: response.status, json };
}

const step = (what) => console.error(`· ${what}`);

async function must(method, route, body) {
  const r = await call(method, route, body);
  if (r.status >= 400) {
    throw new Error(
      `${method} ${route} → ${r.status} ${JSON.stringify(r.json)}`,
    );
  }
  return r.json;
}

async function waitFor(what, fn, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── drive it ────────────────────────────────────────────────────────────────

/** `""` on alpha, `/projects/<id>` on anything that has projects. */
const hasProjects = (await call("GET", "/projects")).status === 200;
const hasCommons = (await call("GET", "/commons")).status === 200;

async function project(root) {
  if (!hasProjects) return "";
  const r = await must("POST", "/projects", { root });
  return `/projects/${(r.project ?? r).id}`;
}

/**
 * The open standby on a run, read from its events. The record's own `status`
 * stays `running` while it waits — only the event stream says `standby` — so
 * asking the record would wait forever.
 */
async function standbyOf(scope, runId) {
  const stored = await must("GET", `${scope}/runs/${runId}`);
  const statuses = stored.events.filter((e) => e.t === "status");
  if (statuses.at(-1)?.status !== "standby") return null;
  return (
    stored.events.filter((e) => e.t === "standby").at(-1)?.standbyId ?? null
  );
}

async function statusOf(scope, runId) {
  return (await must("GET", `${scope}/runs/${runId}`)).run.status;
}

const TERMINAL = ["done", "failed", "stopped", "held", "interrupted"];

/**
 * Queue a run and answer every standby it raises with `answer` until it ends.
 * A gated run can raise more than one — the author's, then the Gate's.
 */
async function answeredRun(scope, body, answer) {
  const { runId } = await must("POST", `${scope}/runs`, body);
  const answered = new Set();
  await waitFor(`run ${runId} to end`, async () => {
    if (TERMINAL.includes(await statusOf(scope, runId))) return true;
    const standbyId = await standbyOf(scope, runId);
    if (standbyId && !answered.has(standbyId)) {
      answered.add(standbyId);
      await must("POST", `/standbys/${standbyId}`, { answer });
    }
    return false;
  }).catch(async (error) => {
    console.error(
      JSON.stringify(await must("GET", `${scope}/runs/${runId}`), null, 1),
    );
    throw error;
  });
  return runId;
}

const apiScope = await project(api);
await must("POST", `${apiScope}/stations`, {
  id: "builder",
  harness: "mock",
  role: "engineer",
  workspace: api,
  paths: ["**"],
});

let reviewer = false;
if (hasProjects) {
  // A reviewer and a gated cuesheet, where the build has Gates. The tables
  // are appended by hand because that is how a person writes a `[gate.*]`
  // today — no route writes one — and *before* the reviewer is added, because
  // adding a Station is what reloads the config. It also means the old
  // build's own writer round-trips the hand-written tables, as it would for a
  // real user.
  const { config } = await readProjectConfig();
  await writeFile(
    config,
    (await readFile(config, "utf8")) +
      `\n[gate.review]\nrequire = "1-of-1"\n\n[cuesheet.ship]\ncues = [{ station = "builder", action = "build" }, { gate = "review" }]\n`,
  );
  await must("POST", `${apiScope}/stations`, {
    id: "critic",
    harness: "mock",
    role: "reviewer",
    workspace: api,
  });
  reviewer = true;
}

async function readProjectConfig() {
  const cuesheetDir = path.join(home, ".cuesheet");
  for (const candidate of [
    path.join(api, "cuesheet.toml"),
    ...(await readdir(path.join(cuesheetDir, "projects")).catch(() => [])).map(
      (id) => path.join(cuesheetDir, "projects", id, "cuesheet.toml"),
    ),
    path.join(cuesheetDir, "cuesheet.toml"),
  ]) {
    if (await stat(candidate).catch(() => null)) return { config: candidate };
  }
  throw new Error("no config was written");
}

step(`driving ${base} (projects: ${hasProjects}, commons: ${hasCommons})`);
await answeredRun(apiScope, { prompt: "Add a rate limiter" }, "go");
await answeredRun(apiScope, { prompt: "Rename the handler" }, "no");
if (reviewer) {
  await answeredRun(
    apiScope,
    { prompt: "Ship the limiter", cuesheet: "ship" },
    "go",
  );
}

if (hasProjects) {
  const webScope = await project(web);
  await must("POST", `${webScope}/stations`, {
    id: "front",
    harness: "mock",
    role: "engineer",
    workspace: web,
    paths: ["src/**"],
  });
  await answeredRun(webScope, { prompt: "Fix the header" }, "go");
}

if (hasCommons) {
  const facts = await call("POST", "/commons", {
    id: "tabs-not-spaces",
    title: "Tabs, not spaces",
    body: "The API repository indents with tabs.",
    tags: ["style"],
  });
  if (facts.status >= 400)
    throw new Error(`POST /commons → ${JSON.stringify(facts.json)}`);
  const runs = await must("GET", `${apiScope}/runs`);
  const run = (runs.runs ?? runs)[0].id;
  const capture = (title) =>
    must("POST", `${apiScope}/commons/captures`, {
      title,
      body: `${title}, learned during a run.`,
      station: "builder",
      run,
      tags: ["captured"],
    });
  await capture("Rate limits live in middleware");
  await capture("Integration tests need Redis");
  const { pending } = await must("GET", "/commons/inbox");
  const first = pending.find(
    (p) => p.title === "Rate limits live in middleware",
  );
  await must("POST", `/commons/inbox/${first.id}/approve`, {});
}

// The crash half: one run parked on a standby nobody answers, one behind it.
const { runId: parked } = await must("POST", `${apiScope}/runs`, {
  prompt: "Parked on a question",
});
await waitFor("parked standby", () => standbyOf(apiScope, parked));
const { runId: behind } = await must("POST", `${apiScope}/runs`, {
  prompt: "Queued behind it",
});
const behindStatus = await statusOf(apiScope, behind);
if (behindStatus !== "queued")
  throw new Error(`expected queued, got ${behindStatus}`);

// ── what the old build said ────────────────────────────────────────────────

async function snapshot(scope, root) {
  const stations = await must("GET", `${scope}/stations`);
  const listed = await must("GET", `${scope}/runs`);
  const runs = [];
  for (const run of listed.runs ?? listed) {
    const stored = await must("GET", `${scope}/runs/${run.id}`);
    const diff = await call("GET", `${scope}/runs/${run.id}/diff`);
    runs.push({
      id: run.id,
      status: stored.run.status,
      stationIds: stored.run.stationIds,
      events: stored.events.length,
      diff:
        diff.status === 200
          ? typeof diff.json === "string"
            ? diff.json
            : (diff.json?.diff ?? null)
          : null,
      run: stored.run,
    });
  }
  return {
    root,
    stations: (stations.stations ?? stations).map((s) => s.station ?? s),
    runs,
  };
}

const manifest = {
  tag,
  capturedWith: process.version,
  daemonVersion: (await must("GET", "/health")).version,
  home: "{{HOME}}",
  workspaces: ["code/api", ...(hasProjects ? ["code/web"] : [])],
  projects: [],
  commons: null,
};

if (hasProjects) {
  const { projects } = await must("GET", "/projects");
  for (const p of projects) {
    manifest.projects.push({
      id: p.id,
      name: p.name,
      ...(await snapshot(`/projects/${p.id}`, p.root)),
    });
  }
} else {
  manifest.projects.push({
    id: null,
    name: null,
    ...(await snapshot("", null)),
  });
}

if (hasCommons) {
  manifest.commons = {
    facts: (await must("GET", "/commons")).facts,
    pending: (await must("GET", "/commons/inbox")).pending,
  };
}

child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));

// ── scrub and write ─────────────────────────────────────────────────────────

const state = path.join(home, ".cuesheet");
// Liveness, not state: the pid of a process that no longer exists, which on a
// CI runner could belong to anything. The current build already treats a
// stale lock as absent; carrying one would test the runner's pid table.
await rm(path.join(state, "daemon.json"), { force: true });
await rm(path.join(state, "logs"), { recursive: true, force: true });

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(state, path.join(out, "cuesheet"), { recursive: true });

const homes = [home, home.replace(/^\/private\//, "/")];
async function scrub(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    let full = path.join(dir, entry.name);
    // Every `.git*` entry is stored as `dot-git*`. `.git` for the obvious
    // reason, and `.gitattributes` because a nested one is *read by this
    // repository*: the Commons store's own `* text=auto` would override the
    // root rule that marks its objects binary.
    if (entry.name.startsWith(".git")) {
      if (entry.name === ".git") {
        // `git init` copies its sample hooks in from git's own templates.
        // They are not anything Cuesheet wrote, and they vary by git version.
        await rm(path.join(full, "hooks"), { recursive: true, force: true });
      }
      const renamed = path.join(dir, `dot-${entry.name.slice(1)}`);
      await rename(full, renamed);
      if (entry.isDirectory()) continue;
      full = renamed;
    }
    if (entry.isDirectory()) {
      await scrub(full);
      continue;
    }
    const bytes = await readFile(full);
    if (bytes.includes(0)) continue;
    let text = bytes.toString("utf8");
    for (const h of homes) text = text.split(h).join("{{HOME}}");
    await writeFile(full, text);
  }
}
await scrub(path.join(out, "cuesheet"));

let body = JSON.stringify(manifest, null, 2);
for (const h of homes) body = body.split(h).join("{{HOME}}");
await writeFile(path.join(out, "manifest.json"), `${body}\n`);

await rm(home, { recursive: true, force: true });
console.log(`captured ${tag} → ${path.relative(repo, out)}`);
process.exit(0);
