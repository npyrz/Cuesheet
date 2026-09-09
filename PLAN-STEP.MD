# Cuesheet — Foundation Build Plan

Small, ordered steps to get a **working** Cuesheet on **macOS and Windows**. Everything here is scaffolding you can tear up later; the goal is a running app you can tweak, not a finished product.

Scope of this plan = README milestones **M0 (Spine)** and **M1 (Desk)**, plus just enough of the harness abstraction that M2–M9 don't require a rewrite. Linux, phone pairing, Commons, Gates, Caller, and On-Call are explicitly out of scope here — see [Deferred](#deferred-on-purpose).

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

| Phase | State |
|---|---|
| **0 · Repo and toolchain** | ✅ Done (Steps 1–4) |
| 1 · Contracts | ⬜ Next — Step 5 |
| 2 · Daemon spine | ⬜ |
| 3 · Harnesses | ⬜ |
| 4 · Desk | ⬜ |
| 5 · Electron shell | ⬜ |
| 6 · Packaging and CI | ⬜ |

---

# Phase 0 · Repo and toolchain ✅

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
- `dataDir()`, `runsDir()`, `logsDir()`.
- `expandHome(p)` — the README's config uses `~/code/api` and Windows won't expand it for you.
- `toPosix(p)` — normalize separators before any glob match. Gate this on platform: a backslash is a legal character in a POSIX filename, so rewriting it there corrupts real paths.
- `resolveUserPath(p, cwd)`, `isWindows()`, `pathFor()`, plus `DEFAULT_PORT` and `daemonLockFile()` for Step 8.

**Done when:** tests running on macOS assert `C:\\Users\\noah\\.cuesheet` for a `win32` env, and vice versa.

---

# Phase 1 · Contracts before code

The point of these three steps is that everything downstream depends on types, not on the daemon.

### Step 5 — Domain types (`core`)
`Station`, `Harness`, `Role`, `Cue`, `Cuesheet`, `Run`, `RunEvent`, `Standby`, `Verdict`. Match the README's vocabulary exactly — the words are the spec.

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

### Step 6 — Config schema and TOML loader (`core`)
Parse `cuesheet.toml` with `smol-toml` (pure JS — no native dep), validate with `zod`. Support the README's shape but only implement `[desk]`, `[[station]]`, and `[cuesheet.*]` for now; parse-and-ignore the rest with a warning rather than erroring, so the README's full example loads on day one.

Resolution order: `./cuesheet.toml` → `~/.cuesheet/cuesheet.toml` → built-in defaults.

**Done when:** the exact TOML block from the README's Configuration section parses to a typed object with warnings for the unimplemented tables.

### Step 7 — Leash enforcement (`core`)
Pure function, no I/O, heavily tested:

```ts
checkPath(station, absPath): { allowed: boolean; reason?: string }
```

Rules: resolve to absolute → assert it's inside `workspace` (via `path.relative` not string prefix, so `../` escapes are caught) → deny globs win over allow globs → default deny outside `paths`.

