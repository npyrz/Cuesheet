<div align="center">

# Cuesheet

**The control room for every AI that writes your code.**

Cuesheet puts Claude Code, Codex, Ollama, and future coding agents behind one local control plane: shared projects, roles, permissions, review gates, usage limits, durable run records, and project memory.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Development](https://img.shields.io/badge/development-beta--track-blue.svg)](#project-status)
[![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Windows-desktop-black.svg)](#quick-start)

</div>

## Project status

> **Development is on the beta track. The latest named milestone is still [`v0.1.0-alpha`](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha).**

The current source is building toward `v0.5.0-beta`; it is not a beta release yet. The published installers are unsigned alpha and development builds, while the source tree includes the newer multi-project, limits, routing, ledger, and Commons work described below.

| Area | Current source |
|---|---|
| Daemon and Desk | Working: HTTP/WebSocket daemon, Electron app, React UI, queues, live streams, durable run records in a per-project SQLite store |
| Harnesses | Claude Code and Codex run real work; Ollama is supported for the `worker` role |
| Safety and review | Roles, path leashes, two-vendor Gates, Holds, and stop/recovery behavior work |
| Projects | One daemon serves multiple isolated projects with independent config, history, queues, and events |
| Limits and cost | Usage reporting, pre-run refusal, role-safe fallback routing, the project ledger, and an estimated audit of what always-loaded context costs each run work |
| Commons | Git-backed facts, approval inbox, projections, MCP recall, and operator-owned remote sync work |
| Still to build | Phone pairing, Caller, and On-Call |
| CLI | The `cuesheet` command registers projects and controls runs through the daemon API |
| Upgrades | All five published releases have captured profiles, including SQLite/WAL history. Config, registry and run store are versioned; incompatible file-backend selection refuses before hiding SQLite history |
| Local diagnostics | Durable crash/run context and a previewable report in the Desk; copy/download stays local until you attach it |
| Source updates | App, browser and CLI check published GitHub releases; `npm run update` fast-forwards and rebuilds a stopped, clean checkout. Signed installers are optional |

For exact completion criteria and the next build step, see [PLAN-STEP.MD](PLAN-STEP.MD).

## Why Cuesheet

Coding agents are good at doing work, but each vendor brings its own session model, memory, limits, and controls. Cuesheet owns the durable layer around them:

- **One desk:** see every Station, run, finding, and cost in one place.
- **Replaceable harnesses:** switch models or vendors without rebuilding your workflow.
- **Enforced roles:** engineers, reviewers, and workers get different permissions, not merely different prompts.
- **Independent review:** Gates can require a second vendor before work passes.
- **Local control:** the daemon, repositories, history, and credentials stay on your machine.
- **Shared memory:** Commons facts project into each harness's context and remain searchable through MCP without being pasted into every prompt.

## Quick start

### Requirements

- Node.js 22 or newer and Git.
- macOS 13+ or Windows 10+. Linux support is planned but is not yet a tested,
  packaged target.
- At least one installed and authenticated harness:
  - [Claude Code](https://claude.com/claude-code)
  - [Codex CLI](https://github.com/openai/codex)
  - [Ollama](https://ollama.com)

Cuesheet invokes CLIs you authenticated yourself; it does not store or proxy model credentials.

### Run the current source

```bash
git clone https://github.com/npyrz/Cuesheet.git
cd Cuesheet
npm install
npm run build
npm run dev -w packages/desktop
```

The app opens on the project launcher. Add or open a project, add a Station, choose its harness and role, point it at a workspace, and start a run from the Desk.

For browser development, run the daemon and UI separately:

```bash
npx cuesheetd
npm run dev -w packages/ui
```

Then open `http://localhost:5173`.

### Use the terminal client

From the built source checkout, start `npx cuesheetd` in one terminal. In
another, register a project and copy the id it prints:

```bash
npx cuesheet project add /path/to/your/project
npx cuesheet stations --project PROJECT_ID
npx cuesheet run --project PROJECT_ID --cuesheet ship "Add a regression test"
npx cuesheet runs --project PROJECT_ID
npx cuesheet show RUN_ID --project PROJECT_ID
```

The named cuesheet must exist in that project's `cuesheet.toml`; omit
`--cuesheet ship` to use its first configured Station. `run` queues work and
prints its id. From inside a registered project, including a subdirectory, the
`--project` option is optional. `cuesheet stop RUN_ID` stops a run,
`cuesheet rewind RUN_ID` undoes a finished run's own changes (`--check` only
reports whether it would apply), `cuesheet context` estimates what the
project's always-loaded context files cost each run, and `cuesheet answer STANDBY_ID go|no` answers
a waiting Gate. The terminal client uses the running daemon; it does not start
a second one.

### Install the alpha release

[`v0.1.0-alpha`](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha) provides a Windows x64 NSIS installer plus macOS DMG and ZIP builds for Apple Silicon and Intel.

The release workflow builds unsigned convenience installers by default. Signing is an optional configuration for prebuilt installers; it is not required to clone and run Cuesheet. Existing unsigned downloads may need macOS **Open** or Windows SmartScreen's **More info → Run anyway**.

### Update a source checkout

The app and standalone daemon check this repository's published GitHub releases at startup and every four hours. Check from the app menu, the Desk's updates control, or `npx cuesheet updates`. To check without starting Cuesheet:

```bash
npm run update:check
```

Stop the app or daemon and any Vite dev server, then run this from the Cuesheet checkout:

```bash
npm run update
```

The script fetches the exact published release tag, fast-forwards a clean checkout, installs locked dependencies and rebuilds. Restart the app or daemon afterward. It refuses local changes, divergent history and downgrades; projects and run history remain under `~/.cuesheet`. A branch prerelease can be selected explicitly with `npm run update -- --tag RELEASE_TAG`. See [source updates and optional installers](docs/releases.md) for recovery and release details.

> **Windows:** install into the default directory or another empty directory. The alpha uninstaller removes its installation directory wholesale, so do not install it into a folder containing other files.

## Configuration

A **Station** combines one harness, model, role, workspace, and leash. A project can use several Stations in an ordered cuesheet:

```toml
[[station]]
id        = "engineer"
harness   = "claude-code"
role      = "engineer"
workspace = "."
paths     = ["src/**", "tests/**"]
deny      = ["**/*.env", ".git/**"]

[[station]]
id        = "reviewer"
harness   = "codex"
role      = "reviewer"
workspace = "."
paths     = ["src/**", "tests/**"]
deny      = ["**/*.env", ".git/**"]

[gate.default]
require          = "1-of-1"
distinct_vendors = 2
blocking         = ["security", "correctness"]

[cuesheet.ship]
cues = [
  { station = "engineer", action = "implement" },
  { station = "reviewer", action = "review" },
  { gate = "default" },
]
```

The engineer produces a diff, the reviewer evaluates it independently, and the Gate either passes the run or holds it with structured findings. Every event and artifact is retained in the run record.

## Architecture

The daemon is the product. The desktop shell, browser Desk, terminal client, and future phone client all use the same project-scoped HTTP and WebSocket API. Anything the app can do must be possible through that API.

Dependency direction stays one-way:

```text
core <- harness <- daemon <- ui / cli / desktop
```

| Package | Responsibility |
|---|---|
| `packages/core` | Domain types, config, leashes, Gates, projects, Commons formats |
| `packages/harness` | Harness contract and runtime integrations |
| `packages/daemon` | API, project runtimes, queues, events, run store, Commons |
| `packages/ui` | Shared React Desk |
| `packages/desktop` | Electron host for the Desk and embedded daemon |
| `packages/cli` | Terminal client for projects, Stations, runs, and standbys |

See [System design](docs/system-design/README.md) for diagrams and subsystem walkthroughs. Detailed concepts, configuration, harness notes, security, roadmap, and FAQ material live in the [reference](docs/REFERENCE.md).

## Contributing

Issues and pull requests are welcome, especially focused harness, cross-platform, usage-reporting, and review improvements. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup and PR expectations, or [the harness guide](docs/harnesses.md) to add a runtime. [AGENTS.md](AGENTS.md) contains the engineering rules. Run the full validation suite before submitting a change:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Open **local diagnostics** on the launch screen, or **diagnostics** in an open project's top bar (also in the command palette), to preview, copy or download a bug report. Add your reproduction steps and review the text before attaching it. Cuesheet does not upload reports.

The log is at `~/.cuesheet/diagnostics/events.jsonl` (`%USERPROFILE%\.cuesheet\diagnostics\events.jsonl` on Windows), with two rotated copies and a session checkpoint beside it. It records runtime versions, timestamps, run IDs, hashed project/Station identifiers, state transitions, error classes, known OS error codes and path-free stack locations. Prompts, tool payloads, source, diffs, credentials and error messages are excluded. This is a separate diagnostic record; ordinary run history still contains the work you asked the harness to do. A forced kill cannot write a final stack trace; the last persisted context and next-start recovery identify what was interrupted. If the app cannot reopen, those diagnostic files can be inspected locally and attached after review. Logs rotate at 512 KiB, keeping the current file and two older files.

Every client can read `GET /diagnostics` (local path and availability) and `GET /diagnostics/report` (downloadable text); the same routes exist under `/api`. With a standalone daemon running, export from a terminal:

```bash
curl --fail http://127.0.0.1:7373/diagnostics/report -o cuesheet-diagnostics.txt
```

CI runs all five checks on macOS and Windows. Use the [bug report form](https://github.com/npyrz/Cuesheet/issues/new?template=bug_report.yml) for reproducible defects. See the [code of conduct](CODE_OF_CONDUCT.md) and [changelog](CHANGELOG.md).

Cuesheet has not been audited. Do not expose the daemon to an untrusted network. Report vulnerabilities through [SECURITY.md](SECURITY.md), which describes the private disclosure route and current boundaries. See [Security and privacy](docs/REFERENCE.md#security-and-privacy) before using it on sensitive repositories.

## License

[Apache-2.0](LICENSE), including an explicit patent grant.
