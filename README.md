<div align="center">

# Cuesheet

**The control room for every AI that writes your code.**

Cuesheet puts Claude Code, Codex, Ollama, and future coding agents behind one local control plane: shared projects, roles, permissions, review gates, usage limits, durable run records, and project memory.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Development](https://img.shields.io/badge/development-beta--track-blue.svg)](#project-status)
[![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Windows-desktop-black.svg)](#quick-start)

</div>

## Project status

> **Development is on the beta track. The latest published release is still [`v0.1.0-alpha`](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha).**

The current source is building toward `v0.5.0-beta`; it is not a beta release yet. The released installers are older unsigned alpha builds, while the source tree includes the newer multi-project, limits, routing, ledger, and Commons work described below.

| Area | Current source |
|---|---|
| Daemon and Desk | Working: HTTP/WebSocket daemon, Electron app, React UI, queues, live streams, durable run records |
| Harnesses | Claude Code and Codex run real work; Ollama is supported for the `worker` role |
| Safety and review | Roles, path leashes, two-vendor Gates, Holds, and stop/recovery behavior work |
| Projects | One daemon serves multiple isolated projects with independent config, history, queues, and events |
| Limits and cost | Usage reporting, pre-run refusal, role-safe fallback routing, and the project ledger work |
| Commons | Git-backed facts, approval inbox, byte-stable projections, and MCP `memory_search` / `memory_write` work |
| Still to build | Commons cross-machine sync, phone pairing, Caller, and On-Call |
| CLI | The `cuesheet` CLI package is currently empty; use the Desk or HTTP API |

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
  - [Codex CLI](https://developers.openai.com/codex)
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

### Install the alpha release

[`v0.1.0-alpha`](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha) provides a Windows x64 NSIS installer plus macOS DMG and ZIP builds for Apple Silicon and Intel.

Every commit pushed to GitHub also gets downloadable installers on the [Releases page](https://github.com/npyrz/Cuesheet/releases): pushes to `main` are published as production releases and marked Latest, while pushes to every other branch are published as prereleases. “Production” identifies the release channel; the version in the installer still identifies the app's maturity.

The installers are unsigned. macOS may require right-clicking the app and choosing **Open**; Windows SmartScreen may require **More info → Run anyway**.

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

The daemon is the product. The desktop shell, browser Desk, future phone client, and future CLI are all clients of the same project-scoped HTTP and WebSocket API. Anything the app can do must be possible through that API.

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
| `packages/cli` | Reserved for the future CLI; currently empty |

See [System design](docs/system-design/README.md) for diagrams and subsystem walkthroughs. Detailed concepts, configuration, harness notes, security, roadmap, and FAQ material live in the [reference](docs/REFERENCE.md).

## Contributing

Issues and pull requests are welcome, especially focused harness, cross-platform, usage-reporting, and review improvements. Read [AGENTS.md](AGENTS.md) for the repository's architecture and engineering rules, then run the full validation suite before submitting a change:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

CI runs all five checks on macOS and Windows.

Cuesheet has not been audited. Do not expose the daemon to an untrusted network. See [Security and privacy](docs/REFERENCE.md#security-and-privacy) before using it on sensitive repositories.

## License

[Apache-2.0](LICENSE), including an explicit patent grant.
