# Cuesheet — Foundation Build Plan

Small, ordered steps to get a **working** Cuesheet on **macOS and Windows**. Everything here is scaffolding you can tear up later; the goal is a running app you can tweak, not a finished product.

Scope of this plan = README milestones **M0 (Spine)** and **M1 (Desk)**, plus just enough of the harness abstraction that M2–M9 don't require a rewrite. Linux, phone pairing, Commons, Gates, Caller, and On-Call are explicitly out of scope here — see [Deferred](#deferred-on-purpose).

**This plan ends at alpha, not at 1.0.** Phases 0–4 are pre-alpha, Phases 5–6 are alpha, and the beta and 1.0 bars are stated in [Release stages](#release-stages) so the gap is visible rather than assumed.

**Done when:** on both a Mac and a Windows box, you double-click the app, it detects your installed harnesses, you add a Station, type a prompt, and watch a real Claude Code run stream into a tile and land as a durable run record with a diff.

---

## Decisions made up front

These are the four choices that shape everything else. Stated here so steps below don't re-argue them.

| Decision | Choice | Why |
|---|---|---|
| **Language / repo** | TypeScript, **npm workspaces**, ESM, Node ≥ 22 | The README already commits to a TS harness SDK. npm 11 ships with Node so there is nothing extra to install, and pnpm's isolated `node_modules` needs `node-linker=hoisted` to work with `electron-builder` — friction with no payoff here. |
| **Desktop shell** | **Electron** (`electron-builder`) | It bundles a Node runtime, so the daemon runs *inside* the app with zero extra install. Tauri is leaner but needs Rust on both machines and makes shipping a Node daemon the hard part. Revisit after it works. |
| **Run store** | **Files on disk** (JSON + JSONL), behind a `RunStore` interface | SQLite means a native module, and native modules are the #1 way a cross-platform Electron build dies on Windows. Files get you to "working" fast; swap in `better-sqlite3` or `node:sqlite` behind the interface once packaging is proven. |
| **Module format** | ESM everywhere **except** `packages/desktop`, which is CJS and gets bundled by esbuild in Phase 5 | Electron's ESM main process has real `__dirname`/preload caveats. A CJS main also cannot `require()` an ESM daemon, so Step 21 bundles main + daemon into one CJS file — which also solves asar module resolution. |
| **Process spawning** | `cross-spawn`, never `shell: true` | `claude`/`codex` on Windows are `.cmd` shims. Node's bare `spawn` won't execute them; `shell: true` fixes it but re-opens quoting/injection problems with user prompts. `cross-spawn` handles PATHEXT and `.cmd` correctly. |

---

## Target layout

```
cuesheet/
├─ package.json                 npm workspace root ("workspaces": ["packages/*"])
├─ tsconfig.base.json
├─ eslint.config.js  .prettierrc.json  vitest.config.ts
├─ packages/
│  ├─ core/                     types, config schema, leash checks, ids, paths
│  ├─ harness/                  Harness interface, registry, built-in harnesses
│  ├─ daemon/                   cuesheetd — HTTP + WebSocket, queue, run store
│  ├─ ui/                       React + Vite — the Desk (served by daemon AND loaded by Electron)
│  ├─ cli/                      `cuesheet` command
│  └─ desktop/                  Electron main + preload + packaging
└─ .github/workflows/ci.yml     macos-latest + windows-latest matrix
```

One UI build, three consumers (browser, Electron, later the phone). That is the whole reason the daemon is the product.

---

## Status

| Phase | Steps | Stage | State |
|---|---|---|---|
| **0 · Repo and toolchain** | 1–4 | 🟠 pre-alpha | ✅ Done (macOS **and** Windows) |
| 1 · Contracts | 5–7 | 🟠 pre-alpha | ✅ Done (macOS **and** Windows) |
| 2 · Daemon spine | 8–12 | 🟠 pre-alpha | ✅ Done (macOS **and** Windows) |
| 3 · Harnesses | 13–16 | 🟠 pre-alpha | ✅ Done (macOS **and** Windows) |
| 4 · Desk | 17–20 | 🟠 pre-alpha → **Milestone A** | ✅ Done (macOS **and** Windows) |
| **5 · Electron shell** | 21–24 | 🟡 alpha | ✅ 21–24 done on both |
| **6 · Packaging and CI** | 25–27 | 🟡 alpha → **Milestone B `v0.1.0-alpha`** | ✅ **Reached.** CI green on both runners; `v0.1.0-alpha` published with five installers |
| **7 · Gates, for real** | 28–30 | 🔵 beta | ✅ **Done.** `codex` harness written against captured streams; two-vendor gate run end to end |
| **8 · Projects** | 31–34 | 🔵 beta | ✅ **Done.** One daemon serves many projects, isolated; an alpha profile upgrades into it losing nothing; and switching between them disturbs no run |
| 9 · Local models (`ollama`) | 35–36 | 🔵 beta | ✅ **Done.** The harness ships, `worker`-only and refusing other seats before it asks the model; a real local run landed at `usd: 0` having touched zero files |
| 10 · Limits | 37–39 | 🔵 beta | ✅ **Done.** Usage on the wire, the strip, a run refused before it starts, a cache-aware ledger, and `when_capped` routing that refuses to swap a seat |
| 11 · The Desk, rebuilt | 40–45 | 🔵 beta | ✅ **Done.** Launch surface, switcher, a project view that says what each seat may do, a run surface that leads with the blocking finding rather than logging it, one design system under all of it, and a path from a fresh machine to a first run that says what is missing and how to get it. Two clauses stay open and say why: nothing has been driven by a keyboard, and no stranger has walked the first run |
| 12 · The Commons | 46–50 | 🔵 beta | ◐ **Steps 46–47 done** — facts are committed files and project/user projections keep both harnesses on one byte-stable body without clobbering handwritten context |
| 13 · A product other people can use | 51–56 | 🔵 beta → **`v0.5.0-beta`** | ⬜ |
| 14 · The context economy | 57–62 | ⚪ post-1.0 | ◐ **Step 57 done**, pulled forward into Step 39 where the ledger needed it |
| — beyond this plan — | M3 · Pocket | 🟢 1.0 | ⬜ |
| — beyond this plan — | hardening | 🟢 1.0 | ⬜ |

**Numbering rule, because this table has now been renumbered once and will be again:** a phase or step that is **done is frozen** — Phases 0–7 and Steps 1–30 keep their numbers forever, because other documents, commits and this file's own retrospectives point at them. Everything **unbuilt renumbers freely**, so that a phase number always equals its position in the running order. The alternative — appending new phases and leaving the order to a footnote — buys a smaller diff once and costs every future reader a sentence like "do 7, then 10, then 11, then 8."

---

## Release stages

Phases 0–6 land you at **alpha**, and for a long time that was the whole document — it said so, in a sentence that has now been overtaken. Alpha shipped, and the honest ceiling moved: the features that make Cuesheet worth choosing over a terminal are gates, the Commons, the limits strip, and the phone, and the first of those is now done. So the plan continues past Phase 6 rather than handing off to a roadmap row.

The sequencing is the plan's, not the README's. That table numbers features (M2, M3, M4…) for a reader deciding whether to care; it is a catalogue, not a work order, and the work has already jumped past M2–M4 to M5 once. What governs here is which unbuilt thing most changes what the product *is*.

**Phases 8–13 changed that order, and the reason is worth stating rather than absorbing.** The previous revision put the Commons next, on the argument that it is the only part that makes leaving expensive. That argument is still true and it is still the strongest single reason to build this. What overtook it is a dependency: the Commons' own first open question was *whether projection is per-workspace or global*, and Cuesheet has no concept of a project at all — one `cwd`, one config, one run store, and a packaged app that resolves its config path from wherever the OS launched it. You cannot answer a scoping question in a product with no scopes. **Projects therefore come first, and three other things follow from them:** the Desk needs a level above the run before it is worth redrawing, the limits strip is something an operator reads *per project*, and `ollama` is worth having before the strip so that its hardest row — a station that cannot run out — is real rather than imagined. The Commons is then built into a product that can say where a fact belongs.

| Stage | Version | What it means | Who can use it |
|---|---|---|---|
| 🟠 **Pre-alpha** | `0.0.x` | No installer. Runs from a checkout. Shapes and contracts are still moving; expect to delete state between runs. | You, and nobody else. |
| 🟡 **Alpha** | `0.1.x` | Installable, unsigned. One harness, one station at a time, no gates. Config may break without migration. Run records may be discarded on upgrade. | People who will read a changelog and tolerate a wipe. |
| 🔵 **Beta** | `0.5.x` | Feature-complete against the README's core thesis. Signed. Config format frozen with migrations. No data loss, ever. | Strangers, daily, on real work. |
| 🟢 **1.0** | `1.0.0` | The README is true as written, minus the sections it marks optional. Security posture documented and reviewed. | Anyone. |

### Exit criteria

**Pre-alpha → alpha** (end of Phase 6)
- [x] Milestone A and B both true on macOS **and** Windows
- [x] A stranger with Claude Code installed can open the app and complete a run without editing TOML
- [x] Crash mid-run leaves a readable run record, never a corrupt one — verified on Windows by `taskkill /F` mid-run
- [x] CI green on both OSes — `macos-latest` in 38s and `windows-latest` in 1m, on `main`, after the ordering fix and the timing-flake pass
- [x] Installers uploaded on tag — `release.yml` proved by `workflow_dispatch` first, then by the tag: five installers built on runners, attached to a draft, and **`v0.1.0-alpha` published**
- [x] Install caveats (quarantine, SmartScreen) documented, not hidden — in the README and repeated in every release's own notes

**Alpha → beta** — none of this is in this plan; each maps to a README milestone
- [x] **M5 · Gates** — reviewer role, verdict parsing, gate evaluation, Holds. *The second opinion is the thesis; without it this is a nicer terminal.*
  - [x] **`codex` harness.** Written, once the blocker turned out to be an environment fact rather than a design one — the CLI was simply not installed. `brew install --cask codex`, an existing ChatGPT credential already in `~/.codex`, three captured streams, and the mapper was written against what arrived instead of what was remembered. See Phase 7.

#### What Gates actually do now

The machinery, end to end: `[gate.*]` is a live config table; a `{ gate = "…" }` cue executes between Stations; a Station with `role = "reviewer"` is handed the diff and the review format rather than the original brief; its reply becomes a `Verdict`; and `evaluateGate` decides. A failed gate raises a **standby** — which already notifies, already shows go/no in the Desk, and already reaches the phone in M3 — and a run the operator does not override lands `held`, with the reasons on the record and the findings attached.

Verified first against `mock` writing and `claude-code` (Anthropic) reviewing — which proved the wiring but not the thesis, since one of the two vendors was a stub. **Phase 7 proved the thesis:** `claude-code` wrote a rate limiter, `codex` (OpenAI) reviewed the real diff and found unbounded memory growth the author had not, and the gate held the run at $0.56. Two real vendors, neither aware of the other.

**Three decisions worth carrying forward:**

- **`distinct_vendors` counts who *acted*, not who filed a verdict.** Author plus reviewers. It is the only reading under which the README's own example (`require = "1-of-1"` with `distinct_vendors = 2`) is satisfiable, and it is the point of the feature: the second vendor is the one whose blind spots are different.
- **An unreadable review abstains, and an abstention cannot satisfy `require`.** A reviewer that crashed, rambled, or said "LGTM" has approved nothing. This is the single test that decides whether Gates are a safety feature or a decoration.
- **`held` is terminal.** The standby happens *before* the run ends, so by the time a record reads `held` a human has already answered. Releasing a Hold is a new run, not a resumption — resuming would mean persisting executor state across process restarts, which is a much larger feature than it looks.

**Known limitation, still open:** a Gate reviews the *workspace diff*, so two Stations sharing a workspace are reviewed together. Per-Station attribution needs the Commons or per-cue diffs — carried into Phase 12's open questions rather than left here to be rediscovered.
- [x] **Projects** — the app opens on one, switches between them, and remembers which you were in. Not a README milestone, which is itself the finding: it was assumed rather than specified. **Phase 8, done.** One daemon serves many; an alpha profile upgrades into it losing nothing; a switch disturbs no run. The launch surface, the missing-folder state and the keyboard route to the switcher were explicitly *not* ticked by that phase and were built in Steps 40–41; Phase 11 still says "the Desk rebuilt" because the project view, the run surface and the design system are Steps 42–44
- [ ] **M4 · Commons** — git-backed store, `CLAUDE.md`/`AGENTS.md` projection, approval inbox. *The durable layer the README argues for.* **Now Phase 12** — moved behind Projects because its own scoping question is unanswerable until a project is a thing, which is a dependency rather than a demotion
- [ ] **M2 · Limits** — usage windows, pre-run warnings, ledger. *Users hit caps in week one; this is not a polish item.* **Now Phase 10.**
- [x] `ollama` harness, so the local/worker story is real. **Phase 9, done.** This line used to say it was blocked by nothing but a missing install, which was wrong twice over: Ollama is a completion endpoint rather than an agent loop, so the `worker`-only reading the README already specifies is what made it small — *and then* the install turned out to be the remaining blocker after all, once a machine had one. Both halves of that were worth finding out in the order they were found
- [ ] **The Desk rebuilt** around all of the above — **now Phase 11.** The current one was built to prove a daemon could stream a run into a browser, and has no level above the run
- [ ] Run store moved to SQLite behind `RunStore` (files won't hold up at thousands of runs) — **now Step 52**
- [ ] Config migrations, and an upgrade that never discards run history — **now Steps 33 and 53**
- [ ] Code signing + notarization on macOS; signed installer on Windows — **now Step 54**, together with auto-update, which depends on it
- [ ] Crash and error reporting you can actually act on — local only, no telemetry — **now Step 56**
- [ ] A `cuesheet` CLI that does what the README already prints — **now Step 51**
- [ ] The files the README links to and the repository does not contain — **now Step 55**

**Beta → 1.0**
- [ ] **M3 · Pocket** — QR pairing, tailnet serving, mobile standby. *The README leads with it; 1.0 can't ship without it.*
- [ ] Security review of the daemon's network surface, pairing tokens, and redaction pack. The README already promises "not audited" — 1.0 is where that stops being acceptable
- [ ] Leash enforcement fuzzed, not just unit-tested
- [ ] `docs/harnesses.md` published and a third-party harness proven to work against it
- [ ] Linux builds (the README calls it first-class)
- [ ] Documented backup/restore of `~/.cuesheet`

**Explicitly post-1.0** — README milestones M6 (Caller), M7 (On-Call), M8 (Fleet), M9 (Ecosystem). On-Call is a headline section and it will feel odd to defer, but it is opt-in, armed deliberately, and depends on Gates being battle-tested first. Shipping it before gates have real mileage is how you get a 3am patch nobody trusts.

---

# Phase 0 · Repo and toolchain ✅

> 🟠 **Pre-alpha.** Nothing runs yet.

### Step 1 — Workspace skeleton ✅
Create the npm workspace, `tsconfig.base.json` (`"module": "nodenext"`, `"strict": true`, `"target": "es2023"`), and `packages/*` each with their own `package.json` and `tsconfig.json`. Add `.gitignore` (`node_modules`, `dist`, `release`, `.cuesheet-dev`).

Set `"type": "module"` everywhere **except** `packages/desktop`, which omits the field so `nodenext` resolves it as CJS.

Give every package a stub `src/index.ts` (`export {};`) immediately — `tsc` errors with *"No inputs were found in config file"* on a package with no sources, so without stubs your first acceptance check fails for a reason unrelated to your setup.

Each package needs two tsconfigs: `tsconfig.json` includes tests (so `typecheck` covers them) and `tsconfig.build.json` excludes `src/**/*.test.ts` (so tests don't land in `dist`).

**Done when:** `npm install` succeeds and `npm run typecheck` passes across all six packages.

### Step 2 — Lint, format, test harness ✅
Add `typescript`, `vitest`, `prettier`, and `eslint` (flat config) at the root. Root scripts: `build`, `clean`, `typecheck`, `test`, `lint`, `format`. One `vitest.config.ts` at the root collecting `packages/*/src/**/*.test.ts` — simpler than a config per package.

Two things worth doing now rather than later:
- `clean` scripts must be `node -e "import('node:fs').then(m=>m.rmSync('dist',{recursive:true,force:true}))"`, not `rm -rf`. `rm` does not exist on Windows.
- Add `*.md` to `.prettierignore`. The README is full of hand-aligned ASCII diagrams and tables that Prettier reflows into mush.

**Done when:** `npm test`, `npm run lint`, and `npm run format:check` are all green on both OSes.

### Step 3 — `.gitattributes` and line endings ✅
Set `* text=auto eol=lf`, then force `*.cmd`, `*.bat`, and `*.ps1` to `eol=crlf` and `*.sh` to `eol=lf`. CRLF in a shell script makes `\r` part of the command; LF in a `.cmd` or `.ps1` misbehaves under the Windows script hosts. Mark binaries (`*.png`, `*.ico`, `*.icns`) explicitly so normalization never touches them. Add a matching `.editorconfig`.

**Done when:** `git clone` on Windows produces a tree that still typechecks.

### Step 4 — Cross-platform path helper (`core`) ✅
`packages/core/src/paths.ts`. Two traps make the obvious implementation untestable, so build it this way from the start:

- **Take an injectable `HostEnv = { platform, homedir }`**, defaulted to the real host. If `configDir` is a top-level `const`, mocking `process.platform` in a test does nothing — the value was computed at import.
- **Select `path.win32` / `path.posix` explicitly off that platform value.** Mocking `process.platform` does not rebind the ambient `path` module, so an implementation using bare `path` still emits POSIX output from a Mac and the Windows test passes for the wrong reason.

Exports:
- `configDir()` → `~/.cuesheet` (works as `%USERPROFILE%\.cuesheet` on Windows).
- `configFile()`, `runsDir()`, `logsDir()`, `commonsDir()`.
- `expandHome(p)` — the README's config uses `~/code/api` and Windows won't expand it for you.
- `toPosix(p)` — normalize separators before any glob match. Gate this on platform: a backslash is a legal character in a POSIX filename, so rewriting it there corrupts real paths.
- `resolveUserPath(p, cwd)`, `isWindows()`, `pathFor()`, plus `DEFAULT_PORT` and `daemonLockFile()` for Step 8.

**Done when:** tests running on macOS assert `C:\\Users\\noah\\.cuesheet` for a `win32` env, and vice versa.

---

# Phase 1 · Contracts before code ✅

> 🟠 **Pre-alpha.** Types only — no process, no UI.

The point of these three steps is that everything downstream depends on types, not on the daemon.

### Step 5 — Domain types (`core`) ✅
`Station`, `HarnessId`, `Role`, `Cue`, `Cuesheet`, `Run`, `RunEvent`, `Standby`, `Verdict`. Match the README's vocabulary exactly — the words are the spec.

Core owns the harness *identifier*, not the `Harness` interface — that lands in `packages/harness` at Step 13. Conflating them makes core depend on spawning and I/O, and sets up a core↔harness cycle.

`Cuesheet.cues` is `Array<Cue | GateRef>`: the README's `[cuesheet.ship]` mixes `{ station, action }` and `{ gate = "default" }` in one array, and "a gate is a cue kind" only stays additive if that shape exists now.

Define `RunEvent` as a discriminated union now, because it's the wire format for everything:

```ts
type RunEvent =
  | { t: "status";   at: string; runId: string; status: RunStatus }
  | { t: "text";     at: string; runId: string; stationId: string; chunk: string }
  | { t: "tool";     at: string; runId: string; stationId: string; name: string; input: unknown }
  | { t: "file";     at: string; runId: string; stationId: string; path: string; op: "read"|"write" }
  | { t: "standby";  at: string; runId: string; standbyId: string; ask: string }
  | { t: "denial";   at: string; runId: string; reason: string; path?: string }
  | { t: "cost";     at: string; runId: string; stationId: string; tokensIn: number; tokensOut: number; usd?: number }
  | { t: "done";     at: string; runId: string; result: RunResultSummary }
  | { t: "error";    at: string; runId: string; message: string };
```

**Done when:** the union compiles and every variant carries `runId` + `at` (ISO 8601, UTC).

### Step 6 — Config schema and TOML loader (`core`) ✅
Parse `cuesheet.toml` with `smol-toml` (pure JS — no native dep), validate with `zod`. Support the README's shape but only implement `[desk]`, `[[station]]`, and `[cuesheet.*]` for now; parse-and-ignore the rest with a warning rather than erroring, so the README's full example loads on day one.

Resolution order: `./cuesheet.toml` → `~/.cuesheet/cuesheet.toml` → built-in defaults.

Two things the obvious implementation gets wrong:

- **Zod strips unknown keys silently — it does not error.** Collect warnings by diffing the TOML's top-level table names against the implemented set, separately from validation. A schema-only implementation reports nothing and the done-when fails while the tests pass.
- **Return `{ config, warnings, sourcePath, deferred }`**, not a bare config. Step 12's `/stations` surfaces the warnings, Step 20 writes back to the file it loaded from, and `deferred` keeps the unimplemented tables verbatim so a UI-driven rewrite doesn't eat the user's Gates.

Config-shaped types (`Station`, `Cue`, `Cuesheet`) are inferred from their zod schemas rather than hand-written in Step 5. `exactOptionalPropertyTypes` is on, and zod's `{ model?: string | undefined }` is not assignable to a hand-written `{ model?: string }` — two shapes that must agree is a wall of errors at the seam.

**Done when:** the exact TOML block from the README's Configuration section parses to a typed object with warnings for the unimplemented tables.

### Step 7 — Leash enforcement (`core`) ✅
Pure function, no I/O, heavily tested:

```ts
checkPath(station, absPath): { allowed: boolean; reason?: string }
```

Rules: resolve to absolute → assert it's inside `workspace` (via `path.relative` not string prefix, so `../` escapes are caught) → deny globs win over allow globs → default deny outside `paths`.

Keep `checkPath` pure and put the `fs.realpath` call in a thin async `resolveAndCheck` beside it — otherwise "pure function, no I/O" and "call `fs.realpath` first" contradict each other and you lose the exhaustive testability that is the whole point.

Three things that decide whether this actually holds:

- **Containment is `rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)`.** The `isAbsolute` arm is what catches a different drive: `path.win32.relative("C:\\a", "D:\\b")` returns `D:\b`, with no leading `..` at all.
- **picomatch needs `dot: true`.** By default `*` will not cross a leading dot, so the README's own `**/*.env` misses a bare `.env` — the exact file it exists to protect. Test `src/.env`, not `src/config.env`; the difference is a passing test and a real leak.
- **Match globs against the workspace-relative posix path**, not the absolute one, or `src/**` never matches anything.
- **`nocase` on Windows only.** `path.win32.relative` folds case for its own comparison but returns the target's original spelling, so `SECRET.ENV` reaches the matcher verbatim and a `**/*.env` deny misses it — on a filesystem where it is the same file. Do *not* fold on POSIX, where `.env` and `.ENV` genuinely differ.
- **No ancestor walk-up.** Testing each parent directory against the rule looks like a convenience and is a bypass: it turns an allow of `src/*` into `src/**`, because `src/deep/nested/secret.ts` has an ancestor `src/deep` that `src/*` matches. Handle bare-directory rules by expanding a glob-free rule to match both `rule` and `rule/**`.

Use `picomatch` against posix-normalized paths. Windows specifics that will bite: drive-letter casing, `\` vs `/`, 8.3 short names, and symlinks/junctions — call `fs.realpath` before checking.

**Done when:** tests cover `..` escape, `C:\` vs `c:\`, a different drive, symlink-out-of-workspace, and `**/*.env` deny beating `src/**` allow.

---

> **Working on `core` or `harness`? Build before you test.** vitest resolves
> `@cuesheet/core` and `@cuesheet/harness` through each package's `exports`
> field, which points at `dist` — so a daemon or UI test runs against the last
> *built* version, not the source you just edited. The symptom is a test that
> fails for reasons the source says are impossible. `npm run build -w @cuesheet/core`
> (and `-w @cuesheet/harness`) first, or `npm run build` for all six in order.

---

# Phase 2 · The daemon spine ✅

> 🟠 **Pre-alpha.** A daemon you can `curl`. Not a product.

### Step 8 — `cuesheetd` boots and serves health ✅
Fastify + `@fastify/websocket`. Binds `127.0.0.1:7373`. On `EADDRINUSE`, exit with a clear message (don't silently pick another port — the CLI and app need to find it).

Write a **lockfile** at `~/.cuesheet/daemon.json` with `{ pid, port, version, startedAt }` so the CLI and Electron can discover a running daemon. Delete it on clean exit; on boot, if it exists, probe `/health` before assuming it's stale.

**Done when:** `curl 127.0.0.1:7373/health` returns `{ ok: true, version }` on both OSes.

### Step 9 — Event bus + WebSocket fan-out ✅
An in-process `EventEmitter` wrapped in a typed `bus.emit(RunEvent)` / `bus.subscribe(fn)`. `GET /ws` upgrades and streams every `RunEvent` as JSON lines.

Add a replay buffer: on connect, send the last N events for any active run so a client that connects mid-run isn't staring at nothing.

**Done when:** `wscat` connected to `/ws` prints a synthetic event you emit from a test route.

### Step 10 — Run store (files) ✅
```
~/.cuesheet/runs/<runId>/
  run.json       prompt, stations, status, timestamps, cost totals
  events.jsonl   append-only RunEvent log
  diff.patch     unified diff, written at the end
```

Interface `RunStore { create, append, get, list, finish }`. Append via a single serialized write queue — **do not** open concurrent append streams, Windows file locking is stricter than macOS and will throw `EBUSY`.

Run IDs: monotonic + sortable. Use a timestamp-prefixed id, not a bare counter.

**Done when:** a run written on one process is fully readable by a second process, and `events.jsonl` survives a hard kill mid-write (last line may be partial — the reader must tolerate that).

### Step 11 — The queue ✅
Single-concurrency FIFO to start. `enqueue(cuesheet, prompt)` → `runId`. One run at a time, cues executed in declared order. No parallelism yet — parallel stations are a later problem and will otherwise dominate your debugging time now.

**Done when:** two rapid `enqueue` calls run sequentially and both produce complete run records.

### Step 12 — HTTP API surface ✅
```
GET  /health
GET  /stations           from config + live probe results
GET  /runs               list, newest first
GET  /runs/:id           run.json + events
POST /runs               { prompt, cuesheet? } → { runId }
POST /runs/:id/stop
POST /standbys/:id       { answer: "go" | "no" }
GET  /ws
```
Keep it boringly REST. This is the same API the phone will use in M3, so no Electron-only shortcuts.

**Done when:** every route has a smoke test hitting a real listening server.

---

# Phase 3 · Harnesses ✅

> 🟠 **Pre-alpha.** Real models run, driven by HTTP. Still no app.

### Step 13 — The `Harness` interface (`harness`) ✅
Implement exactly the shape in the README's "Writing a harness" section: `id`, `vendor`, `roles`, `probe()`, `usage()`, `contextFiles`, `writeConnectors()`, `run(ctx)`.

For now `usage()` and `writeConnectors()` may return empty — but they must exist so M2 and the connector registry are additive.

`RunContext` gives the harness: `brief`, `workspace`, `emit(ev)`, `meter`, and a **leashed fs facade**. The harness never touches `node:fs` directly.

**Done when:** the interface compiles and a `mock` harness implementing it passes a contract test.

### Step 14 — The `mock` harness ✅
A fake harness that emits scripted events, writes one file, and returns a diff. **Build this before the real one.** It's how you develop the UI, the queue, and the run store without burning tokens or waiting on a real model.

**Done when:** `POST /runs` with the mock cuesheet produces a full run record in under a second.

### Step 15 — Cross-platform process spawning ✅
`packages/harness/src/spawn.ts`:
- `cross-spawn` for execution.
- `which`-style resolution honoring `PATHEXT` on Windows, returning the resolved absolute path so probes can report a version.
- Kill semantics: on Windows, `child.kill()` does **not** kill grandchildren. Use `taskkill /pid <pid> /T /F`; on macOS, spawn detached and kill the process group (`process.kill(-pid)`).
- Line-buffered stdout parser tolerant of partial JSON lines and of `\r\n`.

**Done when:** a spawned `node -e "setInterval(()=>{},1e3)"` grandchild is provably dead after `stop` on both OSes.

### Step 16 — The `claude-code` harness ✅
Shell out to the Claude Code CLI in headless mode with streaming JSON output. Confirm the exact flags against `claude --help` on your machine before wiring them — the surface moves. Map its stream events onto your `RunEvent` union; anything unrecognized becomes a `text` event rather than an error.

- `probe()` — resolve the binary, run `--version`, and detect logged-in state.
- `run()` — spawn in the workspace, stream, then compute the diff with `git diff` (git is already a stated requirement).

Keep the mapping layer thin and isolated. The README calls harness churn "the permanent tax"; the tax is only cheap if it's confined to one file.

**Done when:** a real prompt against a scratch git repo produces streamed text, a `diff.patch`, and a `done` event — on both OSes.

> **Verified on macOS.** A real `claude-code` run over HTTP streamed text, wrote the file, produced `diff.patch`, and landed a `done` record with real cost; stopping a live run took the subprocess tree to zero and left the run terminal with partial events.
>
> **And now on Windows, against the real CLI.** `probe()` resolved `C:\Users\…\.local\bin\claude.EXE` — note the uppercase extension, which is `PATHEXT` resolution working — and reported `2.1.221 ✓ logged in`. A real run streamed `text → tool → file → cost → done`, wrote `greeting.txt`, produced a `diff.patch` that `GET /runs/:id/diff` served, and landed `done · $0.29`. Stopping a live run took the tree to zero: the spawned `claude.EXE` and its `conhost.exe` grandchild were both gone four seconds after `POST /stop`, the run landed `stopped`, and its nine partial events survived.
>
> **The `.cmd` shim path was not exercised, and that is worth knowing.** This machine's Claude Code is a native `claude.exe`, so `cross-spawn` resolved a real executable rather than a `.cmd` shim. The shim handling remains unit-tested only. An npm-installed `claude` would exercise it; this install does not.

### Decisions this phase settled

Four things were not obvious from the step text and are worth carrying forward:

- **The adapter lives in the daemon, not in `harness`.** `packages/daemon/src/harness-executor.ts` turns a `Harness` into a `RunExecutor`. Putting it beside the harnesses would mean `@cuesheet/harness` importing `@cuesheet/daemon` — the cycle Step 5 split these packages to avoid. `harnessRuntime()` is the one-liner both `main.ts` and Step 21's Electron main will spread.
- **`startDaemon` still defaults to inert.** The no-op executor and `unprobed` remain the defaults so the daemon's own tests stay fast, offline, and free; real behaviour is opt-in via `harnessRuntime()`. A default that spawns is a test suite whose results depend on what is installed on the machine.
- **The patch never goes on the wire.** `ExecutionContext.recordDiff` hands the queue a patch for `diff.patch`; the `done` event carries only the `DiffStat`. A diff can be megabytes and every client is subscribed.
- **The leash is advisory for CLI-backed harnesses.** `Workspace` binds harnesses that do their own I/O. `claude-code` hands the work to a subprocess with its own Edit/Write tools, which never consult our facade — so there, the leash scopes what it can and *observes* the rest, emitting a `denial` after the fact. This is weaker than the README's "cannot write there" and is flagged in `claude-code.ts` at the point where it matters. Closing it needs the CLI's own permission hooks.

Two things Phase 4 inherits rather than discovers: `runDiff` holds the whole patch in memory and `GET /runs/:id` returns it in full, so a workspace with a large untracked tree (an un-gitignored `node_modules`) yields a multi-megabyte `diff.patch` — fine for alpha, but Step 19's run view should fetch the diff lazily rather than with the run. And `git add -A -N` marks new files intent-to-add, so a run interrupted mid-flight leaves that marker in the user's index; `git reset` clears it and nothing is ever staged.

The live `claude-code` test is gated behind `CUESHEET_E2E=1`, since CI has no logged-in `claude` and a test that spends tokens by default is a test people delete. The mapper is tested against a captured real stream (`fixtures/claude-code-stream.jsonl`), which runs everywhere.

---

# Phase 4 · The Desk (web UI)

> 🟠 **Pre-alpha**, ending at **Milestone A**. Usable by you, from a checkout, in a browser. No installer, so nobody else can have it.

### Step 17 — Vite + React app
`packages/ui`. React 19, TypeScript, no UI framework yet — plain CSS modules or Tailwind, your call, but pick one and stop thinking about it. Dev server proxies `/api` and `/ws` to `:7373`.

**Done when:** `npm run dev -w packages/ui` shows a page reading `/health` from a running daemon.

### Step 18 — Client store from the WebSocket
One reducer consuming `RunEvent`s into `{ stations, runs, activeRun }`. Reconnect with backoff; on reconnect, refetch `/runs` and resync rather than trusting the buffer.

**Done when:** killing and restarting the daemon leaves the UI correct within a few seconds, no refresh.

### Step 19 — Station tiles and the run log
Build the two views the README draws: the tile grid (status dot, role, harness, current file, elapsed, cost) and the run log beneath it. Keyboard focus works; `⌘K`/`Ctrl+K` opens a command palette that at minimum can start a run.

**Done when:** the mock harness run animates through the tiles end to end.

### Step 20 — Add-a-Station panel
The five-choice panel: harness (from `/stations` probe results — installed ones first, greyed rows for the rest), model, role, workspace, leash. Writes back to `cuesheet.toml`.

Workspace picking needs a native dialog in Electron, and a typed path with server-side validation in the browser. Build the typed-path version first.

Seed every new Station's `deny` with `.git/**`. The leash's `dot: true` means an allow of `**` reaches `.git/hooks/`, and nothing else in the system protects it.

**Done when:** adding a Station in the UI results in a valid `[[station]]` block on disk and a new tile.

> ### 🏁 Milestone A — the app works in a browser
> *End of pre-alpha's useful phase. Not a release — there is nothing to download.*
>
> Daemon running, `claude-code` station added through the UI, real run streamed to a tile, run record on disk. Do not proceed until this is true on **both** macOS and Windows.

> **Verified on macOS only, in a real browser.** The Desk was driven headless against a live daemon, not just typechecked: the app mounts and reports the daemon connected, the configured Station renders as a tile, the deferred `[gate]` table surfaces as a warning banner, `⌘K` opens the palette, and the Add a Station panel renders all five choices with `claude-code v2.1.221 ✓ logged in` listed above the greyed-out `codex` and `ollama`. Adding a Station through the panel wrote a `[[station]]` block beside a hand-written `[gate]` table that survived byte-for-byte, and produced a second tile. A prompt typed into the palette then streamed `text` → `tool` → `file` → `cost` → `done` into the tile and the log, landed as `done · $0.13 · 11s · 1 files, +1 −0`, and its patch loaded on demand from `/runs/:id/diff` — one request, only when asked for.
>
> **The Windows half is now verified too, by eye.** The Desk was photographed running in the packaged app: `daemon connected`, the `opus` tile reading `engineer · claude-code · idle`, all three runs in the list, the interrupted run's reason rendered in red above its preserved events, `open diff` fetching on demand — and the palette hint reading **`Ctrl1K`**, not `⌘K`, which is the one Step 24 item that can only be checked by looking. Adding the Station through `POST /stations` wrote a `[[station]]` block whose Windows path was correctly escaped (`C:\\Users\\…`) and re-parsed on the next read.

### Decisions this phase settled

Five things that were not in the step text and are worth carrying into Phase 5:

- **The UI imports types from `@cuesheet/core`, values from `@cuesheet/core/types`.** `types.ts` imports nothing at all; the barrel reaches `config.ts` and `leash.ts`, which pull in `node:fs`, `smol-toml`, `zod`, and `picomatch`. `import type` is erased under `verbatimModuleSyntax` and costs nothing, but the Add a Station panel needs `ROLES` as a *value* — so core gained a `./types` export subpath. The built bundle contains no Node builtins; that is asserted, not assumed.
- **`apiOrigin()` exists before Electron does.** Step 21 loads the UI from `file://`, where a relative `fetch("/api/runs")` becomes `file:///api/runs` and fails with an error that names neither the daemon nor the port. Every fetch and the socket URL route through one module, and `base: "./"` is set in `vite.config.ts` for the same reason. Both are one line now and a scavenger hunt through finished components later.
- **The resync order is the correctness argument, and it is load-bearing.** Attach the socket, *buffer*, fetch `/runs`, `snapshot` (which replaces, never merges), then flush the buffer in arrival order. Fetching before attaching loses events in one window; attaching without buffering loses them in the other. `RunEvent`s carry no unique id, so de-duplication is not available — ordering is the only defense, which is why nothing sorts and nothing dedupes.
- **The config is appended to, never round-tripped.** `stringify(loaded.config)` over the whole file loses every comment and re-emits `deferred` from parsed JS values. `addStation` appends one `[[station]]` block to the existing *text*, re-parses the candidate with the loader's own `parseConfig` before anything replaces the target, then writes temp-and-rename. A user's Gates survive because they are never rewritten.
- **`GET /runs/:id` no longer carries the patch.** Phase 3 flagged that a workspace with a large untracked tree yields a multi-megabyte `diff.patch`, and that route is what the Desk calls to open a run row. The patch moved to `GET /runs/:id/diff` as `text/plain`; the run response carries `hasDiff` so the button knows whether to offer itself.

**Three bugs the browser found that the test suite could not.** Each was invisible to typecheck, lint, and 370 passing unit tests, because each only exists once the components mount against a live daemon:

- **The log pane opened empty.** `snapshot` selects the newest run when nothing survived a resync, but it cannot invent that run's events — they were never on this session's socket. The Desk opened on the newest run and showed "No events." until you clicked it. `resync` now fetches that run's detail before flushing the buffer.
- **Every run read `(no prompt)`.** The reducer invents a placeholder when events arrive for a run it has never seen, which is right — dropping them would animate tiles for a run that never appears in the list — but a placeholder has no prompt. Nothing ever fetched the real record. The hook now adopts an unknown run id on first sight, which also covers a run started from the CLI or, later, the phone.
- **Tiles labelled a cloud model `local`.** `cost` events carry tokens; the authoritative price arrives once, on `done`, for the run as a whole. A Station's own cost therefore legitimately has tokens and no `usd` — and `money()` rendered that as `local`, so a `claude-code` tile read as free for an entire run that cost real money. Tiles now show tokens and leave the price to the run row, where it is actually known. Attributing the run's total to a tile would have been worse: with several Stations it is invented.

**A bug this phase found and fixed.** The observing leash check in `claude-code.ts` compared a path the CLI had already resolved against the workspace *as configured*. On macOS `/tmp` and `/var` are symlinks into `/private`, so a Station at `/tmp/api` reported every one of its own legitimate writes as an escape — and a symlinked `~/code` does the same on any platform. `run()` now resolves the workspace once via `observedStation()`. It was cosmetic for `claude-code`, where the leash only observes; for any harness using the `Workspace` facade it would have blocked real writes.

**Known limitation, carried deliberately.** `POST /runs` takes `{ prompt, cuesheet? }` and a bare prompt runs the *first* configured Station. With several Stations configured the palette cannot choose between them. That is the single-station shape Milestone A is defined by; a `station` parameter is not the fix to reach for before Gates make multi-station runs real.

---

# Phase 5 · Electron shell

> 🟡 **Alpha begins here.** The moment it becomes a thing you can hand someone, the bar changes: no orphaned processes, no lost runs, no manual fixes.

### Step 21 — Main process ✅
`packages/desktop`. Main process:
- `app.requestSingleInstanceLock()` — second launch focuses the first window.
- Starts the daemon **in-process** (import and call `startDaemon()`) rather than spawning a sidecar binary. One less packaging problem, one less orphaned process.
- Loads the built UI from `file://` in production, `http://localhost:5173` in dev.
- `contextIsolation: true`, `nodeIntegration: false`, a minimal preload exposing only `{ platform, chooseDirectory, daemonPort }`.

**Done when:** `npm run dev -w packages/desktop` opens a window running the Desk against the embedded daemon.

> **Verified on macOS, by driving the app rather than typechecking it.** The window opens, `curl 127.0.0.1:7373/health` answers from a daemon living *inside* it, and the Desk reports `daemon connected`. Both load paths were checked, because they fail in different ways: from `file://` the preload's port is the only thing that can work, and the page reported `{ platform: "darwin", daemonPort: 7373, chooseDirectory: function }`; against a running Vite the same bridge appears deliberately *without* a port. A mock Station added through the daemon streamed a real run into the window — `text` → `tool` → `standby` → the **go** button clicked in the app's own UI → `done · $0.0012`, with `cuesheet-mock.md` written in the workspace. A second launch exited immediately and opened no second window. Quitting left no Electron process, a free port, no `daemon.json`, and a complete run record on disk; quitting while *attached* to a daemon it did not start left that daemon running, which is the case that matters.
>
> The Windows half is unverified and inherits Phases 0–4's debt. Step 24 is where it comes due.

### Decisions Step 21 settled

Seven things that were not in the step text, four of which are one-line fixes that each cost an afternoon when met during packaging instead:

- **`packages/desktop` typechecks in bundler mode, not `nodenext`.** The package is CJS at runtime and its sources are ESM syntax that a bundler resolves — under `nodenext` those two facts collide and `verbatimModuleSyntax` errors on *every* import in the package. `"module": "preserve"` is the setting that arrangement exists for. `tsc` no longer emits here at all; `build.mjs` does, so `tsconfig.build.json` is gone rather than left as a second, stale build path.
- **The daemon is reached through `await import()`.** A CJS file cannot statically import an ESM package, and `app.whenReady()` already supplies the async context. esbuild inlines it when bundling, so the dynamic import costs nothing at runtime.
- **`npm run build --workspaces` runs alphabetically, not topologically.** `cli, core, daemon, desktop, harness, ui` — so `desktop` bundled before `harness` and `ui` existed, and only succeeded because a previous build had left their `dist` behind. On a fresh clone it would have failed, which is exactly where it would have been least welcome. The root `build` script now names the six packages in dependency order.
- **Start-or-attach, not start-or-die.** `startDaemon` throws `PortInUseError` instead of exiting precisely so this caller can choose, and a dev machine routinely has `cuesheetd` already on 7373. The app attaches to a live one and records that it does not own it — `before-quit` must not take somebody else's daemon down. Verified in both directions.
- **The dev server is given no `daemonPort`, and that is load-bearing.** `apiOrigin()` prefers the bridge's port whenever it is present, which is right for `file://` and wrong for Vite: `http://127.0.0.1:7373` is a different origin from `http://localhost:5173`, the daemon sends no CORS headers — deliberately, since a loopback daemon that answers any website is a vulnerability — and every fetch dies as `Failed to fetch` behind a window that otherwise looks correct. The dev server proxies `/api` and `/ws` so relative URLs work. Found by running it; a passing typecheck and 381 green tests had nothing to say about it.
- **The preload's import graph must stay free of Node builtins.** A sandboxed preload has no `require`, so a single `import "node:path"` anywhere it reaches is a bridge that throws before it can expose itself — a window with no `window.cuesheet` and no error worth reading. `launch.ts` therefore imports nothing at all, and path resolution lives in `ui-entry.ts`, which only the main process touches.
- **`npx cuesheetd` was declared and not runnable.** Found while making the README's alpha instructions true rather than plausible: Step 8 gave the daemon a `bin`, but `tsc` emits `dist/main.js` with no shebang and mode `0644`, so the linked binary answered `Permission denied`. The source carries `#!/usr/bin/env node` now and the build chmods the file — a build step, not a one-off, because every rebuild re-creates it.
- **`ELECTRON_RUN_AS_NODE=1` is inherited from a VS Code terminal.** With it set, `electron .` runs as plain Node, `require("electron")` returns a *path string* from `node_modules`, and the app dies on `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` — a message that points at your code and is not about your code. Launch with `env -u ELECTRON_RUN_AS_NODE` from an editor terminal.

### Step 22 — Tray, notifications, start-on-login ✅ (macOS)
- Tray icon: macOS wants a **template PNG** (`iconTemplate.png` + `@2x`, monochrome with alpha); Windows wants a **multi-size `.ico`**. Ship both; pick by `process.platform`.
- Native notification when a run finishes or raises a standby.
- `app.setLoginItemSettings({ openAtLogin })` behind a preference. Works on both targets.
- Close-to-tray on Windows, keep-in-dock on macOS.

**Done when:** the tray menu can show/hide the window and quit cleanly, leaving no stray process (check Activity Monitor / Task Manager).

> **Built and running on macOS; the icon itself is a human check.** The tray is created from a generated template image, the menu reports the bound port, *Start at login* reads and writes the real OS setting rather than a preferences file of our own, and quitting from it leaves nothing behind. Screen capture is not permitted in this environment, so nobody has *looked* at the menu bar — that, and the Windows `.ico`, are eyes-on checks.

### Step 23 — Clean shutdown ✅
`before-quit` → stop the queue → kill every child process group → flush the run store → remove `daemon.json`. Any run interrupted this way is marked `interrupted`, not left `running` forever.

**Done when:** force-quitting mid-run and relaunching shows that run as `interrupted` with its partial events intact.

> **Done, and verified the only way it can be: by killing it.** A mock run was parked on a standby and the Electron main process `kill -9`'d — no handler of any kind runs on that path. The record on disk said `running`, with a stale `daemon.json` beside it. On relaunch the run reads `interrupted`, carries the reason, keeps all nine of its events, and the Desk shows the Station `idle` and **no standby buttons**.

### Decisions Steps 22–23 settled

- **The repair belongs to the daemon, not the shell.** `before-quit` cannot help with a force-quit, a panic, or a power cut, and `cuesheetd` and the CLI are killed the same way — a fix in the Electron main would have left the bug in every other entry point. `reconcileInterruptedRuns` runs inside `startDaemon`, and **the port is its safety argument**: the daemon refuses to boot while a live one holds it, so anything still marked non-terminal by then belongs to a process that is gone. An attach mode or a shared runs directory would break that, which is why it is written down in the file.
- **It scans the newest 200 runs, not all of them.** `RunStore` has no "give me the unfinished ones" query, so this is the second place the file store's scaling shows through — after `list()` — and the second reason SQLite is a beta item. A run left `running` further back than that is already old and already wrong; a slower launch does not fix it.
- **The partial event log is never tidied.** No synthetic `done` is appended and the torn last line of `events.jsonl` is left exactly as the kill left it. Reconciliation writes a status, a reason, and nothing else — the accumulated cost included, because a run that burned tokens before dying still burned them.
- **The OS stores the login-item preference.** `app.getLoginItemSettings()` reads the real login item or registry key, so there is no preferences file to write, migrate, or let drift out of step with what the system actually does.
- **The tray changes what closing a window means, so all three handlers move together.** Close-to-tray on Windows, keep-in-dock on macOS, and `window-all-closed` quits only when there is *no* tray — because a missing icon plus close-to-tray is a running app with no window and no way back to it, which is worse than either alternative.
- **Shutdown has a deadline.** `handle.close()` gets five seconds before the app quits anyway. A close that hangs must not become an app that cannot be quit.
- **Notifications interrupt only for a standby.** A finished run is already visible on its tile, and notifying for it teaches people to dismiss notifications unread — the exact habit that must not meet a standby, which is the one event where nothing moves until a human answers.

**Two bugs the crash test found in the Desk, which no unit test could have.** Both are the same shape: the daemon's record was right and the *screen* was lying.

- **A standby was never closed.** Nothing in the reducer ever removed one — not on an answer, not on `done`, not on a stop. Answering left the buttons on screen until a reload, and the crash left a question with **go**/**no** wired to a registry that no longer existed. A standby is now open only while its run's status is `standby`, and a resync drops the rest.
- **Opening a finished run replayed it as though it were live.** `run-detail` folded a historical log through the same path as live events, which re-opened that standby, re-lit a tile for work that had stopped, and added the run's `cost` events on top of the total already in its record. It also contradicted `snapshot`, where `activityFromRuns` has always skipped terminal runs for exactly this reason. Terminal runs are no longer replayed; the log pane is unaffected, because it reads the events the fetch replaced wholesale.

### Step 24 — Windows-specific pass ✅
Set aside a session for these; they are all one-line fixes that each cost an afternoon if discovered during packaging:
- Long paths (>260 chars) in `node_modules` — enable long paths or keep the install path shallow.
- `app.setAppUserModelId()` or notifications silently don't appear.
- Antivirus and Defender slowing first-run spawn — probe with a timeout, don't hang the UI.
- Keyboard hints must read `Ctrl`, not `⌘`.

**Done when:** a fresh Windows VM runs the dev build with no manual fixes.

> **Done on a real Windows 10 box (19045, Node 24.19.0, npm 11.17.0).** Taking the list in order:
>
> - **Long paths.** Not needed, and now measured rather than assumed: `LongPathsEnabled` is `0` on this machine and the install worked anyway. The deepest path in `node_modules` is 148 characters against `MAX_PATH`'s 260, so a checkout root under ~110 characters has room. `C:\Users\noahp\Desktop\Cuesheet` is 31.
> - **`tray.ico` and close-to-tray.** Verified functionally, which is stronger than looking at it: closing the window left the app alive with no window and the daemon still serving, and that handler returns early unless `tray !== null` — so the tray exists and the icon loaded. A second launch exited without spawning anything and restored the *original* window, which is also the way back.
> - **The glyph has now been looked at, by decoding the `.ico` rather than hunting the tray.** The file is sound: four PNG-compressed frames (16/24/32/48), every offset and length valid. (`System.Drawing.Icon.ToBitmap()` cannot decode PNG-compressed frames and throws — that is a GDI+ limitation, not a bad file. Windows Shell and Electron read them fine.) Rendered at 8× against both a dark and a light taskbar, **the mark reads from 24px up and is muddy at 16** — the three fader tracks collapse into grey smudges and only the blue centre cap survives. The coloured tile is a deliberate choice, and the reasoning in `make-icons.mjs` is sound, but against Windows 10's *default dark* taskbar the dark tile nearly vanishes, which is the case the tile exists to avoid. `drawMark` uses one set of proportions for every size; 16px wants its own, simpler treatment. **A design decision, left for the author.**
> - **`openAtLogin` round-trips.** `false → true → false`, read back through `app.getLoginItemSettings()` each time, and restored to its original value. This is the Step 22 feature whose macOS result proved nothing here, and it works.
> - **Notifications: everything around them checks out, and the toast itself still has not been seen.** Pursued properly the second time, against the *installed* app rather than a dev process: a gated run raised a real standby (`Gate "default" held this run… Override and continue?`), which is precisely the one event `watchForNotifications` forwards with `{ force: true }`. The shortcut the installer writes does carry the AppUserModelID — `Cuesheet.lnk` contains `io.github.npyrz.cuesheet` in UTF-16, the same shape as Discord's known-good `com.squirrel.Discord.Discord`. And still nothing reached the notification platform: the AUMID never appeared under `…\Notifications\Settings`, which is where Windows records an app that has actually sent one.
>
>   The cause is the machine, not the app: this box has toasts disabled system-wide (`ToastEnabled = 0`), and flipping that registry value does **not** re-arm the platform for a session already running — it needs Settings and a sign-out. So the honest state is: the code path is confirmed to execute, the AUMID plumbing is confirmed correct on both sides, and delivery is unproven. **Check it on a machine with notifications actually on.** (The value was set back to `0` afterwards.)
> - **CI.** It had never run, and it would have failed — see Step 27. Fixed, but still unrun on a runner.
>
> `app.setAppUserModelId()` is set at module scope to the same string as `appId` in `electron-builder.yml` — Windows silently drops every notification from a process without one, and a mismatch between those two files is the version of this bug that looks like "notifications just don't work". Nothing enforced that agreement, so `packages/desktop/src/app-id.test.ts` now does, in the spirit of `version.test.ts`.

---

# Phase 6 · Packaging and CI

> 🟡 **Alpha**, shipping `v0.1.0-alpha` at **Milestone B**.

### Step 25 — `electron-builder` ✅ (proven on both)
Targets: `dmg` + `zip` (arm64 **and** x64) for macOS, `nsis` for Windows x64. Ensure the UI build output and the daemon's non-JS assets are in `files`; native modules, if you ever add one, need `asarUnpack`.

**Done when:** `npm run build -w packages/desktop` produces an installer on each OS that launches from a path with a space in it (`/Applications`, `C:\Program Files`).

### Step 26 — Signing, honestly ✅ (documented, still unsigned)
- **macOS:** unsigned builds get quarantined; users need `xattr -d com.apple.quarantine` or right-click-open. Fine for pre-alpha — document it. Notarization when you have a Developer ID.
- **Windows:** unsigned installers hit SmartScreen. Also fine for now — document it.

Don't let signing block Milestone B. Just don't pretend it isn't there.

**Done when:** README install notes match what a stranger actually experiences.

### Step 27 — CI matrix ✅ (green on both runners)
GitHub Actions on `macos-latest` and `windows-latest`: install → typecheck → test → build the app. Upload installers as artifacts on tags.

**Done when:** a PR fails CI when a Windows-only path bug is introduced (add that as a test).

> **Both workflows were red by construction, and neither would have reached a Windows-specific failure to begin with.** `Build` ran *last*, after `Typecheck`, `Lint`, `Format` and `Test` — but `npm ci` leaves no `dist`, and every one of those steps resolves `@cuesheet/*` through each package's `exports` field, which points at `dist`. Simulated by deleting every `dist` and running the steps in the committed order: typecheck fails with `Cannot find module '@cuesheet/core'`, lint degrades into a wall of `no-undef` as its type information collapses, and 15 of 30 test files fail to resolve. The plan's own margin note — *"Working on `core` or `harness`? Build before you test"* — is the same fact, and CI did not follow it. `Build` now runs first in both `ci.yml` and `release.yml`, and the whole sequence was re-run on Windows from a `dist`-free tree installed by `npm ci`: green, 455 tests. The first red run would have been on *both* runners, for a reason with nothing to do with Windows.
>
> **And neither *could* have run at the time: the workflows were not on the default branch.** `git ls-tree -r origin/main -- .github/` was empty — both files lived only on `alpha`. So `push: branches: [main]` never had a chance to fire, and `workflow_dispatch` was not merely unused but **unavailable**: GitHub only offers manual dispatch for a workflow present on the default branch. `pull_request` was the one trigger that worked, because a PR runs the workflow from its *head* branch. **PR #2 (`alpha → main`) was therefore both the first CI run and the merge that made every later trigger exist** — and it is why the ordering bug above could not have been found any earlier than it was.
>
> **The Node version CI pins had never been run either.** Both workflows pin `node-version: 22`; the Windows box ran 24.19.0 and the Mac runs 25.2.1, so the pinned version was the likeliest source of a first red run that reads like a mystery rather than a finding. Reproduced exactly — fresh clone of `alpha`, Node 22.23.2, `npm ci`, then Build → Typecheck → Lint → Format → Test in the committed order — and it is green: 30 files, 460 passed, 1 skipped. A red Windows runner now means something Windows-specific. `ELECTRON_SKIP_BINARY_DOWNLOAD` was checked for the same reason and is safe: no test under `packages/desktop/src` imports `electron` at all — `app-id.test.ts` reads `main.ts` and `electron-builder.yml` as *text* and matches them with a regex.
>
> **Then it ran, and it was red — on timing, not on Windows.** Three tests assumed a fixed sleep was long enough for work to arrive, which is true on an idle laptop and not on a loaded runner:
>
> - `server.test.ts > answers a waiting standby` slept 20ms for an HTTP round trip *plus* a queue turn *plus* an executor reaching its first `await`, then read `standbys.list()` and asserted on `undefined`. This is the same defect already fixed in `queue.test.ts`, in the file next to it, missed because the sleep was 20ms rather than 5ms. Both files now carry a `waitFor` helper that polls and names what it was waiting for, and every wait-for-state in `server.test.ts` was converted — four sites, not just the one that went red.
> - `harness-executor.test.ts > produces a full run record in under a second` asserted a **wall-clock budget**. Step 14's "under a second" is a real design constraint, but as an assertion it measures the scheduler: ~600ms idle, over 1000ms with 30 files in parallel. What it is actually guarding — a real model or a network call sneaking into the mock path — costs seconds, so the bound is now 10s and still catches that.
> - `replays a mid-run backlog` was not flaky but was *silently weakening*: a 30ms sleep decided whether the client attached before or after the event was emitted, and attaching early takes the live path and stops covering replay at all, while staying green. It now waits on the emit itself.
>
> The suite then ran five consecutive times clean on Windows, and **`main` went green on both runners** — `macos-latest` 38s, `windows-latest` 1m. **The lesson is the one the first two flakes already taught: a fixed `setTimeout` is not a synchronisation primitive.** The whole suite was swept for the pattern afterwards — every other `setTimeout` in a test is either a poll interval inside a retry loop or an executor simulating work, and there is exactly one remaining wall-clock assertion, the loosened one above.
>
> **The done-when is already met, by something stronger than an OS-gated test.** "A PR fails CI when a Windows-only path bug is introduced" is exactly what `paths.test.ts` and `leash.test.ts` do with an injected `win32` `HostEnv`: they assert `C:\Users\noah\.cuesheet`, drive-letter casing, and the Windows-only `nocase` deny **from macOS**. A Windows-only path regression therefore goes red on *both* runners rather than only the one that can reproduce it. No new test is needed.
>
> **The macOS half is proven; nothing has run on a runner yet.** `npm run dist -w packages/desktop` produced `Cuesheet-0.1.0-alpha-arm64.dmg`, the x64 `.dmg`, and both `.zip`s. The arm64 dmg mounts, and the app inside it reports `CFBundleShortVersionString 0.1.0-alpha`, `io.github.npyrz.cuesheet`, and the generated `icon.icns`. Copied into a directory with a space in its name and launched, it boots its embedded daemon — `/health` answers `{"ok":true,"version":"0.1.0-alpha"}`, the version having travelled from `package.json` through `DAEMON_VERSION` to the wire — loads the Desk from `Contents/Resources/ui/index.html`, reports `daemon connected`, and quits leaving no process, no lockfile, and a free port.
>
> **The `nsis` half is now real, built on Windows.** `npm run dist -w @cuesheet/desktop` produced `Cuesheet Setup 0.1.0-alpha.exe` (106.5 MB) plus its blockmap. The unpacked tree puts the Desk at `resources/ui/index.html` and the tray icon at `resources/assets/tray.ico` — the paths `ui-entry.ts` and `assetCandidates()` look for, which is the agreement Phase 6 said would only be caught by opening the package. `app.asar` is 1.46 MB and holds the two bundled files, as designed. The exe reports `ProductName Cuesheet`, `FileVersion 0.1.0-alpha`.
>
> **Installed and launched from a path with a space**, which is the done-when: a silent per-user install to `C:\Users\noahp\Cuesheet Alpha Test\Cuesheet` exited `0`, created the Start Menu shortcut, and the installed `Cuesheet.exe` opened its window, served `{"ok":true,"version":"0.1.0-alpha"}` from its embedded daemon, rendered the Desk from the packaged resources, and quit from **File → Exit** leaving zero processes, a free port, and no `daemon.json`.
>
> Neither workflow has run on a runner. Both were also **wrong** until this session — see Step 27.

### Decisions Phase 6 settled

- **One command sets the version; a test keeps it set.** `DAEMON_VERSION` is a literal so it survives bundling into an asar, which means nothing makes it track `package.json` — `/health` would answer `0.0.0` from a `0.1.0-alpha` build, and the first bug report would carry the wrong version. `node scripts/set-version.mjs <version>` writes all seven `package.json`s and the literal; `packages/daemon/src/version.test.ts` fails the build if they ever disagree. Generating `version.ts` at build time was the alternative and it is worse: a fresh clone would not typecheck until something had been built.
- **The tag is checked against the tree.** `release.yml` refuses to build when `v0.1.0-alpha` does not match the version in `packages/desktop/package.json`. The version test proves the copies agree with *each other*; only this proves they agree with what you tagged.
- **The release is a draft, always.** The workflow uploads installers and stops. Publishing is a person pressing a button, which for an unsigned alpha is the difference between a release and an accident.
- **`extraResources` and `uiIndexCandidates` are one decision in two files.** The builder puts the Desk at `<resourcesPath>/ui`, which is the first path `src/ui-entry.ts` looks for. If they ever stop agreeing, the packaged app opens the "Desk has not been built" dialog — verified by mounting the dmg, not by reading the config.
- **The asar holds two files.** `main.cjs` and `preload.cjs`, because `build.mjs` already bundled the daemon, fastify and ws into them. `node_modules` is excluded *explicitly*: this is a workspace, so `node_modules/@cuesheet/*` are symlinks, and symlinks in an asar fail only once packaged. For the same reason the three `@cuesheet/*` entries moved to `devDependencies` — after bundling they are build-time inputs, and electron-builder should not be trying to package them.
- **Electron is pinned exactly.** `electron-builder` refuses a range outright: it downloads platform binaries for one specific release. A reproducible installer wants a reproducible runtime anyway.
- **CI skips the Electron binary download.** Nothing in the check matrix launches Electron — typecheck reads the `.d.ts` from the npm package and the build is esbuild — so the ~100 MB download is removed from the flakiest step of the Windows job. The release workflow, which packages a real app, keeps it.
- **`npm run build -w packages/desktop` is the bundle, not the installer.** Step 25's text above assumes one script does both; splitting them keeps `npm run build` fast and offline. The installer is `npm run dist -w packages/desktop`, and `pack:dir` gives you an unpacked `.app` in seconds when you only need to check the layout.

### Decisions the Windows pass settled

Five things the machine found that 451 green tests on macOS could not. Three are bugs in the product or its build, and two of those were *passing* tests hiding a real defect.

- **A fixed `setTimeout(…, 5)` is not a synchronisation primitive, and one of them was hiding a queue bug.** Two standby tests slept 5ms waiting for the executor to reach `ctx.ask`, which 29 parallel test files on Windows do not guarantee; they timed out. Converting them to poll made a *third* test fail deterministically — `shutdown` hanging forever — and that one was not a flake. `runOne` sets `active` (and so the controller `stop` and `shutdown` reach for) *before* the `running` write, then calls the executor after it. An abort landing in that window was silently dropped, and an executor that only registers an `abort` listener never saw the event it was waiting for. The shipped executors escape it because `spawn.ts` and `harness-executor.ts` both check `signal.aborted` first; the contract should not depend on every harness remembering to, so `runOne` now refuses to start work whose abort already landed. **On macOS the test passed because 5ms was too short** — shutdown ran before the run started, taking the queued path, and the case the test is named for was never exercised.
- **A Windows `dir` symlink needs Developer Mode or elevation; a junction needs neither.** Three `observedStation` tests died on `EPERM`. The repo's own checklist says to probe and skip, but skipping would delete the assertion on the platform where drive letters and casing make it most interesting. `symlink(target, link, "junction")` needs no privilege and `realpath` resolves it identically, so the test keeps its meaning here.
- **`money()` called a run that spent real money `local`.** Photographed, not deduced: a stopped `claude-code` run rendered `stopped local 39s`. The settled price arrives once, on the final result event, so a run killed before that end has tokens and no `usd` — the exact record an ollama run leaves. Phase 4 fixed this shape for tiles and the run row kept the identical call. `money()` now takes the run's status, and absent a normal ending renders `—`, because the price is *unknown* rather than *nothing*. `held` is deliberately not in that set: a Hold ends a run that ran.
- **CI had never run and would not have survived its first minute** — on either OS. Recorded under Step 27.
- **`ELECTRON_RUN_AS_NODE=1` is inherited from a VS Code terminal on Windows too**, and the plan only wrote down the macOS incantation. `env -u ELECTRON_RUN_AS_NODE` has no PowerShell equivalent; there it is `$env:ELECTRON_RUN_AS_NODE = $null` before launching. Without it `electron .` runs as plain Node and dies on `requestSingleInstanceLock` of `undefined` — a message that points at your code and is not about your code.

**Two found later, while chasing the tray and the toast — both from *using* the app rather than testing it.**

- **A UTF-8 BOM stopped the daemon booting, and said nothing useful about why.** Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM, and **so does Notepad** — the two most likely ways somebody hand-edits `cuesheet.toml` on Windows. `smol-toml` then reads U+FEFF as the first character of the first key and rejects the file with *"only letter, numbers, dashes and underscores are allowed in keys"*, pointing at a `[[station]]` line that is plainly correct. The app showed a bare **Error** window and exited; the daemon refused to boot. Nothing in that message mentions encoding, so there is nothing in it to act on. `parseConfig` now strips a leading BOM — `readFile(…, "utf8")` does not do it for you, Node only strips BOMs for UTF-16. Isolated by removing the BOM from the identical file and watching the same released binary boot. Stripped at the start only: U+FEFF inside a string is the user's data.
- **The installer will happily take a non-empty directory, and the uninstaller then owns it.** The released `.exe` was pointed at the repo checkout, and afterwards `HKCU\…\Uninstall` read `"C:\Users\noahp\Desktop\Cuesheet\Uninstall Cuesheet.exe" /currentuser`. electron-builder's NSIS uninstaller removes its install directory recursively, so running it from Settings would have taken the working tree with it — `node_modules`, `packages/desktop/release`, and anything unstaged. Nothing tracked was clobbered by the *install* itself, and the app files were removable by name, but that is luck rather than design. `allowToChangeInstallationDirectory: true` is what exposes this. Worth a `beforeInstall` check that refuses a non-empty target, or dropping the directory picker while this is an alpha.

**One thing that is not a bug, so nobody spends an afternoon on it:** `POST /runs/:id/stop` answers `415` to PowerShell's `Invoke-WebRequest -Method POST`, which attaches a form content-type to a body-less request that fastify has no parser for. The Desk sends `fetch(url, { method: "POST" })` with no body and no content-type, which is accepted, as is `curl -X POST`. It is a quirk of the client, not the route.

> ### 🏁 Milestone B — the app ships · `v0.1.0-alpha`
> *First public tag. Alpha, and labelled alpha.*
>
> **The badge moved early, deliberately.** This line used to say the README's status badge changes here "and nowhere earlier"; it was flipped to `alpha` at the end of Step 21 instead, on the grounds that Phase 5 is where the stage table already says alpha begins. The README carries the caveat the badge cannot — no installers, unsigned, one harness, macOS only — in *What actually works right now*. Do not revert it back to `pre-alpha`.
>
> Downloadable installers for macOS and Windows that a person with Claude Code installed can open and use without reading a config reference. Unsigned, one harness, no gates. Say all three in the release notes.
>
> ## ✅ Reached — `v0.1.0-alpha` is published.
>
> Tagged, built on runners, drafted, and published by hand on 2026-09-15. Five installers: `nsis` for Windows x64, and `dmg` + `zip` for both Mac architectures. The route there, kept because the order turned out to matter:
>
> 1. ~~**Step 24.**~~ Done. Nothing in this repo had ever run on Windows; all of it now has — `npm ci`, build, typecheck, lint, format, 455 tests, a real `claude-code` run at `$0.29`, a stop that took the process tree to zero, a `taskkill /F` crash that reconciled to `interrupted`, the NSIS installer, and the installed app launched from a path with a space.
> 2. ~~**CI green on Windows.**~~ Done. The workflows reached `main` with PR #2, which is what made any trigger fire at all; the first runs were red on the ordering bug, then on three timing flakes, and `main` is now green on both — `macos-latest` 38s, `windows-latest` 1m. Every Windows-specific decision in this repo has now been executed by a machine that is not the author's.
> 3. ~~**`release.yml` has never run.**~~ Proven the cheap way first: `workflow_dispatch` builds and uploads the installers **without** creating a release, so the packaging path — Electron download, `electron-builder`, the `nsis` target — was green on both runners before anything was tagged. Then the tag ran it for real, and the two tag-gated steps that a dispatch skips (`Tag matches the version in the tree`, `Create the draft`) both passed. Doing the dispatch first cost one click; a failed tag build costs a deleted tag on a public repo.
> 4. ~~**A human pressing publish.**~~ Done, by hand, as intended.
>
> **Post-release note.** The runner-built `.exe` was installed and run before publishing — but into a *non-empty directory*, which is its own hazard: see the installer warning below. The Windows tray glyph and a real toast are still the two things nobody has confirmed with their eyes; both are recorded under Step 24.

---

# Phase 7 · Gates, for real ✅

> 🔵 **Beta track.** The first phase past alpha, and the first one whose absence made the README a claim rather than a description.

Gates were built in an earlier increment and worked — against `mock` reviewing `claude-code`. That is a demonstration, not a feature. `distinct_vendors = 2` is an equality check over `vendor`, so a build shipping one real vendor cannot satisfy the README's own headline example, and nobody gates work they care about behind a fake reviewer.

This phase closes that with the harness the plan had been deferring, and then proves the whole thing with money on the line.

### Step 28 — The `codex` harness ✅

Write `packages/harness/src/codex.ts` against **captured** streams, never from memory. Probe, usage, context files, connectors, run. Map the event stream onto `HarnessEvent`s. Register it in `defaultHarnesses()`.

**Done when:** `codex` appears in `GET /stations`, a Station can be added to it from the Desk, and a run streams into a tile.

### Step 29 — The reviewer seat ✅

The daemon already assembles the review brief and parses the verdict, so the harness's job is narrower than it looks: stream the agent's text faithfully, and make `role = "reviewer"` mean something the subprocess cannot ignore.

**Done when:** a `read-only` Codex Station returns a verdict `parseVerdict` reads, and cannot write to the workspace even if it tries.

### Step 30 — The two-vendor run ✅

One run, two vendors, a real gate, on a real repo. Anthropic writes, OpenAI reviews, and the gate decides.

**Done when:** a run lands `held` with a blocking finding from a vendor that did not write the code — and the negative case holds too: an unreadable review abstains rather than approving.

> **Done, and the blocker turned out not to be a design problem.**
>
> This harness sat unwritten behind one sentence: *"nobody has the CLI installed on this machine, and a harness whose stream mapping has never seen a real stream is a guess."* The second half of that was right and is the reason this file is trustworthy. The first half was a fact about a machine, recorded once and then believed for six weeks. It cost `brew install --cask codex` and ninety seconds to falsify — and `codex login status` then answered *"Logged in using ChatGPT"*, because the credential had been sitting in `~/.codex/auth.json` the whole time.
>
> **The lesson worth keeping is about the shape of the blocker, not about Codex.** A blocker that is a *design* problem stays blocked until someone thinks. A blocker that is an *environment* problem expires silently, and nothing in the document knows it has. The M5 checkbox above now says which kind it was; the ones still open should be read the same way. Two of the three "eyes-on" items in the README had gone stale exactly this way and were found in the same pass.
>
> Three streams were captured before a line of the mapper was written — an engineer run that applied a patch, a `read-only` review given Cuesheet's own `REVIEW_INSTRUCTIONS`, and a failure against a model the account cannot use. All three are fixtures now, so the mapper is tested on a machine with no Codex installed.
>
> **Five things the real streams settled, four of which a guess would have got wrong:**
>
> - **Codex's token fields are inclusive; Claude Code's are not.** `claude-code.ts` *sums* `input_tokens` with both cache fields, because that API reports them side by side. Codex nests them: `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` a subset of `output_tokens`. Three captures agree (29952 of 34620, 82560 of 88658, 12928 of 17075), and the review run settles it arithmetically — 839 output minus 658 reasoning leaves 181, which is the size of the JSON verdict it printed. **Symmetry with the sibling harness would have double-billed every run**, in a ledger whose entire purpose is that nobody is surprised by an invoice.
> - **An `error` *item* is a warning; only `turn.failed` is fatal.** The failing capture emits both. `{"type":"item.completed","item":{"type":"error","message":"Model metadata … not found"}}` arrived and *the run carried on and did the work*. Treating an error item as fatal — the obvious reading — would fail runs that succeed.
> - **Codex reports no dollar figure at all.** Claude Code hands over `total_cost_usd`; Codex hands over tokens and nothing else. `Cost.usd` stays absent rather than being invented from a price table that goes stale the week a model is repriced. The Desk already renders a token-only cost, so this needed no change above the harness — but it means a two-vendor run's dollar total is the Anthropic half only, and M2 will have to say so.
> - **`item.started` and `item.completed` carry identical payloads.** Without de-duplication every command and every patch renders twice in the run log. Keyed on item id, not on content, because two identical commands are a real thing an agent does.
> - **The leash is weaker here than for `claude-code`, and the difference is structural.** Codex does most of its work through shell commands. A `file_change` item announces an `apply_patch` and those paths are checked — but the very first capture wrote a file with `printf %s hello > greet.txt` inside a `command_execution` and emitted no `file_change` at all. **A write inside a shell command is invisible to path observation.** Parsing paths out of arbitrary shell was considered and refused: it would work on `printf > x` and silently miss `tee`, `sed -i`, a heredoc, or `python -c`, and a leash that fails quietly is worse than one documented as partial. What holds the line instead is Codex's own `--sandbox`, set from the Station's role — `read-only` for a reviewer, `workspace-write` for an engineer, and `danger-full-access` unreachable. That is enforcement by the CLI rather than by us, the same bargain `claude-code.ts` strikes with `--permission-mode`.
>
> **One refactor the second harness forced.** `observedStation()` — which resolves a workspace through `realpath` so that observed paths and leash globs are compared like-for-like — lived inside `claude-code.ts`. Codex needed exactly the same correction, for exactly the same reason: both hand work to a subprocess that reports already-resolved absolute paths, and on macOS a workspace under `/tmp` sees every one of its own writes arrive as `/private/tmp/...`. It moved to `observe.ts`. A harness importing another harness is precisely the coupling this package is arranged to prevent, and the rule is worth stating: **the moment two harnesses need the same helper, it stops belonging to either of them.**

#### What the two-vendor gate actually did

Not a fixture. A real repo, both CLIs, both plans billed:

```
RUN  "Add rate limiting to the upload endpoint in upload.js."

  opus   claude-code  anthropic  implement   ✓  +22 −1  upload.js
  gpt    codex        openai     review      ✗  1 blocking finding
         └─ security · the limiter permanently retains every caller IP,
            allowing unbounded memory growth and eventual denial of service
  gate   default      hold
         └─ 1 blocking finding (security).
         └─ 0 of 1 required approval (1 review recorded).

  status  held        $0.5552     2m 51s
```

Claude Code wrote a fixed-window limiter keyed on `req.ip` — correct as far as the brief went. Codex, which had not seen the brief being written and does not share Anthropic's training, read the diff and found the thing the author did not: the `Map` grows forever, so the rate limiter is itself a memory exhaustion vector. That finding is the entire argument for Gates in one line. A second opinion from the same vendor would have been likelier to admire the same code.

The run was then answered **no** at the standby and landed `held`, with the verdict, the finding and the reasons on the record.

**And the negative case, which is the one that decides whether Gates are a safety feature or a decoration:** a reviewer whose reply contains no parseable verdict **abstains**, and an abstention cannot satisfy `require`. Both halves are tested against real Codex output — a run that talked but never rendered a verdict block, and a stream that died mid-turn. Neither reads as approval. A crashed reviewer waves nothing through.

### Decisions this phase settled

- **`vendor` is load-bearing, so the registry now asserts it.** A test fails if the default registry ever ships fewer than two distinct non-`mock` vendors. Someone copying a harness file and forgetting to change one string would otherwise weaken every Gate in every config, silently, with all tests green.
- **A reviewer's sandbox comes from its role, not from its prompt.** The README says a reviewer "cannot write to the workspace". `--sandbox read-only` is what makes that true of the subprocess. `caller` gets the same treatment ahead of M6 — a Caller that could edit is not a Caller.
- **`probe()` may answer the auth question honestly when the CLI is cheap about it.** `claude-code` reports `authed: true` optimistically, because Claude Code has no free auth query and a throwaway prompt would cost tokens on every poll of `/stations`. `codex login status` costs nothing, so this harness asks. Two harnesses answering the same field with different confidence is fine; pretending otherwise would mean making the good case worse.
- **Another vendor's noise is not this run's output.** Codex logs `rmcp::transport` errors to stderr on every run when a configured MCP server is not listening — a fact about the operator's `~/.codex/config.toml`, not about the run. Filtered narrowly, on the module path rather than on the word `ERROR`, so a real failure still reaches the log.
- **The CLI is now the thing blocking the README's own example.** `cuesheet run --engineer opus --review codex` is printed in the README and `packages/cli` is one line: `export {}`. Gates were the reason that snippet did not work; they are not any more.

---

# Phase 8 · Projects

> 🔵 **Beta track.** The phase that turns a tool you point at a directory into an app you open. Everything the Desk rebuild needs sits on top of it, which is why it goes first.

Cuesheet today has no idea what a project is. `startDaemon` takes one `cwd`, `loadConfig` walks exactly two candidates — `<cwd>/cuesheet.toml`, then `~/.cuesheet/cuesheet.toml` — and `createFileRunStore` has one root. A Station carries a `workspace`, so a single config *can* address several repos, but there is one config, one run history and one queue across all of them, and nothing anywhere records that you were working on something yesterday.

The packaged app makes this sharper than a checkout does. `main.ts` calls `startDaemon({ ...harnessRuntime() })` with no `cwd` and never calls `process.chdir`, so a double-clicked `.app` resolves `process.cwd()` to whatever the OS hands it — on macOS from Finder, `/`. The first candidate path can therefore never match, and the app falls through to the global `~/.cuesheet/cuesheet.toml` every single time, silently. That is not a bug to patch. It is the absence of this feature, showing.

**The decision this phase forces, and it belongs at the top rather than in the work: one daemon serving many projects, not one daemon per project.** The port is fixed by design — `findRunningDaemon` and the lockfile exist so that every client, including a second window and later the phone, finds *the* daemon. A daemon per project multiplies ports, lockfiles and trays, and breaks the one contract the architecture is arranged around. So project scope moves onto the routes and into the store, never into the process.

### Step 31 — A project is a thing ✅

`Project` in `@cuesheet/core`: an id, a display name, a root directory, its config. A registry of them at `~/.cuesheet/projects.json` — the first persistent state Cuesheet owns that is neither config nor a run record, which is why it needs its own home and its own answer to "what happens when the folder is gone."

Config becomes per-project. `loadConfig`'s two-candidate search stops being the mechanism and becomes the migration *source*.

**Done when:** a project opened once is in the registry with its last-opened time and survives a daemon restart, and a project whose folder has been deleted or renamed lists as missing rather than crashing the picker.

> **Done, with one clause of that criterion deliberately not ticked.** `project.ts` and 32 tests; `paths.ts` gains `projectsFile`, `projectsDir`, `projectDir`, `projectConfigFile` — and `PROJECT_ID_PATTERN` itself, which lives beside the builders rather than with the registry because the constraint *is* a path constraint. **The guard is enforced there, not documented.** A first draft asked callers to validate an id before handing it over; Step 32 hands a URL segment straight to `projectDir()`, and an obligation in a comment is a guard nobody runs. It throws, and a test proves `projectDir("../../etc")` is refused. **`loadConfig` is untouched, on purpose** — rewiring it is Step 32's first bullet, and doing it here would leave the daemon half-converted with nothing demonstrable. This step ships a registry nothing consumes yet.
>
> **"Survives a daemon restart" is not proven, because there is no daemon in this step.** What is proven is the mechanism it will rely on: a second `createProjectRegistry` over the same file reads back exactly what the first wrote, because nothing is held in memory that is not on disk. The restart clause belongs to Step 32 and is not being quietly redefined into something easier — this document has a retrospective about exactly that.
>
> **Four decisions, each a fork someone would otherwise take the other way:**
>
> - **An id is assigned once, not derived from the path.** Deriving it makes `open()` idempotent for free — and silently mints a *different* project when a folder is renamed, orphaning its run history at the moment a user least expects to lose anything. So the id is stable, the root is mutable data, and idempotency comes from the next decision instead.
> - **Identity is the resolved root.** `open()` resolves through `realpath` before matching, because a path and a symlink to it are one project. This is the `observe.ts` lesson arriving before it cost anything rather than after — the same asymmetry that made a `/tmp` workspace see its own writes as `/private/tmp/...` would otherwise duplicate an entry every time someone opened a linked checkout.
> - **Stored roots are compared, never re-resolved.** A deleted folder cannot be `realpath`ed, so re-resolving at compare time would throw `ENOENT` on precisely the case the done-when says must stay calm.
> - **Config is referenced, never copied in.** The prose above says a Project is "an id, a display name, a root directory, its config" — that is a sentence, not a schema. Persisting parsed config into the registry would create a second source of truth that disagrees with `cuesheet.toml` the moment anyone edits it by hand.
>
> **A broken registry throws, and the reason is the opposite of `config.ts`'s.** That file throws on a broken config because an empty Desk would hide a typo. This one throws because starting from an empty list would *discard someone's projects*, which the beta bar forbids outright. Same verb, opposite reason, and in both cases the file is left byte-for-byte alone — asserted, not assumed. A registry written by a newer build is refused for the same reason: three lines now, a migration later, and Step 53 already promises it.
>
> **There is no `moved` status.** A renamed folder and a deleted one leave identical evidence without inode tracking, so `missing` covers both and the UI is not handed a guess to present as a fact.
>
> **One thing the work found that the step text did not anticipate.** `pathFor(env)` exists so pure string math can be tested for a platform the test is not running on — but `node:fs` is bound to the *real* host, so resolving a POSIX path with `path.win32` produces backslashes the filesystem cannot then find. A Windows-env test failed on macOS and was right to. The rule now stated in the file: **`pathFor(env)` for layout and for strings, ambient `nodePath` for anything that reaches disk.** Worth carrying into Step 32, which will build far more paths than this step does.

### Step 32 — The daemon serves more than one ✅

Project-scoped routes. `/runs` and `/stations` are implicitly global today; they become `/projects`, `/projects/:id/stations`, `/projects/:id/runs`. One run-store root per project, or one root keyed by project — decided in the work, on whether `store.list(limit)` can stay O(recent) either way.

Three places bake in single-project scope and all three are in this step: the single `loaded = await loadConfig(cwd, env)` and its `reload` closure, the single `createFileRunStore({ env })`, and `reconcileInterruptedRuns({ store })` at boot, which today repairs one store and would need to repair every project's.

**Done when:** two projects are open at once, a run started in one never appears in the other's list, and `GET /projects` answers before any project has been opened.

> **Done, and it also discharges Step 31's deferred clause.** `projects.ts` in the daemon holds a `ProjectRuntime` per project — config, reload closure, store, queue, bus — memoized and built on first touch. `server.ts` lost its single `store`, `queue`, `config` and `reload`; `DaemonHandle` lost `store`, `queue` and `reloadConfig` and gained `projects`, `registry` and `defaultProject`. The UI cut over with it. 549 tests pass.
>
> Step 31 could not prove "survives a daemon restart" because it was core-only, and that was recorded rather than quietly redefined. **It is proven here**: a project opened, a daemon closed, a second daemon started over the same home, and `GET /projects` still lists it — with the daemon coming back up *on* it rather than making the operator pick again. A project whose folder has gone is listed `missing` and is deliberately not booted into.
>
> **The routes cut over rather than aliasing, and the reason is the architecture.** Keeping `/runs` working would mean it addressed *something*, and the only available meaning is "the active project" — a daemon-side notion of which project is current. That is exactly what Phase 8 decided against at the top. Two clients, or a window and a phone, looking at different projects makes it incoherent; and Step 34's requirement that switching never disturb a run is trivially true only while the daemon has no opinion about which project you are in. So which project a client means is a path segment, and `defaultProject` on the programmatic handle is a convenience for tests that never changes for the life of the process.
>
> **Five decisions, and the first was nearly a shipped bug:**
>
> - **Bootstrap reads the config that exists, never `cwd`.** An existing install has to get its project back, and the obvious source is the working directory. But this phase's own opening paragraph is that `process.cwd()` is `/` in the packaged app — so `open(cwd)` would mint a permanent registry entry rooted at the filesystem root, on macOS, for every user, and `registry.open()` would not stop it because `/` is a directory. It bootstraps from `loadConfig`'s `sourcePath` instead, which is the honest answer to "which folder was this person working in". **A test asserts a cwd with no config contributes nothing.**
> - **Each project gets its own bus, mirrored into a daemon-wide one.** A filtered shared bus would have had to drop backlog it could not attribute — and `attach()` returning its replay synchronously is load-bearing (see `bus.ts`). The tray keeps one subscription and is notified whichever project raised a standby; `DaemonHandle.bus` is documented as interleaved so nobody later reads a per-project backlog off it.
> - **A store root per project**, which the step text left open. The deciding property is `store.list(limit)`: run ids are timestamp-prefixed so a lexical sort of directory names *is* chronological, and `list()` answers off `readdir` alone. A shared root keyed by project means filtering every run ever — the O(all runs) shape `reconcile.ts` already flags — or an index. It also makes Step 33's migration a directory move.
> - **Reconciliation moved from boot to first touch.** `reconcile.ts`'s safety argument is unchanged: nothing can *observe* a run left `running` by a dead process. But it is now discharged per project when its runtime is built, which is O(projects actually opened) rather than O(every project ever registered) on every boot forever.
> - **`/standbys/:id` stayed global.** Standby ids are unique daemon-wide because one registry is shared by every runtime, and a phone answering a standby should not have to know which project raised it. One registry per runtime would have broken that route for every project but the first, silently.
>
> **Two bugs the work produced and the tests caught, both worth recording because neither would have failed loudly:**
>
> - **The memoization was not memoizing.** `get(id)` awaited `registry.get(id)` *before* inserting into the map, so three concurrent requests for a cold project all passed the cache check while that lookup was in flight and each built its own queue over one store root — the lost-update shape `projects.json` is serialized against, arriving through a different door. The promise is now inserted synchronously, before the first `await`. The test that caught it asserts identity across three concurrent cold `get`s, and nothing else in the suite would have noticed.
> - **`registry` collided with `registry`.** `harnessRuntime()` spreads a registry of *harnesses* into `startDaemon`'s options, and a new `registry?: ProjectRegistry` silently took the same name. TypeScript caught it only because a call site passed both explicitly — through the spread it would have compiled. Renamed `projectRegistry`.
>
> **One hazard found in the tests themselves:** a test that calls `startDaemon` without an isolated `env` now writes to the developer's real `~/.cuesheet/projects.json`. `reconcile.test.ts` was doing exactly that. Every `startDaemon` in the suite now passes its own home — worth remembering for every step after this one, because the failure is invisible locally and permanent.
>
> **The shell needed one button, or the cutover would have shipped an app nobody could open.** With no config anywhere a fresh install bootstraps no project, which is correct — and left the Desk on a placeholder with no way out, because nothing in the shell could create one. `window.cuesheet.chooseDirectory()` has existed since Step 5 for the add-a-Station panel, and `POST /projects` now exists, so the empty state offers **open a folder…** in Electron and an instruction in a browser. It is deliberately not a picker: Step 40 builds recents, the missing-folder state and the real launch surface, and Step 41 puts a switcher above it.
>
> **Two things carried forward rather than assumed:**
>
> - **Step 34's constraint is now cheap to test and is not tested yet.** Per-project queues and per-project sockets make "a switch is not a stop" *likely* true, and the retrospective above argues it from the design. That is an argument, not evidence. The test — start a long run in A, drop A's socket, attach to B, assert A's run is still `running`, reattach and assert the backlog replays it — belongs to Step 34's done-when and is where it will be written.
> - **Step 33 must not change what `defaultProject` means.** Every daemon test now boots through bootstrap-from-`sourcePath` and addresses routes through that one project; `server.test.ts` alone has 41 call sites hanging off it. A migration that changes which project a daemon comes up on re-bases the entire suite, so it should move run history and re-root the bootstrapped project *without* changing the rule that the daemon reopens the most recently opened one.

### Step 33 — The upgrade that loses nothing ✅

The beta bar already promises "no data loss, ever" and config migrations. This is the first migration that has to keep that promise rather than state it: an existing install has one `~/.cuesheet/cuesheet.toml` and one `~/.cuesheet/runs` of history, written by a version that had never heard of projects.

**Done when:** an alpha install opens on the new build, its config is project #1 with its Stations intact, and every run record it already had is still readable and still attributed — verified by upgrading a real alpha profile, not a fixture.

> **Done, and the done-when's last clause was the one worth insisting on.** `core/migrate.ts` (three exported functions, 18 tests), a rewritten `bootstrapProject`, and `packages/daemon/src/migrate.test.ts` (9 tests) covering the alpha layout end to end. 578 tests pass, up from 549.
>
> **The real profile, because "not a fixture" is the whole clause.** A worktree at `v0.1.0-alpha`, built, run with `HOME` pointed at a scratch directory, a global `~/.cuesheet/cuesheet.toml` with a `mock` Station, three runs driven through the HTTP API — one answered through a standby to completion with a real `diff.patch`, then `kill -9` on the daemon, leaving one run `running` and one `queued` on disk. The new build booted over that same home. Config and all three run records arrived at their new paths **byte for byte identical** — checksummed before and after — the Station kept its `paths` leash, the two non-terminal runs came up `interrupted`, and a second boot moved nothing. That is what the committed tests cannot prove, since CI cannot build the alpha tag; the tests exist to keep it from regressing, and each layer says which clause it is answering.
>
> **The config half turned out to already work, and checking first is what kept this step small.** Step 32 rooted a global-config user at `~/.cuesheet` — and `projectConfigSearchPaths` makes `<root>/cuesheet.toml` candidate one, so for that root the legacy file *is* the first candidate. Their Stations were never at risk, and `addStation` was already editing that file in place through `sourcePath`. Copying the config into the private path — the obvious first move — would have *created* the second-source-of-truth problem it looked like it was solving. So what was left was the run history and the root, which is what the step actually is.
>
> **The root derivation refuses to guess, and the discriminator is shadowing rather than plausibility.** A project rooted at `~/.cuesheet` puts a dot-directory in the picker where the user expects their repository, so the root now comes from the Stations' `workspace` fields — the only evidence on disk about where the code is. But `<root>/cuesheet.toml` *wins* over the private fallback by design, so rooting at a folder that already has one would hand that file the project and make every alpha Station silently vanish. A derived root is therefore accepted only when the Stations agree on exactly one existing directory **and** that directory has no config of its own; anything else stays at `~/.cuesheet`, where the legacy file is still candidate one and stays live. Stations with no `workspace` are skipped rather than counted as disagreement, and so are workspaces no longer on disk — an alpha config can name a checkout that has since moved, and that is absence of evidence, not a conflict.
>
> **When a root *is* derived, the config must move, and that is the one thing here that is not reversible.** The new search path is `[<root>/cuesheet.toml, ~/.cuesheet/projects/<id>/cuesheet.toml]` and the legacy file is in neither, so left alone it would take the project up on built-in defaults — the exact loss the step is named for. Moved rather than copied, for the reason above. **The recorded cost: an alpha build downgraded to after this runs will not find its config.** Upgrades keep everything; downgrades were never promised, and the registry already refuses to be read by an older build.
>
> **One bug the review caught, and every fixture in both suites would have kept passing over it.** The config move first asked "is this project rooted somewhere other than `~/.cuesheet`?" and read yes as "then the global config is its config." It is not. A user can have a `cuesheet.toml` in their repo **and** a leftover global one — alpha's `addStation` wrote the global file whenever the loader had resolved nothing, which is what a Finder-launched app always got — and for that user the old guard passed and relocated their global config under a project whose repo config shadows it. Moved somewhere nothing would ever read it again, which is the loss this step is named for, caused by the function written to prevent it. Every fixture had exactly one config on disk, so nothing failed. The guard now compares against `loaded.sourcePath`, because the only thing that can say which config a project is loading is the loader; the second guard restates the `~/.cuesheet` case as "is this file already the first candidate for that root" rather than naming a directory, which is what it actually meant. Both suites gained a two-configs test.
>
> **Ordering is load-bearing, and getting it wrong would not have failed loudly.** `runtimes.get` reconciles a project's store the first time it is touched and never again. Moving the history in *after* the runtime existed would reconcile an empty store and leave every run a killed alpha daemon left `running` marked `running` forever, with nothing left to correct it. Both moves therefore happen between `registry.open` and `runtimes.get`, and the test that proves it is the `kill -9` run coming up `interrupted` rather than a count of migrated files.
>
> **Idempotency needs no marker file.** Each move guards on its own target being absent, which is the question a marker would have been answering anyway — and a marker is a third thing that can disagree with the two it describes. A failed run-history move registers nothing, so the next boot arrives back at the same call; that retry is restricted to a registry holding **exactly one** project, because legacy runs belong to the install rather than to a folder, and with two projects the daemon would be picking an inheritor for a history that names neither.
>
> **A failed migration does not stop the daemon.** Nothing is deleted, so the worst case is a boot that reports what it could not move and serves `/projects` anyway. The config failure is logged as an error rather than a note, because that project comes up on defaults until it succeeds — and the one hole left open, recorded rather than discovered: if that move fails and the user then adds a Station, the private config exists and the absent-target guard blocks the retry for good. An edge of an edge, and the log says so loudly at the moment it matters.
>
> **`defaultProject` means exactly what it meant.** Step 32's retrospective asked for this explicitly — `server.test.ts` alone hangs 41 call sites off it — so the daemon still comes up on the most recently opened project that is still there. The migration re-roots project #1 and moves history under it without touching that rule, and the whole suite passed unchanged.
>
> **One thing the work tidied because it was a latent drift.** `projectRunsDir(id, env)` now lives in `paths.ts` and is used by both the daemon's store root and the migration target. They were two separate `join(projectDir(id), "runs")` expressions, and a migration that moves history to a directory the store does not read loses it exactly as completely as deleting it would.

### Step 34 — Open, and switch ✅

The launch behaviour the app has never had: reopen the project you were last in, pick one from recents, or choose a folder. Switching is a client action over a daemon that already holds both.

The queue is per-daemon and runs are long, so the constraint worth writing down before anyone builds it: **a switch is not a stop.**

**Done when:** switching projects while a run is streaming neither cancels it nor orphans it — switch away, switch back, and the run is still streaming into its tile with no gap in the log.

> **Done, and the step turned out to be mostly about what *not* to build.** `switchTo` and a `project` reset action; an epoch guard in `useDesk`'s resync; `switch.test.ts` (6 tests) and four reducer tests. 589 tests pass, up from 580.
>
> **A switch is not a stop, and the daemon needed no changes to make that true.** A project's queue, run store and event bus live on its runtime, not on anybody's socket — dropping a connection unsubscribes a listener and nothing else. Step 32's retrospective argued exactly this from the design and said plainly that an argument is not evidence. It is evidence now: a long run in A, A's socket dropped, a client attached to B, and A's run still `running` with its events still reaching its store while nobody watches; B's socket sees none of it; reattaching to A replays the backlog in order and the run streams on.
>
> **"No gap in the log" is two claims, and only one of them is the socket's.** The bus replay is a bounded ring, so a run noisier than `replayLimit` genuinely *does* gap on reattach — a test sets the limit to 3 and asserts the dropped head, rather than pretending otherwise. What closes the gap is the resync's `GET /runs/:id`, because the store is authoritative and the bus is a convenience. Both halves are asserted separately so neither is taken on trust from the other.
>
> **The one real bug switching introduced was in the client, and it was a race.** `resync` is several awaits long and nothing could cancel it. Switch from A to B while A's fetches are in flight and A's resync would settle *after* B's had started: `snapshot` replaces the run list wholesale, so the Desk would land on B showing **A's runs**, then clear `resyncing` and flush the buffer array it had captured — discarding B's live events into a buffer nobody would read. Every resync now takes an epoch token and checks it before each group of dispatches, and the socket effect bumps the epoch on teardown so the invalidation happens at the moment of the switch rather than whenever the next resync starts.
>
> **The reset belongs in the reducer, not the hook.** `snapshot` already rebuilds tiles and filters standbys — but only when the fetch lands, and until then every field still describes the project you left, under the new project's name. Clearing on the way in rather than correcting on the way out means the wrong thing is never rendered at all. `standbys` is the one that would do damage rather than merely mislead: a standby id is addressable daemon-wide, so answering a carried-over one from the new project's Desk would *succeed*, against a run in the old project. It is a pure action with four tests and no DOM, which is the discipline `App.tsx`'s own header comment asks for.
>
> **One hazard checked and found not to exist.** Run ids are minted by a single process-wide factory whose counter is shared by every store, so two projects cannot mint the same id and a stale `known` entry can never match across a switch. The caches are cleared on switch as hygiene, and the comment says which of those two things it is — a defence against a collision that cannot happen would have been worth deleting later.
>
> **Switching reuses `POST /projects` rather than adding a route**, because `registry.open` is idempotent by resolved root and recording recency is exactly what it does. That is what makes "reopen the project you were last in" survive a restart with no second source of truth: a test switches, restarts the daemon, and it comes back up on the project switched to. `defaultProject` is unchanged and still fixed at boot — it does not follow a switch, and a test says so, because the daemon having an opinion about the current project is what Phase 8 decided against.
>
> **What is deliberately not built here, and would have been thrown away.** The switcher is a `<select>` in the topbar, shown only when there is more than one project, with missing folders rendered and disabled rather than hidden. Step 40 owns recents, the missing-folder state and the real launch surface; Step 41 owns making the switch one keyboard-reachable action and putting the active project in the window title and tray.
>
> **The honest limit of the evidence.** The repo has no DOM or browser test infrastructure — by convention the logic lives in the reducer and is tested pure, and `.tsx` files are not collected at all. So the daemon behaviour and the reducer reset are proven by test; the `<select>` itself is covered by typecheck and build only. That is the same split every UI step in this plan has had, and Step 41 is where the switcher gets a surface worth exercising directly.
>
> **On Phase 8's remaining open question — "what a project *is*, exactly."** A switcher showing `project.root` while a Station's `workspace` points somewhere else makes the divergence visible for the first time, which is what the question anticipated. It does not settle it: the topbar shows one name and one root, and nothing yet tells you that a tile is working outside it. That is a thing for the project view to say, not for a `<select>`, so the question stays open and moves to Phase 11 rather than being closed here by a control that merely failed to raise it.

### Open questions to settle in the work, not now

- ~~**Where a project's config lives.**~~ **Settled in Step 31: either, and the repo wins when present.** A `cuesheet.toml` at the project root commits with the code and is what a team sharing a set of Stations wants, so it is preferred whenever it exists; `~/.cuesheet/projects/<id>/cuesheet.toml` is the fallback, which keeps the promise that using Cuesheet on someone else's repository leaves no trace in it. The ordering is deliberately the one `loadConfig` already applies — nearest-to-the-work first, then the home directory — so Step 32 replaces that function's candidates without inverting its semantics. `projectConfigFile()` exists; the loader does not use it yet.
- ~~**What a project *is*, exactly.**~~ **Settled in Step 42: a folder, plus Stations that may legitimately point outside it — and the UI now shows which it is describing.** The project view carries the project root in its header and each Station's own workspace in its permissions, so a Station working outside the project reads as the divergence it is. Step 34 anticipated this exactly: a switcher could raise the question and not answer it, because one name in a topbar cannot say that a tile is working somewhere else.

---

# Phase 9 · Local models — `ollama`

> 🔵 **Beta track.** Small, and deliberately placed before Limits: it is what makes Phase 10's hardest case real instead of hypothetical.

### The Deferred table was wrong about this one, and the correction is most of the phase

It read: *"Not blocked by anything but a missing install — which is what the `codex` blocker turned out to be too, so check before believing it."* The check was worth making, and the answer is no.

`claude-code` and `codex` are agent loops: they plan, run shell commands, apply patches, and emit a structured event stream to map. **Ollama is a completion endpoint.** No loop, no patch application, no event taxonomy, and no `--sandbox` to hand a role to. Sizing it like the `codex` install would have been Phase 7's error run backwards — the lesson there was *check which kind of blocker this is*, not *assume every blocker is environmental*.

So the honest small version is the one the README already specifies, and this phase adopts it rather than inventing one: **`ollama` is `worker`-only.** The supported-harnesses table already reads `local / worker / 📋 Planned`, and the roles table already says a `worker` "cannot review; cannot write code."

**That is a feature rather than a shortfall.** A harness that never writes to a workspace has no partial-leash story to document, because it has no write path at all — the thing that made `codex`'s leash structurally weaker than `claude-code`'s does not arise. And the README's own argument for the role is a safety argument: *"a small local model is not a reviewer. A 7–30B model reviewing a frontier model's output approves nearly everything, which is worse than no review because it manufactures confidence."* Shipping with `roles: ["worker"]` makes that structural instead of advisory.

### Step 35 — The harness ✅

> **The skip expired, on 2026-09-16, exactly the way its own note said it would.** That note read: *"it is the environment kind of blocker, which the Status section warns expires silently. An `ollama` on the PATH and a model pulled is the whole of it."* A Windows machine with Ollama 0.32.9 on it and one `ollama pull qwen3:0.6b` was the whole of it. The step body below was not revised before the work — it was correct as written, and the two interface firsts it predicted are both real.
>
> Kept rather than deleted because a skip that turns out to have been right about its own expiry is the evidence for writing the next one that way.


`packages/harness/src/ollama.ts`. `vendor: "ollama"`, `roles: ["worker"]`, `contextFiles: []` — Ollama keeps no context file of its own, which is precisely the hole Phase 12 exists to fill, and the README already names it: *"Claude Code keeps `CLAUDE.md`, Codex keeps `AGENTS.md`, Ollama keeps nothing."*

Two things make this the first harness of its shape, and both are interface questions rather than implementation ones:

- **`probe()` asks whether a server is reachable, not whether a binary is on `PATH`.** Every existing probe shells out to a CLI. This one makes an HTTP request to `http://127.0.0.1:11434`, and has to distinguish *installed but not running* from *not installed* — a state no other harness can be in.
- **The model list is dynamic.** `/api/tags` returns what is actually pulled on the machine. Every other harness takes its model from static config, so this is the first where the Desk can offer a real list, and the first whose list can go stale between one probe and the next.

Written against a **captured** stream like the other two: `/api/chat` with `"stream": true` emits NDJSON, and the rule from Phase 7 holds without exception.

**Done when:** with Ollama running, the harness appears in `/stations` with the models actually pulled on that machine ✅; with Ollama stopped, it reports not-running without failing the request or hanging it ✅.

Both proven against a live daemon on Windows rather than against the fakes. Running: `{"installed":true,"authed":true,"version":"0.32.9","binPath":"http://127.0.0.1:11434","models":["qwen3:0.6b"],"harness":"ollama"}`. Stopped — the app killed, not just the port blocked — `GET /projects/:id/stations` answered **200 in 244 ms** with `installed: true, authed: false` and *"Ollama is installed but nothing is listening … start it with `ollama serve`"*.

#### What the work settled

**The probe has three states, and the middle one is the whole reason it is its own function.** Every other harness has two — the binary is there or it is not. Ollama adds *installed, on the PATH, nothing listening*, which is the ordinary state of a machine that just booted. Collapsing it into "not installed" tells an operator to download something they already have. The server is asked **first** and the binary only when it does not answer, because a remote `OLLAMA_HOST` is supported and there is no binary on this machine in that case.

**`HarnessProbe.models` was added to core, and `undefined` versus `[]` carries the design** — the same distinction Step 36 drew for `HarnessRoles`, arrived at independently for the same reason. Absent means "nobody asked, or I could not"; `[]` is the real answer *"a server is running and nothing is pulled"*, which a Desk has to be able to say rather than falling back to a free-text box. It is a hint for a picker and never a check: an `ollama rm` while the Desk is open is enough to stale it.

**`roles: ["worker"]` is enforced in `run()`, not only declared.** A `reviewer` seat is refused *before the request is made* — no tokens, no answer, nothing to mistake for a review. Step 36 put the same claim in the daemon as a `/stations` warning, and the two are not redundant: the warning is what an operator sees while writing config, and this is what happens to the operator who did not read it. Registering `ollama` also made that Step 36 warning fire against a **shipped** harness for the first time; until now no built-in had a role list narrow enough to trip it.

**`usd: 0`, and it is the one harness where a zero is a fact rather than a guess.** `meter.ts` already says an absent price "means the harness could not price it, which is not the same claim as 'it cost nothing'" — `codex` leaves it absent for exactly that reason. Local inference has no marginal price, so the strong claim is the honest one, and a ledger showing a local worker as "cost unknown" would understate what it knows. `mock` was the only harness that could produce the `unmetered` usage row; that row now has a real model behind it.

**`think: false` was captured working and is deliberately not sent.** It suppresses the scratchpad at the source, and `qwen3:0.6b` honours it — the second fixture is that capture, and it collapses the stream from 142 frames to **two**. But it was only verified against a thinking-capable model, and no non-thinking model was on the machine to see what one does with the flag. Sending an unverified flag to every model is precisely what `codex.ts`'s *read the help, do not recall it* rule exists to prevent. So `thinking` is dropped in the mapper instead, the way `codex` drops `reasoning`, and its tokens are still counted: `eval_count` was 146 against 32 characters of content.

**Keeping both captures is what made the mapper correct.** One fixture alone would have taught it that a frame is a token. Two — 142 frames and 2 frames, same endpoint, same model — make "a frame is a fragment, never a line" a fact rather than a style choice, and a test asserts the mapper adds no newline of its own.

#### Two defects the first real run found, which no fake would have

Both were invisible until a real local worker ran through the real daemon, and both are fixed with tests that fail without the fix.

- **The run record attributed a diff to a harness with no write path.** `runDiff` always preferred a fresh `git diff` over the workspace, and a `git diff` reports what is *dirty*, not what this run did. Those are the same answer only because a run that writes is the normal case — and a worker-only run is the case where they come apart. The first `ollama` run landed `filesChanged: 2` against a workspace two earlier runs had left dirty. Both `mock`'s worker branch and `ollama` already declined to return a diff; that was not enough, because their restraint only reached `lastResult`, the branch a fresh `git diff` wins. **The check belongs where the attribution is made**, so `runDiff` now returns nothing when *every* Station in the run is a non-writing seat — every, not the last, because the README's own `ship` cuesheet ends in a commit-message worker and must not erase the engineer's diff on its way out. It defers to core's `writeDeniedByRole` rather than restating who may write; the reviewer half of that question is still the open finding recorded under Step 36.
- **The cost went on the wire twice.** The mapper emitted a `cost` event *and* `settle()` recorded through the meter, which emits its own — two identical events a millisecond apart. The totals were never wrong, since `reconcileCost` prefers a harness's returned total over the summed stream, but a Desk drawing the stream would render a free harness as costing double. `codex` pushes events and never touches the meter; `mock` uses the meter. **Both are valid; doing both is not**, which is what happens when half of one pattern gets copied. The test that catches it needed the *real* meter in the fake `RunContext` — a stub that only accumulated let the bug through the one test written to find it.

#### A smaller thing worth writing down

The test suite's first attempt injected `env: {}` to isolate the PATH, and passed on a machine with no Ollama while proving nothing on this one: `which`'s `path` option falls back to the real environment when it is `undefined`. The seam had to be the **whole lookup**, not the variable it reads. Two probe tests were green for the wrong reason before that was found.

### Step 36 — The worker seat means something ✅

A `worker` cue: classify, summarize, write a commit message, dedupe a memory. No workspace writes. And the warning the README promises out loud — a `worker`-class harness dropped into a `reviewer` seat is a config error the daemon names at `GET /stations`, not a surprise three steps into a run.

**Done when:** that config produces a warning rather than a plausible-looking approval ✅, and a `worker` cue completes having touched zero files ✅.

#### What the work settled

**Built without `ollama`, which turned out to be the right order rather than a workaround.** The seat is a property of the *daemon*, not of any harness — `mock` already declared `roles: ["worker"]` and had no worker branch, which is precisely the gap this step existed to close. Building it against a real local model would have proved the same two clauses while hiding which layer was enforcing them.

**Three places enforce it, and they are not redundant — they are three different strengths, in descending order:**

| Where | What it does | Strength |
|---|---|---|
| `codex --sandbox read-only` | The CLI refuses the write | **Prevention**, and complete — the shell-command hole documented in `codex.ts` is a hole in path *observation*, not in the sandbox, so `printf > file` is refused too |
| `Workspace.write` (`workspace.ts`) | The facade refuses | **Prevention**, for harnesses that do their own I/O — which is `mock` today and every in-process harness later |
| `fileEvents` / `fileChangeEvents` | A `denial` event on the run record | **Report**, after the fact. It is what covers `claude-code`, and it is honest about being a report |

`claude-code`'s `buildArgs` was deliberately **not** touched. No read-only `--permission-mode` has been verified against a real `--help` on this machine, and the rule that produced `codex.ts`'s flag comment — *read the help, do not recall it* — applies to permission modes as much as to stream shapes. So a worker on `claude-code` is covered by the facade and by observation, and the comment at the check says exactly that rather than implying more.

**The warning lives in the daemon, not in `config.ts`'s `lint()`, and the dependency direction is why.** Every other cross-field warning is in the loader, which made that the obvious home — until the check turned out to need a harness's `roles`, and `core` sits *below* `harness`. The loader knows what you wrote; only the daemon knows what the harnesses can do. So `describeStations` takes a `HarnessRoles` lookup alongside its prober, `harnessRuntime()` supplies it from the registry, and `stations.ts` still does not know what a registry is.

**`HarnessRoles` is a second function rather than a field on `HarnessProbe`**, because the two answer different questions. A probe is liveness; roles are static capability. Folding them together would make a harness's roles unknown exactly when its binary is missing — and the warning earns its keep *before* you install anything, while the config is still being written.

**`undefined` and `[]` mean different things, and the distinction carries the whole design.** An unregistered harness answers `undefined` and warns about nothing. `[]` would mean "plays no seat" and would warn about every Station in every config the moment no registry was wired — including `startDaemon`'s own tests, and including the `ollama` entry `BUILTIN_HARNESS_IDS` lists but no build ships. Third-party harnesses are a supported case; a config that cannot be opened without the plugin declaring its roles would make the README's "most valuable contribution" hostile to write.

#### A finding this step deliberately did not act on

**`writeDeniedByRole` names only `worker`, and `sandboxFor` already denies more than that.** A `reviewer` and a `caller` both run `read-only` under Codex's sandbox, so the CLI-flag layer encodes "engineer is the only writing seat" while the facade encodes "worker cannot write". Those two rules disagree, and the facade is the weaker one.

It was left disagreeing on purpose. Widening the facade changes the Phase 7 gate path, and **no test covers a reviewer writing in either direction** — every writing test in the repo uses `engineer`, which means nothing would have caught a regression and nothing would have proven the change correct either. That is a decision to make with a reason, not as a tidy-up inside a step about a different seat. It belongs to whoever writes the reviewer's read-only clone.

---

# Phase 10 · Limits

> 🔵 **Beta track.** Not a polish item. Users hit caps in week one, and a gated two-model workflow burns roughly 3× a single session — which this phase is what makes visible *before* the invoice rather than after.

`usage()` has been on the `Harness` interface since Step 13, returning `[]` from every harness. This phase is the wiring that milestone was shaped for, and Phase 8 gives it the surface the user actually asked for: limits shown per project, next to the roles that are spending them.

### Step 37 — Usage on the wire ✅

Move `UsageWindow` from `@cuesheet/harness` into `@cuesheet/core` — the type carries a comment saying it moves when M2 puts it on the wire, and this is that. Poll, cache, serve.

The type needs one addition before anything renders it, and Phase 9 is what forces it: a window must be able to say **unmetered** as distinct from **unknown**. A local model has no cap; Codex reports nothing. Collapsing those two into a blank cell tells the operator the same thing about a station that cannot run out and a station that might already have.

**Done when:** `GET /usage` answers with every harness's windows ✅, never blocks on a hung CLI ✅, and distinguishes measured, not-yet-blocked, unmetered and unknown as four different answers ✅.

#### What the work settled

**`UsageWindow` became a union, and that is the whole step.** The addition the plan asked for was one more state; what the three findings actually demanded was that `used` stop existing on the variants that never measured anything:

```ts
| { window; state: "measured";    used: number; resetsAt?; seenAt? }
| { window; state: "not-blocked";               resetsAt?; seenAt? }
| { window; state: "unmetered" }
| { window; state: "unknown";     reason? }
```

The strip cannot draw a fabricated percentage because on three of the four variants **there is no field to read**. A `state` discriminant beside an optional `used` would have been the same information and none of the protection: two sources of truth is how the convincing 0% comes back, and this phase's own prose says drawing one is the failure worth avoiding.

**`usage()` answers for `claude-code` now, and it needed no interface change.** The Deferred table predicted that — *"`usage()` already on the interface"* — and it was right for a reason that only became clear here: **there is nothing to poll.** The CLI reports limits as `rate_limit_event` lines *inside* a run and offers no queryable command, so the harness cannot go and look. It remembers what its last run overheard, on the harness instance, and `usage()` returns that. The daemon polls; the harness answers from memory; the interface never moved.

**Which is why `seenAt` is on the window and is load-bearing rather than diagnostic.** Every answer `claude-code` gives is historical. A five-hour window observed forty minutes ago is not a current fact, and a strip that renders it as one is the authoritative-looking screen this phase exists to prevent. It sits on the two observed variants only — `unmetered` carries no time because it is not an observation. A local model has no cap whether or not anyone looked.

**`mapRateLimit` was reading three of six fields.** The captured line carries `status`, `resetsAt`, `rateLimitType`, `overageStatus`, `overageResetsAt` and `isUsingOverage`; the original mapper read the first three and dropped the rest. Overage is a *second* limit with its own clock — the one that decides whether hitting the first costs money or stops you — so one event now yields up to two windows. Dropping it would have been the same lossiness Phase 14 criticises in `Cost`, in a neighbouring file.

**`[]` and "no limits" are different claims, and the daemon is where they separate.** A harness returns `[]` when it has nothing to say — `codex` permanently, `claude-code` until a run has happened — and the cache turns that into an explicit `unknown` row with a reason. Keeping the conversion in the daemon rather than in the harnesses left the `Harness` contract untouched, which is what let `codex.test.ts`'s existing `usage()` assertion keep passing unedited.

**A missing row and a row reading "unknown" must not collapse**, so a hung CLI produces the second, never the first. A harness that vanishes from the response reads as "not installed", which is a different claim from "did not answer". The timeout is therefore an answer with a reason attached, and the read is memoized per harness while in flight — the same rule the project runtimes keep, and the same bug if it is skipped: two concurrent pollers on a cold Desk otherwise spawn the same CLI twice.

**`GET /usage` is global.** Step 38 renders the strip *inside* a project, which makes this look like it should have been `/projects/:id/usage`. A plan window belongs to a vendor, not to a repository — it is the same five-hour window whichever checkout you are standing in, and a per-project copy invites a client to add four of them up. Which project is spending it is the strip's question, not the route's.

**`mock` now reports `unmetered`, truthfully.** It is code in this process, it costs nothing and it cannot run out — and with Step 35 skipped it is the only shipped harness that can exercise the limits strip's hardest row at all. Step 38 can therefore be built against a real fourth answer rather than an imagined one.

**Only `allowed` is mapped, because only `allowed` has ever been captured.** The first draft mapped every other status to `{ state: "measured", used: 1 }` on the reasoning that "not allowed" means the cap is reached. That is a full bar drawn from a string nobody has seen — and if the CLI ever emits a `warning` or an `approaching_limit`, it is this step's own failure mode aimed the other way. An unrecognised status becomes `unknown` carrying the raw string. The rule that produced this repo's flag comments turns out to govern status vocabularies too: read it in a capture, do not recall it.

**The cache is invalidated by a finished run, not only by its TTL.** A run completing is the one moment plan usage moves, because `claude-code` learns its limits only from inside one. Without that hook the strip would serve the window from *before* the run that spent it, for up to a full TTL, at exactly the moment somebody looks. The daemon attaches to its own global bus for it — deliberately global rather than per project, since a run in any project spends the same plan.

### Step 38 — The strip, and the pre-run check ✅

Render every vendor's windows on one strip. `warn_at`, `block_at`. Refuse to *start* a run that cannot finish.

The README's own framing is the acceptance criterion: every vendor meters differently and none of them tell you where you stand until you hit the wall, *"usually eleven minutes into something that mattered."*

**Done when:** a Station near its cap is visibly near it ✅, and a run that cannot finish is refused with a reason rather than dying halfway ✅.

#### What the work settled

**`[limits]` stopped being deferred**, which is the quiet half of the step and the one that touched the most tests. It had sat in `DEFERRED_TABLES` since Step 6, and four existing assertions were pinning *that* — two of which had already been migrated once when Gates shipped. They now assert on `[remote]`, and the test comment says the table under test keeps moving, because it will. `when_capped` parses and nothing reads it: Step 39's job, the same standing `merges` has on a Gate.

A transposed `warn_at`/`block_at` pair is a **warning, not a parse error**. `lint()` exists precisely so a half-written config still opens the app, and refusing to start the Desk over two swapped numbers is a worse outcome than saying so on screen.

**Only a measured window can refuse a run, and that is the point rather than a gap.** `not-blocked` means the vendor has not cut you off *yet* and says nothing about how close you are. `unknown` means nobody said. `unmetered` means there is no cap. Refusing on any of those three would be inventing a measurement — the same failure Step 37's union prevents, aimed at the operator's ability to work instead of at their bill.

**Which made `isUsingOverage` matter far out of proportion to its size.** Without it the block path would have been provable only against a test double, because no shipped harness produces a `measured` window: Step 37 deliberately maps unrecognised statuses to `unknown`, `codex` reports nothing and `mock` is unmetered. `isUsingOverage` is the one field in the captured line that is **not** a status vocabulary — it is a boolean whose meaning is definitional rather than interpreted, since overage *begins* where the plan allowance ends. A runtime reporting it is in overage has reported the plan window spent. That is `used: 1` as a fact, and it is the only route by which a real vendor reaches the refusal.

**The check is scoped to the harnesses the run will actually touch.** A run that only uses `claude-code` is not refused because a Codex Station elsewhere in the config is capped; it would never have reached it. A Station naming an unconfigured harness is deliberately *not* filtered out — the run fails on it either way, and dropping it would mean a capped harness silently stopped counting.

**409, with the windows attached rather than only a sentence.** The Desk has to be able to say which vendor stopped the run and how long until it resets. A warned run still starts, and its findings ride along on the 202 rather than becoming a second request.

**The strip's decisions are in `ui/src/limits.ts`, not in the component**, and the reason is specific to this repo: vitest collects colocated `.test.ts` only and **does not collect `.tsx`**, so a rule living in a component is a rule no test here can reach. `describeWindow` returns `bar: number | null`, and the component cannot draw a track when it is `null` — which is the union's guarantee surviving all the way to the DOM. The `?? 0` that would have made a progress element happy is the exact lie the phase is about.

**A row with no measurement carries its sentence where the bar would go.** An empty track reads as "0% of a real cap", which is precisely the claim a vendor reporting a status has not made. So `not-blocked` renders *"Not blocked yet — this vendor reports a status, not a number"*, `unmetered` renders `∞`, and `unknown` renders the reason the daemon gave.

**Freshness is rendered, not just stored.** Step 37 put `seenAt` on the observed variants; this is where it becomes visible. Past a minute old, the row says how old — a five-hour window from this morning shown without its age is worse than a blank row, because it looks current.

**The strip groups by vendor, and the state survives a project switch.** Two Stations on one CLI share one window; drawing it per harness would read as twice the budget. And `usage` is the single field `case "project"` does not clear, for the same reason `GET /usage` is not a project route: a plan belongs to a vendor, so it is the one thing on the Desk still true about the project being arrived at.

#### What an operator actually sees today, stated plainly

**No bars.** With the shipped harnesses and a plan in good standing, every row is a sentence: `claude-code` says "not blocked yet", `codex` says it reports no plan windows, `mock` says it cannot run out. A test asserts exactly that — `every(w => w.bar === null)` — because it is the honest strip, not a broken one, and the next person to look at it should not "fix" it into a row of zeroes.

### Step 39 — The ledger and fallback routing ✅

Tokens and dollars per Run, per Station, per vendor, per day. `when_capped` moves steps to another Station instead of stopping.

**Done when:** the cost of the Phase 7 gate run is a row in a chart ✅, and a capped Station routes to its fallback without the operator watching ✅.

#### What the work settled

**Step 57 was pulled forward, as this plan said to pull it.** `Cost` gained `cacheRead` and `cacheWrite`, and the reason is the sentence already written under Phase 14: a ledger that reports `tokensIn` without saying how much of it was cache can tell you what a run cost and never why. Both harnesses were already *receiving* the numbers and throwing them away — `claude-code` summed the two cache fields into the total, `codex` discarded `cached_input_tokens` as the subset it is.

**They are a breakdown, not addends, and three places had to learn that separately.** `createMeter` accumulated three fields and would have dropped the new ones on the floor while still returning a valid `Cost` — the failure where the type lands and the data never arrives. `addCost` sums them the way it sums input. And `reconcileCost` decides between a harness's reported total and the metered stream on a truthiness test: without the cache fields in that predicate, a harness reporting *only* a cache read — every input token served warm, no fresh tokens, no price — would read as "reported nothing" and be silently replaced by the stream. That is the double-billing direction the project's additive-versus-inclusive rule exists to catch, arriving through a type change rather than through a mapper.

**Absent is not zero, everywhere.** A harness that does not break input down has not said its hit rate was zero. `codex` ships `cacheRead` and omits `cacheWrite`, because its stream reports one and not the other; claiming a zero would assert it never writes a cache, which no capture supports. The ledger carries that through: `cacheHitRate` returns `null`, and the table renders `—`.

**Per-Station cost is recorded at run time, not derived from the event stream.** The executor already knew the station, the harness, the vendor and the meter's total at the moment each step ended; writing four fields there is free. Deriving it later would mean opening every run's `events.jsonl` to draw one table — the cost that keeping `list()` answering off `readdir` was designed to avoid, and the same complaint `reconcileInterruptedRuns` already carries about itself.

**Runs recorded before that field are first-class, not an edge case.** They appear in the day and run totals with their spend reported as `unattributed`, rather than being dropped or silently blamed on their first Station. It matters more than it sounds: **the Phase 7 gate run the done-when names is exactly one of those.** It was recorded months before `stations` existed, so the honest way it becomes "a row" is the unattributed path — which is now tested, surfaced on the wire, and printed under the table whenever it is non-zero. `byStation` not adding up to the total is the one discrepancy a reader would spot unaided, and an unexplained one costs the page its credibility.

#### The two steps that disagreed, and the order that fixed it

**Step 38 refused every run Step 39 existed to rescue.** A capped harness is precisely the case `when_capped` routes around — and the pre-run check, asked about the cuesheet *as written*, saw the cap and returned 409 before the router ever ran. The first end-to-end fallback test failed on exactly this, which is the useful kind of failure.

The fix is an ordering rule worth stating: **route first, then check.** The question the pre-run check asks is "can this run finish *as it will actually execute*", so substitutions are resolved before anybody's cap is counted. The executor resolves them again at run time, and that is not redundancy — a cuesheet can take twenty minutes, and a cap reached during it should route the step that has not started yet.

A refused *routing* then feeds the refused *run*: the 409 carries the reason the fallback could not save it, alongside the window that stopped it. "You are capped" while `when_capped` sits configured and silent is the message somebody spends an afternoon on.

#### `when_capped` refuses more than it accepts, on purpose

A substitution changes **who did the work**, and both things Cuesheet enforces structurally are stated in terms of who did it. So `chooseFallback` refuses unless the stand-in holds the *same role* and its harness declares that role. Step 36 made "a worker in a reviewer seat" a warning the daemon prints at a human; a router performing that swap unprompted at runtime would be doing silently what the linter exists to warn about — and the README's argument is a safety one, not an ergonomic one.

**A Gate's `distinct_vendors` needs no check here, and that is worth knowing before somebody adds one.** `evaluateGate` counts vendors over `participants`, which the executor builds from the harness that *actually ran*. Swap a second-vendor reviewer for a same-vendor one and the gate sees one vendor and holds the run — honestly, with its own message. A pre-emptive check in the router would duplicate that logic in a second place, and the two would drift.

Every substitution is on the record: `StationCost.substitutedFor` names the Station whose step was taken. A ledger showing `spare` where the cuesheet says `primary`, with no explanation, is a ledger somebody files a bug about.

#### "A row in a chart" was read as a row, rendered

There is no charting anything in this Desk, Phase 11 rebuilds it, and adding a visualization library to draw three bars would be the expensive kind of scope. What the clause asks for is that the money be **visible and attributable**, and the Desk now has a ledger panel — by day, by vendor, by Station, with a cached column and the unattributed note. Its decisions live in `ui/src/ledger.ts` for the same reason the strip's do: vitest does not collect `.tsx`. Drawing it as a chart belongs to Phase 11, with the rest of the design system.

**`GET /projects/:id/ledger` is per project, and it is the mirror of `/usage` being global.** A plan window belongs to a vendor — the same five-hour cap whichever repository you are standing in. Spend belongs to the work that caused it, and the run store is already per project. There is no `limit` parameter: a ledger over the most recent N runs is a ledger that quietly disagrees with itself as the window slides, so the date range is the honest way to ask for less and Step 52's SQLite store is the honest way to make asking for all of it cheap.

### What the earlier phases already learned about this one

Three findings land squarely here, and together they are why this is harder than "read a number and draw a bar":

- **Claude Code reports plan limits, but only from *inside* a run** — as `rate_limit_event` lines, not as a queryable command. `mapRateLimit()` already turns one into a `UsageWindow`. It also reports a *status* rather than a fraction, so `used` is a floor (`allowed` → 0) and not a real percentage. **The strip will have to render "not yet blocked" honestly instead of drawing a convincing 0%.**
- **Codex reports no plan window at all**, and no dollar figure either — its stream carries token counts and nothing else. So `usage()` returns `[]` truthfully, and a two-vendor run's dollar total is currently the Anthropic half only. Finding OpenAI's numbers is its own piece of work; until then the honest strip has a blank row rather than a reassuring one.
- **Ollama is unmetered and free**, which sounds like the easy row and is the one that breaks a naive design: a bar chart of "usage" cannot draw it at all, and a percentage would be a lie in the opposite direction from Codex's.
- **`Cost` cannot express a cache hit, and both vendors are already telling us about one.** `core/types.ts` defines `Cost` as `{ tokensIn, tokensOut, usd? }` and that is the whole vocabulary. `claude-code.ts`'s `inputTokens()` *sums* `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` into `tokensIn`, and `codex.ts` reads `input_tokens` and discards `cached_input_tokens` as the subset it is. Both are correct as totals and both are lossy: cached input is billed at a fraction of fresh input, so two runs with identical `tokensIn` can differ severalfold in price, and the ledger of Step 39 has no field in which to say which one you just paid for. **This is the one place the limits work needs a `core` type change rather than a harness change** — see Step 57, which is where it is done, because widening `Cost` before anything reads the extra fields buys nothing.

**Which means the first real decision of this phase is a presentation problem, not a parsing one:** what a limits strip shows when one vendor reports a status, another reports nothing, and a third cannot run out. Getting that wrong produces a strip that is worse than no strip, because it looks authoritative.

---

# Phase 11 · The Desk, rebuilt

> 🔵 **Beta track.** The current Desk was built in Phase 4 to prove a daemon could stream a run into a browser. It did that. It was never designed to be opened every day.

The honest case for a rebuild rather than an extension is structural, not aesthetic: **the current UI has no level above the run.** `App.tsx` reads one `state.stations` payload and renders one grid; there is no project, no switcher, no place for a limits strip that belongs to a vendor rather than a tile, and no first-run state other than an empty grid and a palette hint. Every one of those is a top-level shape, and retrofitting four of them into a component that was written as a single screen produces something worse than either.

**What survives, because it is tested logic and not layout:** the reducer and its tests, `format.ts`, the WebSocket client and reconnect handling, the command palette's chord matching, and the add-a-Station flow's TOML writing. This is a re-shell, not a rewrite of the client. `App.tsx` was written with a comment saying that anything here which starts deciding things belongs in the reducer or in `format.ts`; that discipline is what makes this affordable.

### Step 40 — The launch surface ✅

What the app opens on when no project is active: recents, with last-opened and a live "is this folder still there" state, plus **Open a folder…** — which already exists as `window.cuesheet.chooseDirectory()`, built in Phase 5 for the add-a-Station panel and reusable here as-is.

**Done when:** a first-ever launch and a launch with six known projects both look deliberate ✅, and a folder that has been moved says so rather than failing on open ✅.

#### The step turned out to be entirely client-side, and that is the good news

Every piece of daemon surface this needed already existed: `GET /projects` returns `ListedProject[]` carrying `status: "ok" | "missing"`, sorted newest-opened first; `DELETE /projects/:id` forgets an entry without touching the folder; and `POST /projects` already answers 400 with the registry's own message, which names the path. Phase 8 cut those seams without knowing what would sit on them. Two of them had no test, and now do.

**The missing-folder clause has two halves and only one was built.** `switchTo` already opened before switching, so a folder that vanished left the Desk where it was — tested since Step 34. What was absent is the *first* half: a `missing` recent presenting itself as an ordinary click target. It is now dimmed, inert, and carries its reason, because the daemon already knows the answer and making somebody discover it by pressing is a worse version of telling them.

**There is deliberately no "moved" wording**, matching the note on `ProjectStatus` in core: without tracking inodes across platforms, a renamed folder and a deleted one are indistinguishable, and a surface claiming to tell them apart would be guessing at the user. A test asserts the string never says moved, renamed or deleted.

**`forget` is in scope even though the done-when does not name it.** An entry that can neither be opened nor removed is a dead end a stranger hits in their first minute, and the route already existed.

#### Running the app found a bug five green CI commands did not

**The Desk was rendering blank, and had been since Step 38.** `ui/src/limits.ts` and `ui/src/ledger.ts` import *values* — `measuredFraction`, `percent`, `cacheHitRate` — and took them from the `@cuesheet/core` barrel. That barrel re-exports `leash`, `config`, `project` and `migrate`, all of which reach `node:fs`. Vite externalizes those for the browser, the module throws on first access, and the entire app renders an empty body.

Nothing caught it. `npm run build` succeeded — Vite bundles it happily and the failure is at runtime. `npm run typecheck` succeeded — the types are real. `npm test` succeeded — vitest runs in node, where `node:fs` resolves fine. **The only thing that finds this is opening the page**, and two steps shipped over it.

The repo already had the answer and it was one file away: `reducer.ts` and `AddStationPanel.tsx` both import values from `@cuesheet/core/types`, a subpath. `core`'s export map now also publishes `./limits` and `./ledger` — both are pure arithmetic whose only imports are `import type`, so they carry nothing into a browser bundle. The rule, written at both call sites: **types from the barrel, values from a subpath.**

**And the strip was printing backticks.** `"\`claude-code\` reports no plan windows."` renders in the Desk as bare text, so the markdown punctuation arrived on screen as punctuation — the identical defect corrected for the seat warning in Step 36, in a place nothing caught until somebody looked. Fixed in `usage.ts` and `fallback.ts`, with an assertion in each suite that the string contains no backtick.

#### What was actually looked at

An isolated daemon on a scratch `homedir` — never the developer's real `~/.cuesheet/projects.json`, which the testing conventions warn is invisible locally and permanent — plus the Vite dev server and a headless browser:

- a first-ever launch with no projects,
- six registered projects with one folder deleted after registration,
- the Desk itself, confirming the blank page was gone and Step 38's strip renders its sentences honestly,
- and the launch surface at **380px**, which is the next point.

#### Phase 11's open question, answered here because this is the first surface drawn

**Responsive from the start, not a desktop screen with a phone rewrite behind it.** The phase asks this be settled "while the shell is being drawn, rather than discovering it at M3", and the launch list is the cheapest possible place to settle it. The cost is a `max-width` and a couple of `min()` calls per surface; the alternative is finding at M3 that every screen assumes a window. This is *not* a commitment to phone-specific surfaces — that is a separate and later question — only that nothing breaks at phone width. Verified at 380px with no horizontal scroll.

#### One gap this step does not close, named rather than left to be found

**With openable recents, the launch surface is currently unreachable.** The boot rule reopens the most recently opened project that still exists — Step 34's promise, and the README's — so the recents list appears only when *nothing* is openable. That is why the six-project screenshot above is six broken folders rather than five good ones and a bad one.

It is not a defect in this step and it is not fixed by widening it: what an operator needs is a way *back* to the launch surface from an open project, which is the switcher, which is **Step 41**. Recording it here so the next step inherits a known requirement rather than rediscovering it.

### Step 41 — The project shell and the switcher ✅

The frame every other surface lives in. Switching is one action, keyboard-reachable, and the constraint from Step 34 is the acceptance test rather than an aspiration.

**Done when:** switching is possible from anywhere including mid-run ✅, the window title and tray reflect the active project ✅, and a second project's runs are never visible from the first ✅.

> **Done.** `ProjectSwitcher.tsx` and `switcher.ts` in the UI, `project.ts` in the desktop shell, a `projectId` tag on the reducer's state, and `closeProject`. 724 tests pass, up from 698.

#### The third clause was a real bug, and it was one frame long

**The Desk did show one project's runs under another project's name, on every switch.** `switchTo` sets the new project on the client and React paints; the reset that clears the last project's runs, tiles and standbys is dispatched from the socket effect, which runs *after* that paint. So there was exactly one DOM state naming B over A's work. Step 34 built the reset and its four tests, and the ordering hole survived them because a reducer test cannot see a paint.

The fix is a `projectId` on `DeskState`, carried on the `project` action rather than set by a second dispatch — the reset and the new identity are one fact, and splitting them across two dispatches is how the window got there in the first place. `isShowing(state, activeId)` is then a question the surface asks before it draws anything project-shaped, and a question `reducer.test.ts` can put to the reducer directly. Two new reducer tests assert it, and the four existing `{ type: "project" }` call sites now carry an id rather than the field being optional — an optional one would have let the next caller reopen the hole.

**The evidence is a recording, not a screenshot.** A one-frame state cannot be photographed, so a `MutationObserver` recorded every DOM state a live switch passed through while a run streamed in the project being left. With the gate: 8 states, none naming the new project over the old one's run, and one state showing the gated "Opening api…" frame — proof the branch is reached rather than dead. With the gate temporarily removed as a counterfactual: the same 8 states — the gate adds none, it *replaces* one — and that one state names `api` while `add rate limiting` is still on screen. That is the bug, reproduced and then closed.

#### What the shell must not do while switching

**Gate the body, never the frame.** Blanking the whole Desk during the switch window would satisfy the third clause by breaking the first: no switcher, nothing to switch from. The topbar and the switcher render unconditionally — the recording confirms the switcher was present in every state, including the gated one — and the gated branch names the project it is opening rather than showing a spinner, because "which of the two things is happening" is the only question worth answering there.

The palette's `canStart` is gated too. A misleading render is bad; starting a run against the Stations of the project you just left would be worse, and it is the one thing on that screen that does more than mislead.

#### The `<select>` was a placeholder and this is why it could not stay

A native select cannot show a row's *reason*. Step 34 rendered a missing folder as an option reading `(missing)` with nowhere to say more, while Step 40's launch surface — same list, same registry answer — gave it a sentence. Two renders of one list with two different honesty levels is exactly the divergence that rots, so `describeSwitcher` is built **on** `describeRecents` rather than beside it, and the missing-folder rule has one implementation and one test asking it of both surfaces.

The first draft put the reason in the row's right-hand column, where a sentence crushed the path it was explaining down to three characters. It has its own line now. That was found by looking at it.

#### Step 40's named gap, closed

**With openable recents the launch surface was unreachable** — boot reopens the last project that still exists, so the list only appeared when nothing was openable. "All projects…" is the way back, in the menu and in the palette, and it is a client action in the same sense a switch is: the project stays open on the daemon, its runs keep running, and the registry is untouched, because closing is not forgetting. Verified live: leaving a project with a run in flight, the launch surface drew its three recents while `GET /runs` still reported that run `running`.

#### The window title and the tray

`window.cuesheet.setActiveProject` is the one message that travels renderer → main, and `parseActiveProject` is strict about it — wrong types, empty strings and a name carrying a newline all read as "nothing open", which is the state that is always safe to be wrong about because the next switch corrects it. A title bar is one line and a project folder can be named anything the filesystem allows.

**The active project is module-scope in `main.ts`, not a closure.** `refreshTrayMenu` rebuilds the menu from nothing every time it runs, including from the "Start at login" click handler — a project held anywhere narrower would have vanished from the tray the first time somebody toggled an unrelated checkbox. The title leads with the project (`api — Cuesheet`): window lists, dock previews and `⌘`-Tab cards all truncate from the end, and three windows on three projects would otherwise be three identical entries.

Verified against a running Electron shell over the main process's own inspector: `api — Cuesheet` → switch → `web — Cuesheet` → "All projects…" → `Cuesheet`. **The honest limit:** the tray's strings are unit-tested and set by the same function on the same value as the title, and the run's log confirms a tray was created rather than skipped for a missing icon — but the macOS menu bar itself was not photographed, because this machine denies screen capture to the session. The tooltip and menu label are believed on the title's evidence, not on their own.

#### Running the app found two things five green commands did not, again

Step 40 wrote the rule: the only thing that finds these is opening the page. Both of this step's were invisible to build, typecheck, lint, format and 724 tests.

**Focus opened the menu but could not use it.** `menu.querySelector("button")?.focus()` finds the first row — which is usually the project you are already on, which is disabled, and a disabled button cannot take focus. Focus stayed on the trigger, so the menu was keyboard-*openable* and not keyboard-*operable*. `button:not(:disabled)` fixes it, and the keyboard path now runs end to end: Tab to the trigger, Enter, focus lands on the first project you can actually switch to, Enter switches, Escape closes and returns focus to the trigger.

**Two overflows at 380px**, which is the width Step 40 settled the whole phase on. The menu hung off a trigger 105px from the left edge and ran 75px past the window; and `.topbar` — which predates this step — did not wrap, so the Desk itself scrolled sideways at phone width, something Step 40 checked on the launch surface only. The menu fix is `.switcher { position: static }` inside a `max-width` query, which makes the sticky topbar the positioning context so `top: 100%` still means "under the bar" with no magic number for a bar whose height changes when it wraps. Both were measured, fixed and re-measured: no horizontal scroll, menu inside the viewport with a 12px gutter.

#### What was actually looked at

An isolated daemon on a scratch `homedir` — the real `~/.cuesheet` was confirmed untouched afterwards — with three projects, one of whose folders was deleted after registration, a `mock` run held at a standby so it was genuinely mid-run, the Vite dev server, a headless browser driven over CDP, and the packaged-shape Electron shell with its main process under `--inspect`:

- switching from the menu, from the palette, and from the keyboard alone,
- switching **mid-run**, twice, with the run still `running` and still on screen after the round trip,
- the recording of every DOM state a switch passes through, with and without the gate,
- "All projects…" to the launch surface and back, with the left project's run still going,
- closing a project and reopening **the same one**, which is the path where `projectId` goes `web` → `null` → `web` and the socket has to be torn down and rebuilt rather than left attached: it comes back `daemon connected`, with its Stations and its run list, not stuck on `connecting…`,
- the window title following all three transitions,
- and the whole shell at 380px.

#### On Phase 8's open question — "what a project *is*, exactly"

Still open, and now visible in one more place: the switcher shows each project's `root`, and a Station whose `workspace` points outside it is still not distinguishable from one that does not. Step 42's job, as Step 34 said. The switcher makes the divergence easier to see and no easier to understand, which is the right amount for a menu to do.

### Step 42 — The project view ✅

The screen the request describes: for this project, its Stations — which harness, which model, which role — and its usage, on the same screen. Roles are the interesting part, because the README's claim is that they are enforced rather than requested, and the UI has never shown that. A `reviewer` that cannot write and a `worker` that cannot review should be legible as *constraints*, not as labels.

Depends on Phase 10 for the usage half and Phase 9 for the local row; built after both so it renders data rather than placeholders.

**Done when:** a project's whole posture — who is on it ✅, what each one is allowed to do ✅, what it has spent ✅, how close it is to a cap ✅ — is one screen with nothing on it that says "coming soon" ✅.

> **Done.** `core/roles.ts` (new, browser-safe), a `confinement()` declaration on the `Harness` interface, `StationEnforcement` on `GET /stations`, `ui/posture.ts` and `ProjectView.tsx`. 773 tests pass, up from 724.

#### "A reviewer cannot write" is true on Codex and false on Claude Code

This is the step's whole finding. Writing the screen meant deciding what sentence to put under a `reviewer`, and the honest answer turned out to be *it depends on the harness*:

- **The daemon** refuses a `worker`'s writes and nothing else's — `writeDeniedByRole`, enforced in-process, surfaced as a `denial` on the run.
- **Codex's own sandbox** runs a `reviewer`, a `caller` *and* a `worker` `read-only`. That is a wider rule than the daemon's, kept by a different process.
- **Claude Code** takes no role-based sandbox flag at all. `--permission-mode` is about prompting, not seats. A reviewer there is bounded by the leash and by nothing else.

So a Desk that printed "a reviewer cannot write" would be lying about one of two shipped harnesses. `leash.ts` has carried a note for two phases saying the asymmetry is deliberate — widening the facade to match Codex would change the Phase 7 gate path with no test covering it either way — and **this step did not unify them.** It made the disagreement visible instead: every line on the screen says *who* keeps the promise, because that is the thing that changes when somebody swaps the harness.

#### The claim had to travel from whoever can actually make it

Only the harness knows what flag its subprocess is launched with, and the Desk cannot import `@cuesheet/harness` without inverting the dependency arrow. So `Harness` gained an **optional** `confinement(role)`, `describeStations` assembles it with the daemon's own rule into `StationEnforcement`, and the Desk renders what it is told rather than inferring from the role.

**Absent is a fourth answer, and it is not `"none"`.** A third-party harness that declares nothing is *unknown*, and the screen says so — "does not say what it does with a reviewer" — rather than reporting it as unconfined. Writing a harness is the contribution this project most wants; guessing on a stranger's behalf would make the guess load-bearing. Codex declares its mapping *from* `sandboxFor` rather than restating it, so the flag the CLI gets and the sentence the Desk prints cannot drift; a contract test asserts both, and that every shipped harness declares something.

#### The move that had to happen first

`writeDeniedByRole` lived in `leash.ts`, which imports `node:fs/promises`. The project view needs it as a **value**, and Step 40's blank page is what a browser bundle does when it reaches a module that touches disk. So the role facts moved to `core/roles.ts` — no imports that reach a filesystem — published at `@cuesheet/core/roles` and re-exported from `leash.ts` so no caller changed. That is now the fourth subpath cut for this reason (`./types`, `./limits`, `./ledger`, `./roles`), and the rule Step 40 wrote is holding: **types from the barrel, values from a subpath.**

#### Putting a number on a second screen found a bug in the first

`ledger.totals.runs` was **always 0**. Every bucket — `byDay`, `byVendor`, `byStation` — counted through `bump`, which increments its own `runs`; the grand total went through `add`, which takes a `Cost` and has no notion of a run. Nothing caught it because nothing had ever drawn the two next to each other. The project view did, and read "$0.31 · 1 run" on the Station card above "Nothing spent yet" in the header.

Fixed with three tests, including the one that says a *remainder* is not another unattributed run — the run it belongs to is already counted in `byStation`, and counting it twice would make the columns describe different populations of the same runs. The ledger panel has been showing this zero since Step 39.

#### What the screen refuses to do

- **Never claim a refusal nobody keeps.** A test asserts no line under a `claude-code` reviewer matches "cannot write" or "writes are refused".
- **Never render an empty allow list as freedom.** `paths` absent means the leash defaults to deny, so such a Station can write *nothing* — and a screen listing its zero restrictions would say the exact opposite. It gets a refusal line.
- **Never contradict itself two lines apart.** A Station whose writes are refused is not also told it "may write src/**"; its allow globs are described as applying to reads.
- **Never say `$0.00` for a price nobody reported** — the same refusal the limits strip makes, and the reason a Station with unpriced runs shows a dash.

#### Two screens, not one longer one

The project view answers "what is this project's posture" and is read before work starts; the run surface answers "what is happening" and is read while it runs. A `project`/`runs` switch in the shell, in the palette as well, and deliberately not in a URL or in the daemon — which has no notion of what a client is looking at, the same decision Phase 8 made about the current project.

**The limits strip stays on the runs view and is not repeated here.** They answer different questions and group differently on purpose: the strip is per *vendor*, because a plan belongs to one and two Stations on `claude-code` share a five-hour window. A posture row is per *harness*, because a Station does not run on a vendor — it runs on a harness, and it is the harness that was asked. A test asserts a `codex` Station shows no cap from an `anthropic` reading.

#### Running the app found four things the five commands did not

The rule from Step 40 again, and it keeps earning its place. Build, typecheck, lint, format and 773 tests were all green over every one of these:

- **"a engineer".** Fixed in `core/roles.ts` with a vowel check rather than a table, because `ROLES` is a list somebody will add to — and bad grammar on a screen about enforcement makes the rest of the sentence easier to disbelieve.
- **"— across 0 runs".** The dash the limits strip uses for "nobody reported a number", borrowed for "there is nothing to report". Different sentences, and only one of them was true.
- **"1 runs".** Now formatted in `posture.ts`, where a test holds it.
- **The deny line sorted above the permission it refines.** Ordering by `tone` put "Denied infra/**" above "May write src/**", so the screen refined a rule it had not stated yet. Lines are now two groups: what stops this Station at all, then the leash's story in the order it has to be told.

#### One thing to know before repeating this by hand

**`POST /runs` takes a `cuesheet`, not a `stationIds` list, and silently defaults to the first configured Station.** Driving the scratch daemon by hand with `{"stationIds":["tagger"]}` started the *`claude-code` engineer* instead of the mock worker — a real CLI run against a real plan, stopped after 28 seconds and $0.31. The route's shape is not this step's to change, and the recovery worked exactly as designed (`stop` took the process tree down and the run landed `stopped` with its cost attributed). Recorded because the next person exercising this screen with a real harness configured will otherwise repeat the charge, and because the run is why the screenshots above have real money on them.

#### What was actually looked at

An isolated daemon on a scratch `homedir` with four Stations chosen to cover the disagreements — a `claude-code` engineer with allow *and* deny globs, a `codex` reviewer, a `mock` worker, and a `mock` engineer with no `paths` at all — plus the Vite dev server and a headless browser:

- the four cards, each saying something different about what is enforced and by whom,
- the same screen with real spend on it, after a run,
- both views, and the switch between them,
- and the whole thing at **380px**, where the attribution wraps under its sentence and nothing scrolls sideways.

~~**One thing was not exercised and is named rather than implied:** the "this harness cannot play this seat" line. It needs a registered harness whose roles exclude the seat, and the only such built-in is `ollama`, which Step 35 skipped — no build registers one, so the daemon answers `undefined` for its roles and correctly says nothing. The line is covered by tests at both layers; it has never been on screen.~~

**Now exercised — Step 35 closed this.** With `ollama` registered, a `role = "reviewer"` Station on it makes a live daemon answer: *"Station "bad-reviewer" is a reviewer, but the "ollama" harness can only play the worker seat. A model that cannot review will still answer as if it had, and an approval you cannot tell from a real one is worse than none."* First time any **shipped** harness has had a role list narrow enough to trip it.

#### On Phase 8's open question — "what a project *is*, exactly"

**Closed by this screen, or as close as it gets.** The question was whether a project is a folder or a folder plus Stations that may point outside it. The project view now shows the project root in its header and every Station's own workspace in its permissions, so a Station working outside the project is visible as the divergence it is rather than being implied by a single name in a topbar. That is what Step 34 said the project view owed the question.

### Step 43 — The run surface ✅

The live run, rebuilt on what three real harnesses actually emit rather than on what `mock` emitted in Phase 4: text, tool calls, file changes, denials, cost, verdicts, gates, standbys. Verdicts and gates in particular have never had a designed treatment — a blocking finding that holds a run is the most important thing this app can tell you, and it currently arrives as another line in a log.

**Done when:** the Phase 7 gate run replays into the new surface — **not ticked as written**: that run's record did not survive, so what replays is a reconstruction of it plus a live held gate run standing in for the original; see below — and the blocking finding is the thing you see first, not the thing you scroll for ✅, proven twice, including on live wire data.

> **Done, with one clause deliberately left unticked.** `ui/runview.ts`, `RunSurface.tsx` replacing `RunLog.tsx`, and a replayable fixture of the Phase 7 run. 801 tests pass, up from 775.
>
> **The first clause is not ticked, and that is the point of the next section.** A ✅ with a footnote explaining why it is not quite the thing is the pattern Phase 7 spent a retrospective on. The original record does not exist; what was built replays a *reconstruction* of it, and a live held gate run carries the wire data the original would have. Both are real evidence and neither is the clause as written, so the clause stays open and says why.

#### Why the first clause is not ticked

**The original Phase 7 run cannot replay, because its record no longer exists.** It was recorded months ago on a real repo with both CLIs billed, and its run store lived in `~/.cuesheet` — a directory this machine does not have. So two pieces of evidence were produced instead, and neither is quietly substituted for the original:

1. **A live held gate run, driven through the daemon with two mock vendors** — the `gate-run.test.ts` arrangement, by hand, in a browser. Real wire data: a real `Verdict` with a `severity: "block"` finding, a real `GateReport` holding on it, a real standby asking whether to override, and a real `held` status once it was refused. This is the stronger half.
2. **The Phase 7 run as a fixture**, reconstructed in `ui/src/fixtures/gate-run.ts` from the transcript this document recorded under Step 30 — the prompt, both vendors, `+22 −1` on `upload.js`, the security finding, the gate's two reasons, `$0.5552`, `2m 51s`. It replays **through the reducer**, not into the formatter directly, because that is the path a real run takes.

Deliberately **not** done: re-running the real two-vendor gate to re-photograph something the repo already recorded. That is about $0.55 of somebody else's plan for a screenshot.

#### Two different things are called "blocking", and running it is what found that

`Finding.severity: "block"` is the **reviewer's** judgement. A Gate's `blocking` is a list of **categories the operator declared hold-worthy**, and `core/gate.ts` holds on that list — not on severity. The first live gate run drove that home: the reviewer filed `security`/`block`, the gate had no `blocking` list, and the run finished **clean**.

That is correct behaviour and it makes a headline reading "a reviewer filed a blocking finding" over a finished run misleading, because it implies a hold that never happened. So the headline says which it is — *"A reviewer filed a blocking finding, and nothing stopped this run."* — and the finding still leads, because it is still the thing worth reading. A second pass found the other half: that sentence must not appear on a run that is **still live**, which is every run sitting on a Hold's standby, where the gate's record does not exist yet. A claim about an outcome is only made once there is one.

#### The surface is ordered by what it costs to miss

Phase 4's pane rendered every event as one row of the same shape, so the reviewer's objection sat between a tool call and a cost line in the same typeface. The order now is: **headline, findings, gates, stream, diff** — and the headline is chosen by severity rather than recency, in this order: a blocking finding, a failure, a question waiting on a human, then a Hold with no finding behind it. A run that is simply running gets no headline at all; a surface that announces every state teaches people to skip the announcement.

**Severity is read off the finding, never off the decision.** The recorded Phase 7 verdict is a `pass` *carrying* a blocking finding — `mock`'s `review: "blocking"` exists for exactly that case — and a surface keyed on `decision` would have drawn it green.

**The mark is on the run row too.** "Seen first" is not satisfied by a pane you have to open: the list is what you see before you click, and a row reading only `held` sends somebody hunting for the reason. A blocking finding puts `blocking: security` on the row.

#### What the real streams changed about the stream

- **Prose is coalesced per Station**, because Claude Code streams text a few words at a time and one row each turns a paragraph into forty rows of chrome. The break is on the **Station**, not only on the event kind — a two-vendor run interleaves the engineer's prose with the reviewer's, and merging those would fold the objection into the paragraph of the agent it is about.
- **A cost event must not break a paragraph either.** It was breaking one, and watching the live run is what showed it: costs land between sentences, so one thought rendered as four rows split by an event nobody draws. Fixed, with a test.
- **Cost events are not rows at all.** Every harness emits them continuously; the total belongs in the header.
- **A denial is not an error and not noise.** It is the only visible evidence a boundary held, so it keeps its own tone and its path.
- **`toolSummary` treats `input` as hostile**, because it is `unknown` on the wire and comes from a vendor CLI's JSON. A thrown property access inside a render is a blank pane — Step 40's failure with a different cause. Tested against `null`, numbers, arrays, wrong-typed fields and a bare string.

#### What was actually looked at

An isolated daemon on a scratch `homedir`, two mock vendors with different `vendor` strings, a real git workspace, the Vite dev server and a headless browser:

- a run whose reviewer filed a blocking finding in a category no Gate named — finishing clean, and saying so,
- the same cuesheet with `blocking = ["security"]`, which held: the standby asking to override, the finding at the top of the pane while the run waited, and the `HOLD` gate row with its reason once the override was refused,
- the run list carrying `blocking: security` on both rows,
- and the whole surface at **380px**, with no horizontal scroll.

#### One thing this step deliberately did not build

**Filter chips over `RUN_EVENT_TYPES`.** The constant's own comment offers them, and with `cost` now filtered out of the stream a chip list would be the natural next thing. It is not in the done-when, nothing in the app enumerates event kinds for display yet, and Step 44 owns the surfaces' states and controls. Named here so the next person finds a decision rather than an oversight.

### Step 44 — A design system, once ✅

Tokens for colour, type and spacing. Dark mode. A real empty state, error state and loading state for each surface. Keyboard navigation and focus order throughout, and the `⌘`/`Ctrl` hint correctness the gotcha checklist already tracks.

`styles.css` was 697 lines of hand-written CSS that grew a screen at a time — 1,440 by the time this step opened it. Consolidating it is what stops the rebuild from becoming the next thing that needs rebuilding.

**Done when:** every surface has all three non-happy states ✅, the whole app is operable from the keyboard — **not ticked as written**; built and unit-tested, and nothing has been *pressed*, see below — and dark mode is not a second set of hard-coded hexes ✅.

**This step expires a tick.** The gotcha checklist records `⌘` vs `Ctrl` as exercised — *photographed* reading `Ctrl1K` — and that photograph is of the Desk this phase replaces. A rebuilt UI has been exercised on nothing. The row is re-opened below rather than being quietly inherited, because a tick that was true when written and expires without the document noticing is the exact failure Phase 7 spent a retrospective on.

> **Done, with the keyboard clause left open.** `surface.ts`, `keys.ts`, `hooks/useModal.ts`, `components/Notice.tsx`, a rebuilt token layer in `styles.css`, and `shortcutHint` replacing `modifierKey`. 894 tests pass, up from 801 — including the first tests in this repo that *render* a component.
>
> The open clause is the keyboard one and it is open for an environmental reason rather than an unfinished one: the shell will not launch here, so nothing has been pressed. Stated below rather than rounded up, which is the pattern Steps 30 and 43 both set.

#### The two layers, which is the whole of the third clause

The old sheet declared every semantic token twice — `--muted: #8b95a3` under dark, `--muted: #5d6875` under light — with nothing relating the two sides. That is the "second set of hard-coded hexes" the done-when names, and it had already cost something: light `--dim` was *lighter* than light `--muted`, while dark `--dim` was *darker* than dark `--muted`. Both correct, and correct by accident.

There are two layers now. **Ramps** hold the only literal colours in the file, ordered light to dark and meaning nothing on their own. **Roles** — `--bg`, `--text`, `--bad` — say what a colour is *for*, and every one of them is a `var()` onto a ramp step, in both themes. A theme is then a mapping and reads as one: dark is `--muted: var(--n-6); --dim: var(--n-7)` and light is those same two steps the other way round, which is the accident written down. The light block in the built CSS now contains **no hex at all**, which is the clause made checkable rather than asserted:

```
prefers-color-scheme:light){:root{--bg:var(--n-1);--panel:var(--n-0);--panel-2:var(--n-2);
--line:var(--n-4);--text:var(--n-11);--muted:var(--n-7);--dim:var(--n-6);…}
```

Type, space, radius, shadow and depth got the same treatment — 105 declarations swept onto the scales. Two of those earned themselves immediately: the sheet had 10px, 12px and 14px paddings nobody had chosen, and the `z-index` values — a menu over its own scrim over a sticky topbar — were three numbers 1,200 lines apart that only mean anything relative to each other.

#### Two facts the state was carrying as one, and two surfaces that guessed

This is the part that was a bug rather than a tidy-up, and it is the same bug twice, in opposite directions.

`stations === null` meant both "the fetch is in flight" and "the fetch threw". The project view resolved that by always assuming the first, so a daemon that went down left it reading *"Reading this project's configuration…"* — a progress sentence that never resolves, promising all the while that it will. And `runs: []` is the initial state, so the run list announced *"No runs yet."* before the first request had been answered: a claim about a project, made before the project was asked.

A loading state that is really an error and an empty state that is really a loading state are the same defect — **a surface reporting a fact it does not have** — so the fix is one function, `describeSurface`, and the reducer now carries a `load` saying how the last read went. Three rules, each a test:

- **Loading beats empty.** A zero you have not finished counting is not a zero.
- **An error beats loading**, because the error is the one that never resolves on its own.
- **Neither beats content.** A refresh that fails over a list already on screen leaves the list there. What is drawn is still true — it is merely a minute old — and blanking it to announce the failure trades something true for something loud. That is the banner's job, and the shell already has one.

The launch surface got the same treatment and needed it most. A daemon that could not be reached was folded into "loading", on the argument that the socket's reconnect recovers. Half right: the socket does not attach until a project is open, so on the *first* screen of the app there was nothing coming to fix it.

#### A third surface was lying about money, and the ledger is why

`ProjectView` deliberately swallows a failed ledger fetch — spend is one column, and a ledger that cannot be read must not take the permissions down with it, which are what somebody came to that screen for. That decision is right, and its price had never been paid: with the ledger gone, every Station on the project read **never run**. On the screen whose entire job is being believed.

`spendLabel` now separates the three reasons a row carries no figure — never run, not known yet, not readable — because only one of them is about the Station.

#### What "operable from the keyboard" turned out to mean

Four things were missing, and only the first is the one people think of.

- **The modals were open at the back.** All three listened for Escape on the dialog element; only the palette ever focused anything inside one, so in the other two the key had nowhere to land. None trapped Tab — `aria-modal` tells a screen reader the rest of the page is inert and does nothing whatever to the tab order — so the third press out of Add-a-Station reached the **stop** button of a live run behind the scrim: reachable, invisible, and one Enter away. `useModal` focuses in, traps, and hands focus back.
- **The lists were tabbable and not navigable.** A run list of fifty rows beside the pane it fills is fifty presses to get past something nobody was reading. Arrows now walk the run list, the switcher menu and the palette, with a roving tabindex so a list is one tab stop rather than fifty. In the run list the *selection follows the focus*, because the pane is what the list is for and a highlight that shows nothing until you press again is two keystrokes pretending to be one.
- **There was no way past the top bar.** A skip link, which is the first tab stop and the reason the rest of the order is bearable.
- **The states had to announce themselves.** An error is `role="alert"`; the other two are a polite `role="status"`. These replace each other while somebody is looking elsewhere, and getting that pair the wrong way round is how a UI becomes unusable with assistive tech on while looking perfectly fine.

#### Why the keyboard clause is not ticked

**Nothing has been pressed.** The Electron shell will not launch in the environment this step was written in — the GUI process exits immediately, every time, before `whenReady` — so the app has not been driven by a keyboard on this platform or any other. What exists is the index arithmetic in `keys.ts` under test at both ends and both wrap-arounds, the DOM mechanics wired through `useModal`, and every surface rendered and read.

That is more than *handled in code* and less than *exercised*. It is the distinction the gotcha checklist below has enforced since Phase 5, and it applies to a done-when clause exactly as it applies to a checklist row. What closes it is somebody Tab-ing out of Add-a-Station and finding the scrim rather than the **stop** button.

#### The surfaces were rendered, which is a narrow and deliberate exception

`components/states.test.ts` is the first test in this repo that renders a component, and it exists because the done-when is a claim about *surfaces* rather than about a function. A test of `describeSurface` proves the sentences exist; it cannot prove anybody wired them up, and the failure being guarded against is exactly the screen that keeps its old null check and never asks. So each surface is rendered in all three states and read: the loading state never carries the empty state's words, the error state keeps the daemon's own message and offers to try again, and the project's name and root stay on screen while its configuration is unreadable — because the name is how somebody knows which daemon to go and look at.

It is `renderToStaticMarkup` in node, so no effects run. That is the right tool for this question and a poor one for most others, which is why it stays narrow: what it asserts is the *first paint*, and the first paint is the paint in question.

#### Two things this step deliberately did not build

- **A theme toggle.** Dark mode is a mapping now rather than a palette, so a `data-theme` override would be four lines. It is not in the done-when, the OS is the right authority for a control surface, and a switch nobody asked for is a preference to store, to migrate, and to disagree with the system about.
- **The filter chips over `RUN_EVENT_TYPES`** that Step 43 handed forward. Named again rather than silently dropped: this step owns the surfaces' states and controls, and chips are a control. They lost to the three states and the keyboard, which are what the done-when names. The next person finds a decision rather than an oversight — twice now.

**And the limits strip still renders nothing when it has nothing**, which stays deliberate and leaves it the one surface without all three states. Its own header says why: three of `UsageWindow`'s four variants carry no measurement, and a frame sitting at zero for a vendor that reported a *status* is the authoritative-looking screen Phase 10 exists to prevent. An empty state there would be furniture telling an operator less than the space it occupies.

### Step 45 — First run ✅

The path from install to first successful run, for someone who has never edited a TOML and did not read the README. Detect what is installed, say what is missing and how to get it, pick a project, add a Station, run something.

**Done when:** someone with Claude Code installed and no other preparation completes a run without being told anything by a human — **not ticked as written**; the path is built and walked end to end, and no stranger has walked it. That clause is a measurement, and it is the one thing here that cannot be done by writing code. See below.

> **Done, with the measurement left open.** `core/setup.ts`, `ui/firstrun.ts`, `components/FirstRun.tsx`, the workspace default and install links on the Add-a-Station panel, a `will-navigate` guard in the shell, and two daemon fixes the walk found. 932 tests pass, up from 894.

#### What the app actually said before this, in order

Open it on a fresh machine and the four screens read: *"No projects yet."* → *"No Stations yet — nobody is on this project."* → a panel with five fields, one of which is an empty path box → and then nothing at all, because the only way to start a run was a chord nobody had mentioned.

Every one of those sentences is accurate. Not one of them is an instruction. And the Add-a-Station panel, which is where somebody finally meets the thing they are missing, said **not installed** beside a harness and stopped there — a diagnosis with no remedy, on the one screen where the remedy is the whole point.

So the step is three things: know the remedy, say the current one, and remove the typing.

#### The remedy lives beside the diagnosis, not inside it

`core/setup.ts` is a table: what each harness is, where to get it, and what to run once you have it. Every string in it is already in the README under **Requirements** — copied rather than recalled, because that is the closest thing this repo has to a source of truth about other people's products.

**It is a table and not a field on `HarnessProbe`,** which is the decision worth stating. A probe describes this machine right now: it shells out, it can hang, it is stale the moment somebody runs an installer. Where Claude Code is downloaded from is none of those — it is the same sentence on a machine that has it and a machine that never will. On the probe, a UI could not say how to install a harness until it had finished failing to find it.

`setupAdvice` reads the probe rather than taking a boolean, because the two failures are one step apart and collapsing them is how a setup screen loses somebody's trust in a line: **telling them to download a thing they already have.** Ollama's second step is a model pull rather than a login, and is not called one — a sentence about credentials on the one harness that has no account sends somebody looking for a login page that does not exist.

#### One instruction at a time

`firstrun.ts` decides which of four moves is the current one — install, sign in, seat, ask — and the surface draws that one and nothing else. A card listing all four is a card where somebody starts on the wrong one, and three of the four are not possible when the first one is.

Three of the ordering rules were decisions rather than arithmetic:

- **`mock` is never "ready".** It is always installed and always authed — it is code in this process — so a fresh machine keyed on "is anything ready" would be told it was finished. It is offered *by name* as a demo instead, which is a different sentence. That is the first time the argument in `defaultHarnesses()` — that a first run showing nothing because nothing is installed is a worse introduction than a fake one that moves — has been reachable from any screen. See the daemon fix below for why it had not been.
- **Recommendation order, not probe order.** `ollama` probes `authed` whenever its server answers, because it has no account to be signed out of, so on a machine running Ollama and nothing else it is the first harness that *looks* ready. It is also the one that may only play `worker`, and a worker never writes: a first run seated there would stream text, cost nothing, change no files, and leave somebody concluding the app does not work. Nothing on the wire says that before a Station exists — `canPlaySeat` is computed per configured Station — so the order carries the fact, and the comment says it must not be re-sorted.
- **The guide is about what is missing, not about how new you are.** A project with no Stations is guided whether or not it has forty runs behind it. Keyed on run count, a project whose last Station was deleted would get a blank screen and no way forward, having decided the person was too experienced to be told anything.

And once a run exists, it goes. A surface still offering the first step after the first step is done reads as an app that has not noticed.

#### The typing is gone, because the README already promised it would be

The README's sketch of the Add-a-Station panel says *"Cuesheet has already made four of [the five choices] by the time you open the panel"* and *"Nothing here requires you to type a path."* Two of those were not true. The workspace field started empty — the one field with no default was the one field with no plausible guess available to the person filling it in, when there is a plausible guess: they are standing in a project. And the sketch draws an `install ↓` beside every uninstalled row, which did not exist.

Both are now kept. `starterStation` goes further for the one case where every answer is obvious — this project's folder, the seat that writes, the leash the panel already seeds — so the guide's button writes a working Station with nothing typed at all.

The prompt box is the fourth move made visible. The palette is the fast path and stays the fast path; it is also a chord, and a chord is not discoverable by somebody who has not been told about it. Starting a run from the box switches to the run surface, because the thing somebody just asked for is about to happen on a screen they are not looking at — which turns out to matter more than it sounds, for the reason in the next section.

#### Walking it found two daemon bugs, and the second one is the serious one

The path was walked against a real isolated daemon, twice: once with the probes faked down to nothing but the demo, which is the machine the done-when's stranger has, and once as this machine actually is — Claude Code installed and signed in, which is the half that cannot be faked.

**The demo harness has shipped since Phase 3 and no UI could ever see it.** `describeStations` built its probe list from `BUILTIN_HARNESS_IDS` ∪ the harnesses the config named, and `mock` is in neither on a fresh install. So `GET /stations` could not mention it, the Add-a-Station panel could not list it, and `defaultHarnesses()`'s whole argument for shipping it described something unreachable. The list now takes what the build actually *registered* — `harnessRuntime()` passes `registry.ids()` — unioned with what this repo plans for, because a planned-but-unregistered harness is still something to install and a registered-but-unplanned one (`mock`, or anybody's third-party harness) is something you have. A hardcoded list of what a build probably registers is wrong the moment a build registers something else.

**And a run waiting on a question was recorded as `running`.** `ask()` published a `status: standby` event and never wrote it down. Live clients were fine — the Desk's reducer follows the event — and that is exactly what made it invisible. The cost is paid on a resync, which is every reconnect and every restart: `snapshot` keeps an open standby only while the *store* says the run is waiting, deliberately, because a question with **go** and **no** under it for a run that ended while the app was closed is the loudest lie this Desk can tell. With the status never persisted, that filter dropped every genuinely open question instead. **Reload the window and the question is gone, while the run waits for an answer that can no longer be given.**

A first run meets this every single time, which is why a step about first runs is where it surfaced: the demo harness raises a standby on purpose, so the first run anybody does is the one that hangs if they reload.

#### What the walk showed

On a machine faked down to nothing installed:

```
guide says: install | Cuesheet drives an AI coding CLI. You will need one.
    Claude Code  Get it at https://claude.com/claude-code
    Codex CLI    Get it at https://developers.openai.com/codex
    Ollama       Get it at https://ollama.com
    demo offered: mock
pressing: the demo
written to: …\.cuesheet\projects\proj-d226f9\cuesheet.toml | created: true
guide now says: run | Ask for something.
it asked: "Write cuesheet-mock.md in the workspace?"
pressed: go
run landed: done | events: 23 | diff: true
guide after the first run: stands down
```

And on this machine as it is: *"Claude Code is ready. Put it to work on proj."*, the Station written with the project root as its workspace, and the prompt box offered. **It stops there on purpose.** The next press starts a real Claude Code run, and re-running one to watch a prompt box work is about a dollar of somebody else's plan for a screenshot — the same call Step 43 made about the gate.

#### Why the done-when is not ticked

**The clause says "measured on a stranger rather than asserted", and no stranger has seen it.** Everything that can be built has been built and the path has been walked end to end by somebody who wrote it, which is the one perspective the clause explicitly excludes. That is not a gap to close by writing more code; it closes when somebody who has not read this document opens the app.

What a walk can say, it says: every move the guide offers exists, does what it claims, and leads to the next one, on a machine with a real CLI and on a machine with none.

#### One external link, and the guard behind it

This is the first step to put real external links on screen, and a plain `<a href>` is a *navigation* rather than a window-open — `setWindowOpenHandler` never sees it, so the Desk would become claude.com in a window with no address bar and no back button, with the daemon running behind it. Every link carries `target="_blank"`; `staysInApp` in the shell is the guard behind that, because relying on every future author remembering an attribute is not a guard and this particular failure is unrecoverable rather than merely wrong.

#### One thing this step deliberately did not build

**A tour, a checklist, or anything that persists "you have seen this".** The guide is derived entirely from what is true right now — no Stations, nothing installed, no runs — so there is no onboarding state to store, to migrate, or to get wrong. A first-run experience that remembers whether you finished it is a first-run experience that shows the wrong thing to the second person who opens the app on the same machine, and there is no state here that could.

### Open question — answered

**How much of this the phone inherits.** Settled in the work rather than left to M3, and settled at the first surface Step 40 drew: **this UI is responsive from the start, not a desktop screen with a phone rewrite behind it.** The cost is a `max-width` and a couple of `min()` calls per surface; the alternative is discovering at M3 that every screen assumes a window. Nothing here is phone-*specific* — that is a different question and a later one — but nothing here breaks at 380px, and Steps 41 through 45 each paid that cost as they went rather than deferring it. The comment recording the decision sits in `styles.css` above the launch surface, which is where somebody about to add a sixth surface will find it.

---

# Phase 12 · The Commons

> 🔵 **Beta track.** The durable layer the README spends its "Why this exists" section arguing for. Everything before this made Cuesheet a better way to *run* agents; this is the first thing that makes leaving it expensive.

The pitch is one sentence: today Claude Code keeps `CLAUDE.md`, Codex keeps `AGENTS.md`, Ollama keeps nothing, none of them can read the others', and every tool re-learns your codebase from zero, forever. Two of those files are now written by harnesses in this repo and the third harness is the case that proves the point, which is what makes this phase buildable — `contextFiles` has been on the `Harness` interface since Step 13 waiting for it.

**Why this moved behind Projects and the Desk**, having been next in the previous revision of this plan: its own first open question was *"whether projection is per-workspace or global."* That question is not answerable by thinking harder about the Commons. It is answerable by Phase 8 existing, and unanswerable before it. Building the store first would have meant choosing arbitrarily and migrating later — the deferral is a dependency, not a demotion.

### Step 46 — The store ✅

`~/.cuesheet/commons/` as a git repo: markdown with frontmatter, one fact per file. Read, write, list, delete. Provenance on every entry — which Station, which Run, when.

Plain files in a repo the operator owns, deliberately: the README promises "you can read it, grep it, diff it, and leave", and a database would make that a lie.

**Done when:** a fact written through the API is a committed file on disk ✅, and `git log` explains where it came from ✅.

#### What the work settled

**TOML frontmatter between `+++`, not YAML between `---`.** The convention is YAML, and this is deliberately not it. The README says "markdown with frontmatter" and never names a dialect; `smol-toml` is already a dependency of `core` — it parses every `cuesheet.toml` — and it exports `stringify` as well as `parse`. A YAML parser would have been a new dependency bought to write a format core already reads and writes. `+++` is Hugo's TOML fence, so the choice is at least a convention somebody else made. The operator's side of the bargain holds either way: it is text, it diffs, and every key in it is one they could have typed.

**A fact id is a filename, so it is the same surface a run id is.** `isFactId` sits beside `RUN_ID_PATTERN` in spirit and is checked at the route boundary before anything reaches disk — lowercase, digits, single hyphens, nothing else. That one pattern also rules out a leading dot, a Windows drive letter, and two ids differing only by case on a case-insensitive filesystem. Without it `DELETE /commons/..%2f..%2fprojects` deletes the project registry, and there is a test that says so.

**`slugify` answers `null` rather than inventing `untitled-4`.** A caller handed a generated name would discover the collision later, in a store whose entire value is that things can be found in it. The store turns that `null` into a sentence asking for an explicit id.

#### `git` is optional, and the first version of that promise was not true

The design was right and the implementation was not: probing with `which` before spawning is **not enough**, because `run` *rejects* when a binary cannot be started. A `git` that is on PATH at probe time and gone, unreadable or not executable at spawn time throws from inside `spawn` — so the store's whole promise held only for the one case somebody had thought of.

A test that pointed `gitBin` at a file that does not exist found it, which is exactly the shape of the real failure. Every git call now goes through a wrapper that turns a failure-to-start into an answer, and the promise is enforced rather than intended: **a missing `git` keeps your facts as files and reports that history is unavailable.** Every mutation returns `committed` so a caller can say which happened, rather than implying a history that is not there.

**Identity rides on the commit, never on the operator's config.** A fresh machine has no `user.email` and a commit without one fails outright, so an identity has to be supplied — but writing one into `git config` to achieve that would be Cuesheet reaching outside its own directory to change how every other repository on the machine commits. Per-commit `-c user.name` / `-c user.email`, and the identity names **Cuesheet** rather than the operator: a machine-written commit attributed to a person is a lie in the one place that exists to answer who did something. A test asserts the repo's local config is left empty.

**Provenance is written twice, because two questions are being asked.** The frontmatter carries `station`, `run` and `at` — that is what Step 47's projection and Step 48's inbox read. The commit message carries the same three in a body under a subject that names the fact, because `git log` is the literal thing this step's done-when asks about, and `--oneline` should be readable without `--stat`. All three are optional in the type: a fact a human typed has no Station and no Run, and inventing one would make "what did an agent write while I was not looking" a filter nobody could trust.

**A `.gitattributes` pinning `eol=lf` is written at `git init`.** Cheap now; without it a commons created on Windows commits CRLF markdown, and Step 47's "re-running the projection twice produces no diff" fails there for a reason that has nothing to do with projections.

The non-obvious half is the *first* commit, since `.gitattributes` is staged in the same `git add -A` as the first fact — so it is fair to ask whether it governs its own commit. **It does**, checked rather than assumed: `git ls-files --eol` reports `i/lf` for a fact whose working copy is `w/mixed`, and the committed blob has no carriage returns. Git reads attributes from the working tree at stage time, not from `HEAD`. The test asserts the committed bytes rather than the file's presence, because "the rule is written down" and "the rule was applied" are different claims.

**Two smaller decisions that will matter later.** `rev-parse --git-dir` rather than looking for a `.git` directory, so a commons the operator turned into a worktree or a submodule is not re-initialised underneath them. And a file somebody hand-edited into something unparseable is *skipped* by `list()` rather than failing it — Step 48's inbox is where a malformed fact gets shown to a human, and it is unreachable if listing throws.

**`history()` reports a reason rather than collapsing into an empty list.** A repository with no commits, a missing `git` and a broken one are three different things, and the store distinguishes "cannot" from "nothing" everywhere else — `committed` plus `reason` on every write is that same discipline. Step 48's inbox has to be able to say *history is unavailable* rather than *nothing has happened*.

**One bug worth recording because nothing would have caught it.** `remove` reached its sibling through `this.get(...)` inside a returned object literal. That works while the method is called as a method and breaks the moment anyone destructures the store or hands `remove` to a callback — and every test called it the one way that works. The reader is now a hoisted closure like every other helper in that scope, with a test that destructures the store deliberately.

**`GET /commons` is global**, like `/usage` and for a related reason: there is one store at `~/.cuesheet/commons`. What varies per project is which facts *project into* it, and that rides on a fact's own `projects` field — Step 47's subject, not this route's.

### Step 47 — Projections ✅

Render the store into `CLAUDE.md` and `AGENTS.md` at the workspace root, from `contextFiles`. Regenerate on change. Never clobber a hand-written file — generated content goes between markers, and anything outside them survives.

#### How one store reaches several AIs across several projects

This is the question Phase 8 existed to make answerable, and the answer is a layer split rather than a merge strategy:

```
  ~/.cuesheet/commons/            one store · one fact per file · each fact tagged with the projects it belongs to
         │
         ├── scope: "user"  ────▶  ~/.claude/CLAUDE.md           rendered once per machine, never per project
         │                         ~/.codex/AGENTS.md
         │
         └── scope: "project" ──▶  <project A root>/CLAUDE.md    one project's facts, two dialects, same body
                                   <project A root>/AGENTS.md
                                   <project B root>/CLAUDE.md
                                   <project B root>/AGENTS.md
```

- **`scope` on `contextFiles` is the mechanism, and it has been sitting there since Step 13 meaning nothing.** Phase 8 gives the first half of it a referent: `scope: "project"` renders into *that project's root*, resolved the same way config is. `scope: "user"` is the crew layer — how you work, true in every repo — and is rendered once per machine.
- **A `scope: "user"` file is never re-rendered per project.** Both harnesses read exactly one of each: there is one `~/.claude/CLAUDE.md` on the machine, not one per project, so a per-project render into it is a last-writer-wins race between projects that happen to be open at the same time, and it leaks project A's facts into every run of project B. Two projects can be active at once — Phase 8 made sure of that — so this is a live bug, not a theoretical one.
- **The two files are the same body in two filenames.** A fact is stored once and rendered twice; `claude-code` reads `CLAUDE.md`, `codex` reads `AGENTS.md`, and neither is told the other exists. That is the README's claim in one sentence, and it is only true if the renderer is one function with the path as a parameter.
- **Two Stations in one project share one file, not one file each.** The projection is keyed by project and harness, never by Station. A per-Station file would need a per-Station working directory, and the harnesses resolve their context file from the workspace root they are given — which, for two Stations on the same repo, is the same directory. What narrows a Station is its leash and its role, not a private copy of the memory.
- **Markers, on every file, including the user-scope ones.** A hand-written `CLAUDE.md` at a project root is the common case, not the exception, and clobbering one is the kind of data loss nobody forgives. Everything outside `<!-- cuesheet:begin --> … <!-- cuesheet:end -->` survives untouched, and a file with no markers gets the block appended rather than replaced.
- **Generated content is written in place and `.gitignore` is not touched.** Committing the block is a legitimate team choice — it is how a colleague without Cuesheet gets the same context — and silently adding a rule to someone's ignore file to prevent that is a decision that is not ours to make.

**What was nearly decided instead, and why it lost:** one shared `CLAUDE.md` in `~/.cuesheet/`, symlinked into each project root. It is cheaper, it is one file to keep correct, and it is wrong twice over — every project would then see every other project's facts, which is the leak above with extra steps, and symlink creation on Windows needs Developer Mode or elevation, which is already a ticked line on the gotcha checklist for a reason.

**Done when:** one fact written once is visible to both harnesses without either being told the other exists ✅, re-running the projection twice produces no diff ✅, a hand-written paragraph outside the markers survives a regeneration ✅, and a fact tagged for one project does not appear in another project's file or in either user-scope file ✅.

#### What the work settled

**An empty `projects` list is the user layer, not a wildcard copied into every project.** It means the fact is true everywhere, but copying it into every project file would duplicate the same tokens after both harnesses have already loaded their one user-scope file. A non-empty list is therefore project scope and an empty one renders once under the home directory. This also makes the leak test structural: a project-tagged fact has no route into either user file.

**Projection targets come from `Harness.contextFiles`, never from a filename list in the daemon.** `harnessRuntime()` flattens the live registry at regeneration time, and the projector deduplicates its targets. Claude Code and Codex receive the same generated bytes because one renderer feeds both; a third-party harness joins by declaring a context file rather than by teaching the Commons its name.

**Regeneration is serialized and reconciled at boot.** Adjacent write/delete requests cannot finish out of order and resurrect a removed fact, and a file changed while Cuesheet was closed is corrected when the daemon starts. No watcher is needed. A new project also triggers a pass so existing facts appear on first open rather than after the next memory edit.

**The generated block is byte-stable by construction.** Facts sort by their ASCII ids with a direct comparison rather than the machine's locale; the renderer includes no clock, run id or filesystem ordering; and an unchanged target is not rewritten. Marker text inside a fact is escaped so a fact explaining the projection format cannot corrupt the next regeneration.

**Everything outside the marker pair is treated as somebody else's data.** It is preserved byte for byte. A missing pair is appended; an incomplete or duplicate pair refuses rather than guessing which handwritten bytes belong to Cuesheet. Context paths are also confined to their declared project or user root, because `contextFiles` is an extension seam and an extension seam must not become an arbitrary filesystem write.

### Step 48 — The approval inbox

Captured memories land in an inbox, not in the store. Approve, edit, or discard from the Desk.

The README is blunt about why and the reasoning should not be softened during implementation: *"without a gate, agent-written memory drifts, duplicates, and quietly poisons every future session."* `approval = "auto"` exists in the config for people who want it; it is not the default.

**Done when:** a run that writes a memory shows it as pending, and nothing reaches `CLAUDE.md` until a human says so.

### Step 49 — MCP recall

An MCP server exposing `memory_search` / `memory_write`, registered through `writeConnectors()` — inert in all three harnesses today, for this.

Why both static files *and* a server: files cost nothing and are always loaded, including by the local models of Phase 9 that will never reliably decide to call a tool; the server carries the long tail that would blow a context budget if pasted into every session.

**Done when:** a Station recalls a fact that is *not* in its projected file, and a local model that never calls the tool still sees the projected ones.

### Step 50 — Sync

A git remote the operator controls. Push, pull, and a conflict that a human resolves rather than a merge strategy that silently picks.

**Done when:** two checkouts of the same Commons converge, and a conflicting edit on both sides surfaces instead of vanishing.

**Done when (phase):** a fact learned by `claude-code` on one machine is in `codex`'s context on another, with no vendor involved in moving it.

### Open questions to settle in the work, not now

- **What a "fact" is.** Too granular and the store becomes a junk drawer; too coarse and it is a second README nobody reads. The approval inbox is the pressure valve either way.
- **What Gates and the Commons owe each other.** Phase 7 left a known limitation: a Gate reviews the *workspace diff*, so two Stations sharing a workspace are reviewed together. Per-Station attribution needs this store or per-cue diffs. Worth deciding here rather than inheriting the ambiguity.
- ~~**Scope, now that projects exist.**~~ Settled in Step 47 above: project-scope files render per project root, user-scope files render once per machine, and a fact carries the projects it belongs to. What is *left* of the question is narrower and still open — **what a Station carries between projects.** A Station is configured per project today, so "the same Station serves two projects" is really two Stations that share a harness and a name. If Stations ever become machine-level, this reopens.
- **Whether a projection should be filtered by leash.** A reviewer denied `infra/**` is still handed every fact about `infra/**` in its context file, because the projection is per project and the leash is per Station. Filtering would make the two agree; it would also mean two Stations in one project can no longer share one file, which Step 47 relies on. Worth deciding with a real store in front of you rather than now.

---

# Phase 13 · A product other people can use

> 🔵 **Beta track, and the boundary of it.** Every step here is something a stranger hits in their first hour that no amount of feature work fixes.

Most of this phase is already written down as unticked boxes in [Exit criteria](#exit-criteria); what it adds is step shape, ordering, and the dependency chains that two adjacent checkboxes hide. The 1.0-only items — the security review, leash fuzzing, Linux, M3 · Pocket — stay in that list rather than moving here.

### Step 51 — The CLI that the README already documents

`packages/cli/src/index.ts` is one line: `export {}`. The README prints `cuesheet run --engineer opus --review codex` and a Quickstart built around `npx cuesheetd`, and a note admitting the flags are "the shape it is heading for" rather than something you can type.

This is the largest honesty debt in the repo. Phase 7 removed the reason it was empty — Gates were the blocker and are not any more — and Phase 8 gives the commands a project to run against.

**Done when:** every command printed in the README runs, or the README stops printing it. No third option.

### Step 52 — SQLite behind `RunStore`

The interface was cut for this in Step 10, and the seam has held through everything since. Two places already show the file store's scaling through: `reconcileInterruptedRuns` is O(all runs ever) by its own comment, and `store.list(limit)` reads directories to answer.

`node:sqlite` is in Node 22, which removes the native-module risk that motivated files in the first place — the Decisions table's stated reason to revisit *"once packaging is proven"*, and packaging is proven.

**Done when:** a store with 10,000 runs opens the Desk as fast as one with ten, and the file store still passes the same suite so an operator can choose.

### Step 53 — Migrations as a mechanism

Step 33 performs one migration. This makes it a system: versioned config, versioned store, a migration that runs once and is recorded, and a refusal to open state written by a *newer* build rather than corrupting it.

**Done when:** every released version's state opens on the current build with nothing lost, proven by keeping the old profiles around and running them in CI.

### Step 54 — Signing, notarization, auto-update

One chain, not three checkboxes: macOS notarization is a precondition for `electron-updater` working without a Gatekeeper prompt, and an unsigned auto-updater is worse than no auto-updater. Windows SmartScreen reputation accrues only to a signed binary, and only over time, which makes the signing date a dependency for every install after it.

Step 26 documented the honest unsigned position. This is where that stops being acceptable, because an app that cannot update itself is not one people keep.

**Done when:** a stranger's install updates itself with no terminal, no quarantine flag and no SmartScreen dialog — and a release that fails to notarize fails the pipeline rather than shipping.

### Step 55 — The repository as a product

The README links to `docs/harnesses.md` twice, `CONTRIBUTING.md` once and `SECURITY.md` once. **None of the three files exist**, so all four links 404 on GitHub today. `.github/` holds two workflows and nothing else — no issue templates, no PR template, no code of conduct, no changelog.

- `docs/harnesses.md` — the one the README calls "the highest-leverage contribution", and the 1.0 bar already requires a third-party harness proven against it. Three shipped harnesses of three genuinely different shapes is the material to write it from.
- `SECURITY.md` — a disclosure path. The README makes real security claims (loopback by default, short-lived pairing tokens, leashes) and tells people it is not audited; that combination needs somewhere to send a finding.
- `CONTRIBUTING.md`, code of conduct, issue and PR templates, and a changelog that releases are cut from rather than written after.

**Done when:** no link in the README 404s, and someone can file a good bug report or a first harness PR without asking a question first.

### Step 56 — Errors you can act on, locally

Crash and error reporting with no telemetry — the constraint the README sets and the Non-goals section defends. A log an operator can find, a crash that names what it was doing, and a bug report that can be pasted rather than reconstructed.

**Done when:** a crash mid-run leaves something a stranger can attach to an issue, and nothing leaves the machine unless they attach it.

---

# Phase 14 · The context economy

> ⚪ **Post-1.0 track, and the first phase that is about the *price* of the thesis rather than the thesis.** It sits outside the 1.0 bar deliberately: that bar is *"the README is true as written"*, and a phase whose own README sections are marked 📋 cannot be part of the definition of its own completion.
>
> A gated two-model workflow burns roughly 3× a single session. The README says so in the FAQ and that number is not going away — a second opinion costs a second read of the code. What *is* going away is the waste around it: an agent that re-derives your repo from `ls` on every run, a reviewer handed forty thousand lines of lockfile diff, and a ledger that cannot tell a cached token from a fresh one.
>
> **It sits after Phase 13 because it measures things that do not exist yet** — the ledger is Step 39, the projections are Step 47, and tuning a context budget before there is a context to budget is guesswork. It is not, however, load-bearing for the beta: **Steps 57 and 58 can be pulled forward into Phase 10 the moment they are wanted**, and Step 57 is a prerequisite for the ledger being honest rather than merely present.

### Step 57 — Cache-aware cost ✅ *(pulled forward into Step 39)*

> **Done early, exactly as the phase header said it could be.** Step 39's ledger needed it — a ledger that reports `tokensIn` without saying how much was cache can say what a run cost and never why — so `Cost` and `CostDelta` were widened there, both harnesses now report their breakdowns, and `createMeter`, `addCost` and `reconcileCost` were each taught about the new fields separately. See Step 39's retrospective for what each of those three would have gotten wrong. The rest of Phase 14 is untouched.

Widen `Cost` and `CostDelta` with optional `cacheRead` and `cacheWrite`, and stop collapsing the vendors' cache figures into one number.

The finding is in Phase 10 and the detail is worth repeating at the point of work, because the two harnesses are lossy in *opposite* directions and a single fix will not do both: `claude-code.ts` adds `cache_creation_input_tokens` and `cache_read_input_tokens` into `tokensIn` (correct as a total, and the comment above it says why — counting only `input_tokens` under-reports a run severalfold), while `codex.ts` reads `input_tokens` and drops `cached_input_tokens`, which is a *subset* rather than an addend. Summing both vendors the same way would double-bill one of them; this is the same asymmetry the house rule about captured streams exists to catch.

`tokensIn` keeps meaning what it means today — the total billed input — so nothing that reads it breaks. The new fields are the breakdown, absent when a runtime does not report one, which is a different claim from zero.

**Done when:** a run that hits a warm cache shows a hit rate, two runs with the same `tokensIn` and different cache mixes show different prices, and a harness that reports nothing about caching still produces a valid `Cost`.

### Step 58 — The brief has a budget

`ctx.brief` is assembled by the daemon and handed to a harness. Nothing caps it.

Two places this bites, both real today. A reviewer in a Gate is handed the *whole workspace diff* — Phase 7 recorded that limitation for attribution reasons, and it is a spending limitation too: a run that regenerates a lockfile sends every line of it to a second vendor at full price. And `skip_if_diff_under` is the only lever, which is a line count and therefore blind in both directions — a five-line change to an auth path is worth reviewing and a five-hundred-line vendored bump is not.

- A byte budget on the assembled brief, with per-file elision rather than truncation, so a diff that overruns loses whole files with a note instead of stopping mid-hunk.
- Path-weighted gate skipping alongside the line count: `always_review` and `never_review` globs, matched with the same posix-normalized, Windows-`nocase` matcher the leash already uses. **Reuse `core/leash.ts`'s matcher — do not write a second one.** Two glob implementations in one product will disagree, and the one that disagrees about `infra/**` is a security bug.
- Local, approximate token counting for the pre-run check of Step 38. Approximate because the only exact answer is a vendor endpoint, and the README's no-credential promise means Cuesheet will never hold the key to call one. The number is labelled an estimate wherever it is shown.

**Done when:** a Gate over a 40k-line diff sends a bounded brief and says what it left out, a lockfile-only change skips review on a path rule rather than a line count, and a run refused for budget is refused before it spends anything.

### Step 59 — The repo map

A symbol index of the workspace, rendered into the projection as part of the generated block: files, their exported symbols, and where they live. Regenerated on change, stable-ordered.

This is the largest token sink in an agent run and the one nobody bills you for explicitly — every session opens by rediscovering the shape of a repository that has not changed since yesterday. The captured Codex fixture in this repo shows it happening: the first two tool calls of a real run are `rg --files` and a `cat` loop hunting for `AGENTS.md`.

Tooling, and the constraint that picks it: **`web-tree-sitter` (wasm), not the native `tree-sitter` binding.** A native module means a rebuild against Electron's ABI on three platforms, which is exactly the risk Step 10 chose files over SQLite to avoid, and packaging is the part of this repo with the most scar tissue. Grammar wasm files ship as resources the way the tray icon does.

Where it lives is a dependency-direction question with an unobvious answer: `core` owns the map's *format* (it is a type, and `core` owns the vocabulary), the **daemon** builds it, because building it reaches disk and `core` only touches disk through an injected `HostEnv`. It is not a harness's job — a map built per harness is the same work three times, and harnesses never import each other.

**Done when:** a cold run on a mapped repo reaches its first edit in measurably fewer tool calls than the same run unmapped, and regenerating the map twice produces no diff.

### Step 60 — Rewind, for every harness

`cuesheet rewind <run>` reverse-applies a run's stored patch.

Every run record already holds `diff.patch`; this step is mostly the CLI surface and the safety rail. One vendor ships rewind and the other does not, and neither can rewind the other's run — which is the whole argument of the project, available here for the price of reading a file Cuesheet already wrote.

The rail: refuse when the working tree has moved under the patch rather than applying it partially. A half-reverted tree is worse than a bad commit, because the bad commit is at least in the log.

**Done when:** a run that made a mess is undone from the record, and a rewind that would conflict refuses with the conflicting paths named.

### Step 61 — Hooks as cues, and the capability question

A `hook` cue kind: run a command after a Station finishes, with the run's id, diff and status on stdin. Formatters, test runs, a notification, a commit.

The seam is the one Gates went through — cues were already an ordered list, and a gate was a cue kind, so a hook is too. What it buys is parity in the direction that matters: one harness has a hooks system and the other has a notify shim, and a hook *cue* gives hooks to every harness including the local models of Phase 9, which will never have their own.

**And here is the honest part, which should not be softened in the work:** the same trick does not extend to everything. `Harness` has `probe`, `usage`, `contextFiles`, `writeConnectors` and `run`, and **nothing that expresses what a runtime can do**. There is no seam for "this one supports plan mode", "this one can resume a session", "this one enforces a sandbox itself". Adding `capabilities` to the interface would be the first change to it since Step 13 — additive, but a change — and the alternative is feature-detecting on `vendor`, which re-couples the daemon to the harnesses the interface exists to keep it away from. **Decide it here, deliberately, rather than discovering it while writing the third harness.**

**Done when:** a hook cue runs the project's formatter after every engineer step regardless of which vendor ran it, and the capability question is answered in writing — either `capabilities` is on the interface or there is a recorded reason it is not.

### Step 62 — What your context already costs

A read-only audit, in the Desk and in the CLI: how large every always-loaded file is, in estimated tokens, multiplied by the Stations that load it and the runs that load them.

This is the smallest step in the phase and probably the most useful one. A 40k-token hand-written `CLAUDE.md` is paid by every Station on every run forever, and nothing in any tool tells anybody that. It also keeps the rest of this phase honest, since it is the only thing here that produces a before and an after.

**Done when:** the Desk can answer "what am I paying for context, per run, across this project's Stations" with a number, and a projection that grows by 10k tokens shows up as a cost change rather than a bigger file.

### The rule that makes all of this work, written down before it is broken

**A projection, a repo map and an assembled brief must be byte-stable across runs when nothing has changed.** Prompt caching is prefix-based: one reordered line near the top invalidates everything after it, and a cache miss on a 30k-token context costs an order of magnitude more than a hit. So no timestamps, no run ids, no usage figures, and no map ordering that depends on `readdir` order or mtime in any generated context. Step 47 already requires "re-running the projection twice produces no diff" for a different reason — that clause is load-bearing twice, and this is the second reason.

### Open questions to settle in the work, not now

- **Whether the repo map belongs in the context file at all**, or behind the MCP recall server of Step 49. Files are free and always loaded; a map is the single largest thing anyone would put in one. The answer probably differs by repo size, which means it is a setting, which means picking a default.
- **What "maximize tokens" means when the user has a plan, not a bill.** Under a subscription the scarce thing is the 5-hour window, not dollars, and the cheapest run is not the one that finishes soonest. Phase 10's strip and this phase's ledger may want to optimize different quantities.
- **Whether elision can be honest.** A brief that drops files to fit is a brief that reviewed less than it appears to have reviewed, and a Gate verdict over an elided diff should probably say so on the record.

---

## Deferred on purpose

Most of this table has now been claimed by Phases 8–13, which is what the seams were cut for. The rows are kept rather than deleted, because *which* seam absorbed each one is the evidence that the interfaces were drawn in the right places — nothing below required changing `Harness`, `RunStore` or the HTTP transport to become additive.

| Deferred | Needed by | Seam that makes it additive | Where it went |
|---|---|---|---|
| ~~SQLite run store~~ | 🔵 beta | `RunStore` interface (Step 10) | Step 52 |
| ~~`codex`~~ / ~~`ollama`~~ harnesses | 🔵 beta | `Harness` interface (Step 13) — `codex` landed in Phase 7 through exactly this seam, with no change to the interface, and `ollama` needs none either despite being a different shape of thing entirely | Phase 7, Phase 9 |
| ~~Limits strip, fallback routing~~ | 🔵 beta | `usage()` already on the interface | Phase 10 |
| ~~Gates, reviewer role, verdicts~~ | 🔵 beta | Done. Cues were already an ordered list; a gate was a cue kind | Phase 7 ✅ |
| ~~Commons, MCP recall~~ | 🔵 beta | `contextFiles` already on the interface | Phase 12 |
| **Projects** | 🔵 beta | **No seam — this is the one nothing was cut for.** `cwd`, `loadConfig` and the store root each assume exactly one, which is why it is a phase and not a step | Phase 8 |
| ~~Cache-aware accounting~~ | ⚪ post-1.0 | **No seam — `Cost` was three fields and none of them was a cache.** Additive to widen, but a `core` type change rather than a harness one, which is why it could not simply arrive with a new harness | Step 57, done inside Step 39 |
| Hooks, rewind, plan mode | ⚪ post-1.0 | Cues, for the first two — a hook is a cue kind exactly as a gate was. **Not for the third:** `Harness` has no way to say what a runtime supports | Steps 60–61 |
| Phone pairing, tailnet | 🟢 1.0 | The HTTP API is transport-agnostic (Step 12) | still deferred |
| Linux builds | 🟢 1.0 | `electron-builder` target, not an architecture change | still deferred |
| Caller, On-Call | ⚪ post-1.0 | Both are cuesheets + a trigger over the existing queue | still deferred |

**The one row without a seam is the one worth reading.** Every other deferral in this table was anticipated: an interface method sat unused for months waiting for it. Projects were not deferred — they were *assumed*, and an assumption leaves no seam behind. That is a different failure from a known gap, and the tell is that it never appeared on a checklist until someone tried to open the app on a second repo.

---

## Cross-platform gotcha checklist

Keep this next to you; every item is something that works on macOS and fails on Windows.

Ticked means *exercised on a Windows machine*, not *handled in code*. The three left open are open for reasons worth reading — and one of them was ticked until Phase 11 was planned, which is the point of stating the rule this precisely.

- [x] `.cmd` shims need `cross-spawn`, not `spawn` — no longer taken on trust. The `which` tests inject `isExecutable`, so they only ever proved the PATHEXT arithmetic, and both Windows machines happened to have a native `claude.exe`. `spawn.test.ts` now writes a real CRLF `.cmd`, resolves it against a real PATH with the real executable check, and **executes** it — the thing bare `spawn` cannot do. It also asserts that a prompt with `&` in it goes in on stdin and never reaches `cmd.exe` as a command. Windows-gated, so it runs on the CI runner and skips elsewhere.
- [x] Killing a child does not kill grandchildren on Windows — `taskkill /T /F`
- [x] Path separators: normalize to posix before any glob
- [x] Drive-letter case and `fs.realpath` before leash checks
- [x] Filenames are case-insensitive on Windows — glob matching needs `nocase` there, and only there
- [x] `symlink()` needs Developer Mode or elevation on Windows — probe and skip, don't fail — *or use a junction, which needs neither*
- [x] `EBUSY` on concurrent file writes — serialize appends
- [x] `\r\n` in stdout line parsers
- [x] `~` is not expanded by the OS on Windows
- [x] **A UTF-8 BOM makes `cuesheet.toml` unparseable** — found by writing a config the way Windows writes files, and fixed in `parseConfig`. See below; this one is not in the original list and should have been.
- [x] `MAX_PATH` 260-char limit — 148 chars deepest, against a 260 limit, with long paths *disabled*
- [ ] Tray icon format differs (`Template.png` vs `.ico`) — the `.ico` is generated, packaged, and loads (close-to-tray proves a tray exists). The glyph **has** now been looked at, by decoding the file and rendering it at 8× (see Step 24): it is sound from 24px up and muddy at 16, where the fader tracks collapse into grey. What is left is a design decision about 16px proportions, not an observation — kept unticked because the decision is unmade
- [ ] `setAppUserModelId` for notifications — set, and now pinned by a test against `electron-builder.yml`; **no toast has been observed**, because the test machine has toasts disabled system-wide
- [ ] `⌘` vs `Ctrl` in every UI hint — photographed reading `Ctrl1K`, re-opened by Step 44, and **the photograph turns out to have been of the bug**. Ticked here means exercised on a Windows machine rather than handled in code, so the row stays open — but Step 44 found the defect by reading the hint rather than by seeing it, which is the argument for re-opening a row made concrete. `modifierKey()` returned `⌘` or `Ctrl` correctly, and every call site built `{modifierKey()}K` out of it: `⌘K` on a Mac, which is right because macOS sets its shortcuts solid, and `CtrlK` everywhere else, which is not a shortcut anybody writes. `shortcutHint("K")` now returns the whole shortcut, `Ctrl+K`, off this machine's own `process.platform` — which the preload has exposed since Step 21 and which nothing had ever read, the hint having been inferred from a deprecated `navigator.platform` all along. What is left is the photograph: the shell will not launch in the environment Step 44 was written in, so the corrected hint has been tested on a Windows machine and not yet *seen* on one
- [x] Paths with spaces in packaged builds — installed to `C:\Users\noahp\Cuesheet Alpha Test\Cuesheet` and launched

---

## Suggested order of attack

If you want the shortest path to something you can play with, do **Steps 1, 4, 5, 8, 9, 10, 11, 13, 14, 17, 18, 19** first. That's a daemon streaming a fake run into a real Desk in a browser — the whole shape of the app, with no models and no Electron. Everything after that is making it real.

**Past alpha, the phase number is the order** — see the numbering rule under [Status](#status). Phase 7 came first because a second opinion is the thesis and it was the one claim the README could not back. Phases 8–13 then run in sequence, and the chain is a dependency chain rather than a ranking:

**8 Projects → 9 `ollama` → 10 Limits → 11 the Desk → 12 the Commons → 13 the product → 14 the context economy.**

Projects because nothing above it can be scoped without them. `ollama` before Limits because a strip designed without a station that cannot run out is a strip that will need redesigning the week one arrives. Limits before the Desk because half the screen the operator asked for renders usage, and `usage()` returns `[]` from every harness today. The Desk after all three because a rebuilt UI full of placeholders is the expensive kind of mistake — you ship it, and then you cannot tell whether it is wrong or merely empty. The Commons after the Desk because its scoping question is answered by Phase 8 and its inbox needs somewhere to live. And the product last because signing, migrations and a CLI are the work that only pays off once the thing is worth installing.

Phase 14 comes last because every measurement it makes is of something the six phases before it build, and a context budget tuned against a store that does not exist yet is a guess with a number on it. The exception is stated in the phase itself: Step 57 widens `Cost`, and a ledger shipped without it is a ledger that cannot explain its own numbers — pull it forward into Phase 10 if Phase 10 is what you are writing.

**If you want the shortest path to the thing the request actually described** — open the app, pick a project, see who is on it and what they are spending — that is Steps 31–34 and 40–42, with 37 for real numbers. Phases 9, 12 and 13 can slip without making that incoherent.