Use `picomatch` against posix-normalized paths. Windows specifics that will bite: drive-letter casing, `\` vs `/`, 8.3 short names, and symlinks/junctions — call `fs.realpath` before checking.

**Done when:** tests cover `..` escape, `C:\` vs `c:\`, symlink-out-of-workspace, `**/*.env` deny beating `src/**` allow.

---

# Phase 2 · The daemon spine

### Step 8 — `cuesheetd` boots and serves health
Fastify + `@fastify/websocket`. Binds `127.0.0.1:7373`. On `EADDRINUSE`, exit with a clear message (don't silently pick another port — the CLI and app need to find it).

Write a **lockfile** at `~/.cuesheet/daemon.json` with `{ pid, port, version, startedAt }` so the CLI and Electron can discover a running daemon. Delete it on clean exit; on boot, if it exists, probe `/health` before assuming it's stale.

**Done when:** `curl 127.0.0.1:7373/health` returns `{ ok: true, version }` on both OSes.

### Step 9 — Event bus + WebSocket fan-out
An in-process `EventEmitter` wrapped in a typed `bus.emit(RunEvent)` / `bus.subscribe(fn)`. `GET /ws` upgrades and streams every `RunEvent` as JSON lines.

Add a replay buffer: on connect, send the last N events for any active run so a client that connects mid-run isn't staring at nothing.

**Done when:** `wscat` connected to `/ws` prints a synthetic event you emit from a test route.

### Step 10 — Run store (files)
```
~/.cuesheet/runs/<runId>/
  run.json       prompt, stations, status, timestamps, cost totals
  events.jsonl   append-only RunEvent log
  diff.patch     unified diff, written at the end
```

Interface `RunStore { create, append, get, list, finish }`. Append via a single serialized write queue — **do not** open concurrent append streams, Windows file locking is stricter than macOS and will throw `EBUSY`.

Run IDs: monotonic + sortable. Use a timestamp-prefixed id, not a bare counter.

**Done when:** a run written on one process is fully readable by a second process, and `events.jsonl` survives a hard kill mid-write (last line may be partial — the reader must tolerate that).

### Step 11 — The queue
Single-concurrency FIFO to start. `enqueue(cuesheet, prompt)` → `runId`. One run at a time, cues executed in declared order. No parallelism yet — parallel stations are a later problem and will otherwise dominate your debugging time now.

**Done when:** two rapid `enqueue` calls run sequentially and both produce complete run records.

### Step 12 — HTTP API surface
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

# Phase 3 · Harnesses

### Step 13 — The `Harness` interface (`harness`)
Implement exactly the shape in the README's "Writing a harness" section: `id`, `vendor`, `roles`, `probe()`, `usage()`, `contextFiles`, `writeConnectors()`, `run(ctx)`.

For now `usage()` and `writeConnectors()` may return empty — but they must exist so M2 and the connector registry are additive.

`RunContext` gives the harness: `brief`, `workspace`, `emit(ev)`, `meter`, and a **leashed fs facade**. The harness never touches `node:fs` directly.

**Done when:** the interface compiles and a `mock` harness implementing it passes a contract test.

### Step 14 — The `mock` harness
A fake harness that emits scripted events, writes one file, and returns a diff. **Build this before the real one.** It's how you develop the UI, the queue, and the run store without burning tokens or waiting on a real model.

**Done when:** `POST /runs` with the mock cuesheet produces a full run record in under a second.

### Step 15 — Cross-platform process spawning
`packages/harness/src/spawn.ts`:
- `cross-spawn` for execution.
- `which`-style resolution honoring `PATHEXT` on Windows, returning the resolved absolute path so probes can report a version.
- Kill semantics: on Windows, `child.kill()` does **not** kill grandchildren. Use `taskkill /pid <pid> /T /F`; on macOS, spawn detached and kill the process group (`process.kill(-pid)`).
- Line-buffered stdout parser tolerant of partial JSON lines and of `\r\n`.

**Done when:** a spawned `node -e "setInterval(()=>{},1e3)"` grandchild is provably dead after `stop` on both OSes.

### Step 16 — The `claude-code` harness
Shell out to the Claude Code CLI in headless mode with streaming JSON output. Confirm the exact flags against `claude --help` on your machine before wiring them — the surface moves. Map its stream events onto your `RunEvent` union; anything unrecognized becomes a `text` event rather than an error.

- `probe()` — resolve the binary, run `--version`, and detect logged-in state.
- `run()` — spawn in the workspace, stream, then compute the diff with `git diff` (git is already a stated requirement).

Keep the mapping layer thin and isolated. The README calls harness churn "the permanent tax"; the tax is only cheap if it's confined to one file.

**Done when:** a real prompt against a scratch git repo produces streamed text, a `diff.patch`, and a `done` event — on both OSes.

---

# Phase 4 · The Desk (web UI)

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

**Done when:** adding a Station in the UI results in a valid `[[station]]` block on disk and a new tile.

> **Milestone A — the app works in a browser.** Daemon running, `claude-code` station added through the UI, real run streamed to a tile, run record on disk. Do not proceed until this is true on **both** macOS and Windows.

---

# Phase 5 · Electron shell

### Step 21 — Main process
`packages/desktop`. Main process:
- `app.requestSingleInstanceLock()` — second launch focuses the first window.
- Starts the daemon **in-process** (import and call `startDaemon()`) rather than spawning a sidecar binary. One less packaging problem, one less orphaned process.
- Loads the built UI from `file://` in production, `http://localhost:5173` in dev.
- `contextIsolation: true`, `nodeIntegration: false`, a minimal preload exposing only `{ platform, chooseDirectory, daemonPort }`.

**Done when:** `npm run dev -w packages/desktop` opens a window running the Desk against the embedded daemon.

### Step 22 — Tray, notifications, start-on-login
- Tray icon: macOS wants a **template PNG** (`iconTemplate.png` + `@2x`, monochrome with alpha); Windows wants a **multi-size `.ico`**. Ship both; pick by `process.platform`.
- Native notification when a run finishes or raises a standby.
- `app.setLoginItemSettings({ openAtLogin })` behind a preference. Works on both targets.
- Close-to-tray on Windows, keep-in-dock on macOS.

**Done when:** the tray menu can show/hide the window and quit cleanly, leaving no stray process (check Activity Monitor / Task Manager).

### Step 23 — Clean shutdown
`before-quit` → stop the queue → kill every child process group → flush the run store → remove `daemon.json`. Any run interrupted this way is marked `interrupted`, not left `running` forever.

**Done when:** force-quitting mid-run and relaunching shows that run as `interrupted` with its partial events intact.

### Step 24 — Windows-specific pass
Set aside a session for these; they are all one-line fixes that each cost an afternoon if discovered during packaging:
- Long paths (>260 chars) in `node_modules` — enable long paths or keep the install path shallow.
- `app.setAppUserModelId()` or notifications silently don't appear.
- Antivirus and Defender slowing first-run spawn — probe with a timeout, don't hang the UI.
- Keyboard hints must read `Ctrl`, not `⌘`.

**Done when:** a fresh Windows VM runs the dev build with no manual fixes.

---

# Phase 6 · Packaging and CI

### Step 25 — `electron-builder`
Targets: `dmg` + `zip` (arm64 **and** x64) for macOS, `nsis` for Windows x64. Ensure the UI build output and the daemon's non-JS assets are in `files`; native modules, if you ever add one, need `asarUnpack`.

**Done when:** `npm run build -w packages/desktop` produces an installer on each OS that launches from a path with a space in it (`/Applications`, `C:\Program Files`).

### Step 26 — Signing, honestly
- **macOS:** unsigned builds get quarantined; users need `xattr -d com.apple.quarantine` or right-click-open. Fine for pre-alpha — document it. Notarization when you have a Developer ID.
- **Windows:** unsigned installers hit SmartScreen. Also fine for now — document it.

Don't let signing block Milestone B. Just don't pretend it isn't there.

**Done when:** README install notes match what a stranger actually experiences.

### Step 27 — CI matrix
GitHub Actions on `macos-latest` and `windows-latest`: install → typecheck → test → build the app. Upload installers as artifacts on tags.

**Done when:** a PR fails CI when a Windows-only path bug is introduced (add that as a test).

> **Milestone B — the app ships.** Downloadable installers for macOS and Windows that a person with Claude Code installed can open and use without reading a config reference.

---

## Deferred on purpose

Not in this plan; each one has a seam already cut for it:

| Deferred | Seam that makes it additive |
|---|---|
| SQLite run store | `RunStore` interface (Step 10) |
| `codex` / `ollama` harnesses | `Harness` interface (Step 13) |
| Limits strip, fallback routing | `usage()` already on the interface |
| Gates, reviewer role, verdicts | Cues are already an ordered list; a gate is a cue kind |
| Phone pairing, tailnet | The HTTP API is transport-agnostic (Step 12) |
| Commons, MCP recall | `contextFiles` already on the interface |
| Caller, On-Call | Both are cuesheets + a trigger over the existing queue |
| Linux builds | `electron-builder` target, not an architecture change |

---

## Cross-platform gotcha checklist

Keep this next to you; every item is something that works on macOS and fails on Windows.

- [ ] `.cmd` shims need `cross-spawn`, not `spawn`
- [ ] Killing a child does not kill grandchildren on Windows — `taskkill /T /F`
- [ ] Path separators: normalize to posix before any glob
- [ ] Drive-letter case and `fs.realpath` before leash checks
- [ ] `EBUSY` on concurrent file writes — serialize appends
- [ ] `\r\n` in stdout line parsers
- [ ] `~` is not expanded by the OS on Windows
- [ ] `MAX_PATH` 260-char limit
- [ ] Tray icon format differs (`Template.png` vs `.ico`)
- [ ] `setAppUserModelId` for notifications
- [ ] `⌘` vs `Ctrl` in every UI hint
- [ ] Paths with spaces in packaged builds

---

## Suggested order of attack

If you want the shortest path to something you can play with, do **Steps 1, 4, 5, 8, 9, 10, 11, 13, 14, 17, 18, 19** first. That's a daemon streaming a fake run into a real Desk in a browser — the whole shape of the app, with no models and no Electron. Everything after that is making it real.
