# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install                  # Node >= 22, npm workspaces
npm run build                # all packages, in dependency order
npm run typecheck            # tsc --noEmit per workspace
npm run lint                 # eslint .
npm run format:check         # prettier --check .
npm test                     # vitest run
```

CI (`macos-latest` + `windows-latest`) runs exactly those five, in that order. Run them all before declaring work done.

**`npm run build` does not typecheck everything.** `packages/desktop` is bundled with esbuild, which strips types without checking them, so a type error there survives a green build. `npm run typecheck` is the real check.

**Rebuild `core` before typechecking a package that depends on it.** Workspaces resolve each other through `dist/`, not source, so a new export in `packages/core` is invisible to `daemon`/`harness`/`ui` until you run `npm run build -w @cuesheet/core`. The symptom is `has no exported member 'X'` for something you just wrote.

### Running a single test

```bash
npx vitest run packages/daemon/src/server.test.ts
npx vitest run packages/daemon -t "keeps a run started in one out of the other's list"
npx vitest                                  # watch mode
```

Vitest collects `packages/*/src/**/*.test.ts` only — tests are colocated with their source, and `.tsx` files are not collected.

### Tests that skip themselves

- `CUESHEET_E2E=1 npm test` enables live harness runs against real CLIs (`Codex`, `codex`). **These never run in CI** — there is no logged-in CLI there — so captured fixtures in `packages/harness/src/fixtures/` are the standing verification.
- Windows-only and symlink-only suites gate on `process.platform` / probe support.

### Running the app

```bash
npm run dev -w packages/desktop       # Electron shell with the daemon embedded
npm run dev -w packages/ui            # Vite on :5173, proxying /api to the daemon
npx cuesheetd                         # daemon alone on 127.0.0.1:7373
```

## Architecture

**The daemon is the product.** `packages/daemon` exposes an HTTP + WebSocket API; the Desk, the Electron shell, the (empty) CLI and the future phone are all clients of exactly those routes. Anything that only the desktop app can do is a design error — if the app can do it, it is an HTTP call.

Dependency direction is strict: `core` ← `harness` ← `daemon` ← `ui` / `cli` / `desktop`.

| Package | Owns |
|---|---|
| `core` | Domain types, zod config schema + loader, leash checks, gate/verdict evaluation, project registry, Commons fact format, cross-platform path helpers |
| `harness` | The `Harness` interface, the registry, and the built-in harnesses (`mock`, `Codex`, `codex`) |
| `daemon` | `cuesheetd` — routes, per-project runtimes, run queue/store, event bus, standbys, Commons store, projections and MCP recall |
| `ui` | The Desk (React + Vite). One build, three consumers: browser, Electron, later the phone |
| `desktop` | Electron main + preload. **CJS, bundled by esbuild** — the only package that is not ESM |
| `cli` | `export {}`. The README documents commands that do not exist yet |

### The `Harness` interface is the central seam

Defined in `packages/harness/src/types.ts`: `id`, `vendor`, `roles`, `probe()`, `usage()`, `contextFiles`, `writeConnectors()`, `run()`. The deferred features arrived through those seams: limits consume `usage()`, local models implement the same runner, and Commons projections now consume `contextFiles`. `contract.ts` exercises any harness against the contract structurally and behaviourally.

**`vendor` is load-bearing, not metadata.** A Gate's `distinct_vendors = 2` is an equality check over it, so a test asserts the default registry always ships at least two distinct non-`mock` vendors.

**Harnesses never import each other.** When two need the same helper it moves out — that is why `observe.ts` exists.

**Stream mapping is written against captured real streams, never from memory.** This is a hard project rule. Capture a run to `fixtures/*.jsonl`, scrub it, then write the mapper. Vendors disagree in ways that look symmetric and are not: Codex's token fields are additive while Codex's are inclusive, and summing both would double-bill every run.

### Projects (Phase 8)

**One daemon serves many projects — never one daemon per project.** The port is fixed so every client finds *the* daemon.

- `~/.cuesheet/projects.json` is the registry; `createProjectRegistry` in `core/project.ts` owns it.
- A `ProjectRuntime` (`daemon/projects.ts`) holds one project's config, reload closure, run store, queue and event bus. Built lazily on first touch, memoized **by promise inserted synchronously** before any `await` — otherwise concurrent cold requests each build a queue over one store root.
- Routes are `/projects/:id/...`. `/health` and `/standbys/:id` stay global.
- Each project has its own `EventBus`, mirrored into a daemon-wide one. `DaemonHandle.bus` is interleaved across projects — fine for the tray, wrong for a client rendering one project.
- **The daemon has no "active project."** Which one a client is looking at is a path segment. Adding daemon-side current-project state breaks switching.
- Config resolves nearest-first: `<root>/cuesheet.toml`, then `~/.cuesheet/projects/<id>/cuesheet.toml`.
- Run store root is per project, which keeps `list()` answering off `readdir` alone.

### Roles, leashes, gates

Roles (`engineer`, `reviewer`, `worker`, `caller`) change *permissions*, not prompts, and are enforced by the daemon plus the CLI's own sandbox flag — never requested in a prompt. A harness that shells out can only *observe* paths, not enforce them: a write inside a shell command is invisible, which is why the subprocess sandbox is set from the Station's role.

Gate semantics worth knowing before touching `core/gate.ts`: an unreadable review **abstains** and cannot satisfy `require`; `held` is terminal (releasing a Hold is a new run); `distinct_vendors` counts who *acted*, author included.

### Cross-platform rules

Windows is a first-class target and most bugs found here were Windows bugs.

- **`pathFor(env)` for layout and string math; ambient `nodePath` for anything that reaches disk.** `node:fs` is bound to the real host, so resolving a POSIX path with `path.win32` yields backslashes the filesystem cannot find.
- Platform behaviour is tested by **injecting `HostEnv`**, never by mocking `process.platform` — mocking it does not change which `path` implementation is bound, so the test passes for the wrong reason.
- `realpath` before comparing paths. macOS resolves `/tmp` → `/private/tmp`, and a test that skips this fails for reasons unrelated to the code.
- Spawn through `cross-spawn`, never `shell: true` — `Codex`/`codex` are `.cmd` shims on Windows.
- `PLAN-STEP.MD` keeps a cross-platform gotcha checklist. Ticked means *exercised on a Windows machine*, not *handled in code*.

### Testing conventions

- **A test calling `startDaemon` must pass an isolated `env`**, or it writes into the developer's real `~/.cuesheet/projects.json`. The failure is invisible locally and permanent.
- `port: 0` binds ephemerally so suites run in parallel workers.
- Wait on conditions, never on fixed timeouts — a runner under load does not finish an HTTP round trip plus a queue turn inside 20ms. Both `server.test.ts` and `queue.test.ts` carry a `waitFor` helper for this.

## Conventions

- Comments explain **why**, not what, and record the decision that was nearly taken the other way. Match that density; it is the house style, not decoration.
- `exactOptionalPropertyTypes` is on. Config-shaped types are **inferred from their zod schemas** (`config.ts`) rather than hand-written, because a hand-written `{ model?: string }` is not assignable from zod's `{ model?: string | undefined }`. Runtime/wire types in `types.ts` are hand-written.
- `@typescript-eslint/consistent-type-imports` is enforced — use `import type`.
- Unused variables must be prefixed `_`.
- **Markdown is deliberately excluded from Prettier** (`.prettierignore`) because it reflows the hand-aligned ASCII diagrams and tables in the README into mush.

## The two documents that govern

- **`README.md`** is the design spec and the contract — it describes what Cuesheet is being built to be. Its "What actually works right now" table is the honest list. Keep both true when behaviour changes.
- **`PLAN-STEP.MD`** is the build plan *and* the status of record. Phases carry step-by-step "Done when:" criteria and retrospectives on what the work actually settled.
  - **Numbering rule: done is frozen, unbuilt renumbers freely** — a phase number always equals its position in the running order.
  - Do not tick a "Done when" clause the work did not actually prove. Where a criterion belongs to a later step, say so explicitly; the document has a retrospective about the cost of quietly redefining one.
  - Treat a recorded blocker as possibly stale. A *design* blocker stays blocked until someone thinks; an *environment* blocker expires silently and nothing in the document knows it has. Check which kind it is before believing it.
