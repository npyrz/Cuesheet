# Cuesheet reference

This document holds the operational and technical detail that would otherwise
make the project README difficult to scan. Start with the [README](../README.md)
for the short introduction, see the [system design diagrams](system-design/)
for architecture, and use [PLAN-STEP.MD](../PLAN-STEP.MD) as the canonical
roadmap and status record.

> **Release status:** the latest packaged release is `v0.1.0-alpha`. The
> repository is on the beta development track, but it is not yet a beta
> release. The source can do substantially more than the published alpha
> installers.

## Contents

- [Install and run](#install-and-run)
- [Concepts](#concepts)
- [Configuration](#configuration)
- [Roles and leashes](#roles-and-leashes)
- [Harnesses](#harnesses)
- [Usage, routing, and the ledger](#usage-routing-and-the-ledger)
- [Gates](#gates)
- [The Commons](#the-commons)
- [HTTP and WebSocket API](#http-and-websocket-api)
- [Development](#development)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)

## Install and run

### Requirements

- Node.js 22 or newer and npm.
- Git. Cuesheet uses it for workspace diffs and for Commons history.
- macOS 13+ or Windows 10+. Linux may work from source, but it is not yet a
  tested, packaged target and remains on the 1.0 checklist.
- At least one supported harness installed. Authenticate with the harness's own
  CLI; Cuesheet does not ask for or store the model credential.

The currently shipped runtime integrations are:

| Harness | Runtime | Supported roles |
|---|---|---|
| `claude-code` | Claude Code CLI | engineer, reviewer, caller |
| `codex` | Codex CLI | engineer, reviewer, caller |
| `ollama` | Ollama | worker |
| `mock` | Built-in development harness | engineer, reviewer, worker |

The `caller` role exists in the type system and is declared by the two hosted
CLI harnesses, but the Caller workflow is not built yet. Ollama deliberately
accepts only the `worker` role.

### Published alpha installers

The [`v0.1.0-alpha` release](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha)
contains a Windows x64 NSIS installer and macOS DMG/ZIP builds for Apple
Silicon and Intel. They are unsigned:

- On macOS, right-click the application and choose **Open**, or remove the
  quarantine attribute with
  `xattr -d com.apple.quarantine /Applications/Cuesheet.app`.
- On Windows, SmartScreen may require **More info** then **Run anyway**.
- Do not select a non-empty install directory on Windows. The alpha
  uninstaller removes its selected directory; use the default or a dedicated
  empty folder.

Signing, notarization, and auto-update belong to the remaining beta release
work. The packaged alpha is also older than the current beta-track source, so
use a checkout when evaluating current project, limits, ledger, Gate, Ollama,
or Commons behavior.

### Run current source

```bash
git clone https://github.com/npyrz/Cuesheet.git
cd Cuesheet
npm install
npm run build
npm run dev -w packages/desktop
```

The Electron application embeds the daemon. To develop the browser UI instead,
run these in separate terminals:

```bash
npx cuesheetd
npm run dev -w packages/ui
```

The Vite development server is at `http://localhost:5173` and proxies API
requests to the daemon on `127.0.0.1:7373`.

To build local installers:

```bash
npm run dist -w packages/desktop
```

Artifacts are written under `packages/desktop/release`. Build installers on
the platform they target.

## Concepts

| Term | Meaning |
|---|---|
| Desk | The React control surface used by both the browser and Electron shell. |
| Project | A registered codebase with its own configuration, runs, queue, and event stream. |
| Station | One harness and model in one role, attached to a workspace and leash. |
| Harness | An adapter for a model runtime such as Claude Code, Codex, or Ollama. |
| Role | The Station's seat: `engineer`, `reviewer`, `worker`, or `caller`. |
| Leash | Workspace containment plus allowed and denied path globs. |
| Cuesheet | An ordered list of Station actions and Gate checks. |
| Gate | A policy decision over reviewer verdicts, findings, and vendor diversity. |
| Standby | A run waiting for a human `go` or `no` answer. |
| Commons | A local Git-backed store of durable Markdown facts projected into harness context files. |

One daemon serves every registered project. There is no daemon-side "active
project"; a project ID in the URL identifies the project. Switching the Desk
to another project does not stop a run.

## Configuration

The Desk can create Stations, but the underlying format is TOML. For a project
with ID `<id>`, configuration is resolved in this order:

1. `<project-root>/cuesheet.toml`
2. `~/.cuesheet/projects/<id>/cuesheet.toml`

The repository-local file is useful when a team wants to review and share its
Station layout. The home-directory fallback lets someone use Cuesheet without
adding a file to the repository.

### Complete schema example

The Stations, Gate, cuesheet, limits, and Commons approval policy below are
live. The later Caller, On-Call, trigger, and remote tables are included to
document the preserved schema only; the parser retains them with warnings, but
their product features are not implemented yet. Commons Git sync is configured
globally from the Desk or HTTP API, not from a project configuration.

```toml
[desk]
name = "api-team"

[[station]]
id        = "opus"
harness   = "claude-code"
role      = "engineer"
model     = "opus"
workspace = "~/code/api"
paths     = ["src/**", "tests/**"]
deny      = ["**/*.env", "infra/**", ".git/**"]

[[station]]
id        = "codex-review"
harness   = "codex"
role      = "reviewer"
workspace = "~/code/api"
paths     = ["src/**", "tests/**"]
deny      = ["**/*.env", "infra/**", ".git/**"]

[[station]]
id        = "backup-engineer"
harness   = "codex"
role      = "engineer"
workspace = "~/code/api"
paths     = ["src/**", "tests/**"]
deny      = ["**/*.env", "infra/**", ".git/**"]

[[station]]
id        = "local-worker"
harness   = "ollama"
role      = "worker"
model     = "qwen3-coder"
workspace = "~/code/api"
paths     = ["src/**", "tests/**"]
deny      = ["**/*.env", "infra/**", ".git/**"]

[gate.default]
require            = "1-of-1"
distinct_vendors   = 2
blocking           = ["security", "correctness"]
skip_if_diff_under = 20

[cuesheet.ship]
cues = [
  { station = "opus", action = "implement" },
  { station = "codex-review", action = "review", mode = "adversarial" },
  { gate = "default" },
  { station = "local-worker", action = "commit-message" },
]

[limits]
warn_at     = 0.85
block_at    = 0.97
when_capped = { opus = "backup-engineer" }

# Deferred workflow tables below: parsed and preserved, not executed today.
[caller]
station  = "opus"
budget   = 4000
autorun  = false
min_gate = "default"

[oncall]
enabled       = true
workspace     = "~/code/api"
branch_from   = "deployed"
budget        = 15000
max_per_hour  = 3
dedupe_window = "30m"
cues = [
  { station = "local-worker", action = "triage" },
  { station = "opus", action = "patch", require_failing_test = true },
  { station = "codex-review", action = "review", mode = "adversarial" },
  { gate = "hotfix" },
]

[[trigger]]
id     = "sentry"
kind   = "webhook"
match  = { level = "error", environment = "production" }
secret = "$SENTRY_WEBHOOK_SECRET"

[gate.hotfix]
require          = "1-of-1"
distinct_vendors = 2
blocking         = ["security", "correctness", "data-loss", "unreproduced"]
merges           = false

# Only approval is project configuration. Store, projection, MCP, and sync
# behavior are global and controlled by the daemon.
[commons]
store      = "~/.cuesheet/commons"
project_to = ["CLAUDE.md", "AGENTS.md"]
mcp        = true
approval   = "inbox"

[remote]
bind    = "127.0.0.1:7373"
tailnet = true
pairing = "qr"
```

Station IDs must start with an alphanumeric character and may contain letters,
digits, dots, dashes, and underscores. `paths` and `deny` are optional, but an
absent or empty allow list denies every path. Deny rules always win.

`warn_at` defaults to `0.85`, `block_at` to `0.97`, and `when_capped` to an
empty mapping. A fallback must keep the same role, and its harness must support
that role. Cuesheet refuses unsafe reseating instead of silently changing what
the step is allowed to do.

The parser currently implements `[desk]`, `[[station]]`, `[gate.*]`,
`[cuesheet.*]`, `[limits]`, and `[commons].approval`. The Commons MCP endpoint,
its Claude Code/Codex connector registration, and its Git remote are global
rather than controlled by this table. It preserves several
planned top-level tables while warning that they are not active: `[caller]`,
`[oncall]`, `[[trigger]]`, and `[remote]`. Do not treat a successfully parsed
deferred table as a working feature. Commons `store`, `sync`, `project_to`, and
`mcp` settings from older examples are also preserved but do not override the
built-in paths, repository remote, or automatic connector behavior.

## Roles and leashes

Roles are policy inputs, not just prompt labels, but enforcement is layered and
varies by harness.

| Role | Intended work | Current write posture |
|---|---|---|
| `engineer` | Change code inside its leash | Harness sandbox and leash determine reach. |
| `reviewer` | Read a diff and return a verdict | Codex runs read-only; Claude Code has no role-based sandbox of its own. |
| `worker` | Classification, summaries, commit messages, deduplication | The daemon refuses writes. |
| `caller` | Future plan proposal and phone interaction | Workflow not built; Codex would run read-only, while Claude Code declares no sandbox. |

A leash resolves a target against the Station workspace, rejects escapes to a
parent or another Windows drive, resolves symlinks where possible, applies deny
globs first, and then requires an allow glob. A non-glob directory rule such as
`src/config` includes that directory and its descendants. Windows matching is
case-insensitive and normalizes separators for glob evaluation.

There is an important boundary: the in-process workspace facade enforces every
read and write made through it. A harness that launches an external agent CLI
cannot force that subprocess's internal file tools through the facade. For
those harnesses, Cuesheet observes file events and also uses whatever sandbox
the vendor CLI provides. Codex supplies a read-only sandbox for reviewer and
caller roles; Claude Code does not supply an equivalent role sandbox. Configure
leashes defensively and do not describe them as OS-level isolation.

## Harnesses

The `Harness` interface is the main extension seam. A harness provides:

- `id`, `vendor`, and the roles it accepts;
- `probe()` for installation/authentication status;
- `usage()` for plan windows, where an empty answer is valid;
- `contextFiles` for Commons projections;
- `writeConnectors()`, currently allowed to be a no-op;
- `run()` for streamed work and a structured result; and
- optional `confinement(role)` describing the runtime's own sandbox.

Minimal shape:

```ts
import type { Harness, RunContext, RunResult } from "@cuesheet/harness";

export default {
  id: "my-agent",
  vendor: "acme",
  roles: ["engineer", "reviewer"],

  async probe() {
    return { installed: true, authed: true };
  },

  async usage() {
    return [];
  },

  contextFiles: [{ path: "MY_AGENT.md", scope: "project" }],

  confinement(role) {
    return role === "reviewer" ? "read-only" : "workspace-write";
  },

  async writeConnectors(_connectors) {},

  async run(ctx: RunContext): Promise<RunResult> {
    ctx.emit({ t: "text", chunk: "Starting\n" });
    return { diff: await ctx.workspace.diff(), cost: ctx.meter.total() };
  },
} satisfies Harness;
```

Export and register a built-in from `packages/harness/src/index.ts`; the daemon
adapts that registry in `packages/daemon/src/runtime.ts`. Keep vendor stream
parsing based on captured, scrubbed fixtures rather than remembered formats.
Harnesses must not import one another, and the daemon—not an individual
harness—owns Gates, queues, project scope, and run persistence.

`vendor` affects behavior: a Gate's `distinct_vendors` check counts the vendors
of Stations that actually acted. It is not display-only metadata.

## Usage, routing, and the ledger

`GET /api/usage` is global because a vendor plan window is shared across
projects. Each usage window explicitly says whether it is measured,
not-blocked, unmetered, or unknown. Cuesheet does not turn missing data into a
confident zero.

Current reporting is necessarily uneven:

- Claude Code exposes limit information only inside a running stream, so its
  reading is historical and includes when it was seen.
- Codex reports token usage but no plan-cap window through the captured stream,
  so its plan status is unknown.
- Ollama is local and reports an unmetered window.

Only a measured fraction can trigger `warn_at`, `block_at`, or fallback
routing. Unknown, not-blocked, and unmetered states never block a run. Routing
is resolved before the pre-run limit check and again before each step because a
long cuesheet may cross a cap while running.

The ledger is per project because spend belongs to the work that caused it. It
aggregates by day, vendor, and Station and retains cache-read/cache-write
breakdowns when the harness reports them. Older records that predate
per-Station accounting remain visible as unsplit spend.

## Gates

A Gate evaluates all verdicts recorded so far, the Stations that acted, and the
current workspace diff.

- `require = "N-of-M"` requires at least `N` passing verdicts. An abstention,
  unreadable review, or crashed reviewer is not a pass.
- `blocking` lists finding categories that hold the run even if the numerical
  approval tally passes.
- `distinct_vendors` counts the author and reviewers that actually acted, not
  only verdict authors. This makes `1-of-1` with two distinct vendors useful:
  one vendor authored the change and another reviewed it.
- `skip_if_diff_under` counts inserted plus deleted lines and skips the Gate
  when the diff is smaller than the configured threshold.

A failed Gate ends the current run as `held`; a hold is terminal. Continuing
after a hold means starting a new run, preserving the original decision in
history.

## The Commons

The implemented Commons is one local repository at `~/.cuesheet/commons`. Each
fact is a Markdown file with TOML frontmatter containing its title, tags,
project IDs, and provenance (Station, run, and timestamp when available).
Writes and removals are committed to the Commons Git repository. If Git is not
available, the fact remains a file and the API reports why history could not be
recorded.

Agent-written captures do not enter that repository immediately. By default
they are JSON drafts under `~/.cuesheet/commons-inbox`, outside the Git working
tree and outside every projection. The Desk's **inbox** view shows provenance
and lets a person edit the proposed fact id, title, body, tags, and project
scope before approving it, or discard it. Approval writes and commits the fact,
regenerates projections, and removes the draft only after those operations
succeed. A failed approval remains pending and can be retried.

`approval = "inbox"` is the default even when `[commons]` is absent. A project
may explicitly opt into `approval = "auto"`; captures from that project then
go directly through the committed fact and projection path. Auto approval is
never inferred from an omitted setting.

Facts with project IDs are projected into that project's context files. Facts
with no project IDs are user-scoped. Built-in projections are:

| Harness | Project context | User context |
|---|---|---|
| Claude Code | `<project>/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| Codex | `<project>/AGENTS.md` | `~/.codex/AGENTS.md` |
| Ollama | none | none |

Cuesheet replaces only the content between
`<!-- cuesheet:begin -->` and `<!-- cuesheet:end -->`; text outside those
markers remains untouched. Facts are ordered deterministically, and an
unchanged projection is not rewritten. This byte stability protects both clean
Git diffs and prompt caching.

Implemented today:

- create, read, list, delete, and history routes;
- provenance in fact files and commit messages;
- project/user scoping;
- byte-stable `CLAUDE.md` and `AGENTS.md` projection;
- a persistent approval inbox with edit, approve, discard, and explicit
  per-project auto approval;
- MCP `memory_search` / `memory_write`; and
- pull/push sync through a Git `origin` the operator controls.

Configure sync in the Desk's **Memory inbox** or with
`PUT /api/commons/sync`. Pull uses Git's normal merge machinery. A textual conflict
is left in the Commons working tree, returned as a list of paths, and shown in
the Desk; Cuesheet never chooses one side. Edit those files, then use **continue
after resolution** (or `POST /api/commons/sync/continue`) to record the merge.
Successful pulls and resolutions regenerate projections. HTTPS credentials in
a remote URL are redacted from API responses.

Writing to a context file that has incomplete or duplicated Cuesheet markers is
refused rather than risking damage to hand-written content.

## HTTP and WebSocket API

The standalone daemon listens on `127.0.0.1:7373` by default. Routes are
available both at the root and under `/api`; the tables use `/api`, which is
the browser Desk's normal surface through the Vite proxy.

### Global routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Process health and daemon version. |
| `GET` | `/api/usage` | Cached usage from every registered harness. |
| `GET` | `/api/commons` | List Commons facts. |
| `POST` | `/api/commons` | Write a fact and regenerate projections. |
| `GET` | `/api/commons/inbox` | List pending agent-captured memories. |
| `POST` | `/api/commons/inbox/:id/approve` | Approve a pending memory, applying optional edits first. |
| `DELETE` | `/api/commons/inbox/:id` | Discard a pending memory without touching projections. |
| `GET` | `/api/commons/:id` | Read one fact. |
| `DELETE` | `/api/commons/:id` | Remove one fact and regenerate projections. |
| `GET` | `/api/commons/history?limit=50` | Read abbreviated Commons Git history. |
| `GET` | `/api/commons/sync` | Read local remote, branch, merge, and conflict status without network access. |
| `PUT` | `/api/commons/sync` | Add or replace `origin` with `{ "remote": "..." }`. |
| `POST` | `/api/commons/sync/pull` | Fetch and merge, regenerating projections after a clean result. |
| `POST` | `/api/commons/sync/push` | Push the current Commons branch. |
| `POST` | `/api/commons/sync/continue` | Commit a human-resolved merge and regenerate projections. |
| `POST` | `/api/standbys/:id` | Answer a standby with `{ "answer": "go" }` or `{ "answer": "no" }`. |

### Project routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List registered projects. |
| `POST` | `/api/projects` | Open/register a root with `{ "root": "...", "name": "..." }`. |
| `GET` | `/api/projects/:id` | Read one registry entry. |
| `DELETE` | `/api/projects/:id` | Forget the entry; never delete the project or run records. |
| `GET` | `/api/projects/:id/stations` | List configured Stations with probe and confinement information. |
| `POST` | `/api/projects/:id/stations` | Add a Station and reload project configuration. |
| `POST` | `/api/projects/:id/commons/captures` | Capture a run memory under the project's inbox/auto policy. |
| `GET` | `/api/projects/:id/runs?limit=50` | List newest runs. |
| `POST` | `/api/projects/:id/runs` | Queue `{ "prompt": "...", "cuesheet": "optional-name" }`. |
| `GET` | `/api/projects/:id/runs/:runId` | Read run metadata and events, excluding the patch body. |
| `GET` | `/api/projects/:id/runs/:runId/diff` | Read the unified diff as plain text. |
| `POST` | `/api/projects/:id/runs/:runId/stop` | Stop a queued, active, or waiting run. |
| `GET` | `/api/projects/:id/ledger?since=...&until=...` | Read project spend aggregates. |
| `WS` | `/api/projects/:id/ws` | Replay buffered project events, then stream live events. |

Example:

```bash
curl http://127.0.0.1:7373/api/projects

curl -X POST http://127.0.0.1:7373/api/projects/PROJECT_ID/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"add a focused regression test","cuesheet":"ship"}'
```

The user-facing `cuesheet` command is not implemented yet. Do not copy CLI
examples from old design material and expect them to run; use the Desk or API.

## Development

Install dependencies once, then use the root scripts:

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

CI runs the last five commands in that order on macOS and Windows. A green
build is not a substitute for typechecking: the desktop package is bundled by
esbuild, which strips types.

Useful focused commands:

```bash
npx vitest run packages/daemon/src/server.test.ts
npx vitest run packages/daemon -t "keeps a run started in one out of the other's list"
npx vitest
```

Live harness tests require authenticated vendor CLIs and are opt-in:

```bash
CUESHEET_E2E=1 npm test
```

Captured fixtures under `packages/harness/src/fixtures` are the standing CI
verification for real stream shapes. Tests that call `startDaemon` must pass an
isolated environment and should use `port: 0` so parallel workers neither write
the developer's real registry nor contend for port 7373.

Package dependency direction is strict:

```text
core <- harness <- daemon <- ui / cli / desktop
```

The daemon owns product behavior. A feature available only inside Electron is
an architectural bug; clients should use the daemon API.

### Local data layout

The default state root is `~/.cuesheet` (also under the user's home directory
on Windows):

```text
~/.cuesheet/
├── daemon.json
├── projects.json
├── commons/
├── commons-inbox/
└── projects/
    └── <project-id>/
        ├── cuesheet.toml
        └── runs/
            └── <run-id>/
                ├── run.json
                ├── events.jsonl
                └── diff.patch
```

A repository-local `cuesheet.toml` overrides the private per-project copy.
Run metadata is written atomically; events are append-only. On restart, runs
left non-terminal by a crash are reconciled to `interrupted`.

## Security and privacy

Current, verifiable properties:

- The daemon binds to IPv4 loopback by default.
- Cuesheet shells out to CLIs authenticated by the user; it does not proxy or
  store their model API credentials.
- Project registry, run records, and Commons facts are local files.
- The Commons MCP server shares the daemon's loopback-only HTTP listener.
- Commons sync talks directly to the operator's configured Git remote. Cuesheet
  has no hosted relay, account, or telemetry path, and Git owns authentication.
- File-backed IDs are validated before they are used as path segments.
- In-process workspace access resolves containment and symlinks before applying
  leash rules.
- Codex receives role-derived sandbox flags; Claude Code does not provide an
  equivalent role sandbox through this integration.

Important limits:

- The daemon API has no authentication layer. Keep it on loopback and do not
  expose port 7373 to an untrusted network.
- Phone pairing, short-lived device tokens, and tailnet serving are planned,
  not present.
- Secret redaction before prompts or diffs leave the machine is planned, not
  present. Vendor CLIs receive the material required for the run under their
  own account and product terms.
- A leash is not a container. External agent CLIs have their own file and
  command tools; enforcement is only as strong as the daemon checks plus the
  sandbox the chosen CLI actually provides.
- Cuesheet has not undergone a security audit.

Treat configured agent CLIs as code-execution tools, keep deny rules around
secrets and infrastructure, review Gate findings, and inspect the durable run
record when something unexpected happens.

## Troubleshooting and FAQ

### The app says no harness is installed

Run the vendor CLI's version command in the same environment that launches
Cuesheet, then authenticate with that CLI. PATH differences are common when an
application is launched from Finder or Explorer instead of a terminal. Claude
Code has no cheap authentication-status command, so its probe confirms the
binary and a run reports an authentication failure if the session is invalid.

### Ollama is installed but unavailable

Start the Ollama service and verify it answers at `127.0.0.1:11434`, or set
`OLLAMA_HOST`. Pull at least one model. The integration intentionally uses
IPv4 loopback because `localhost` can resolve to IPv6 first on Windows while
Ollama is listening only on IPv4.

### A Station cannot write anything

Check all three layers:

1. A `worker` role always has writes refused by the daemon.
2. An empty or absent `paths` list defaults to deny.
3. A matching `deny` glob wins over any allow glob.

For Codex, reviewer and caller roles also receive the CLI's read-only sandbox.

### I switched projects and the run disappeared

It did not stop. Runs belong to projects, and the WebSocket is project-scoped.
Switch back to the original project to see its record and stream.

### The usage strip does not show a percentage

That is usually the honest result, not a probe failure. Codex exposes no plan
window in the captured stream. Claude Code reports useful limit state only
inside runs, and local Ollama is unmetered. Only a real measured fraction is
drawn and allowed to block work.

### A Gate held even though one reviewer passed

Inspect all three independent conditions: the `N-of-M` approval count,
blocking finding categories, and distinct vendors among all participants. Any
one can hold the run. An abstention never counts as approval.

### A Commons write succeeded but was not committed

The write response includes `committed` and, when false, a reason. Install Git
and make sure it is executable from Cuesheet's PATH. The store writes facts
even when Git history is unavailable.

### Why did an agent memory not appear in `CLAUDE.md`?

Open the Desk's **inbox** view. Agent captures wait there by default and do not
enter any context file until approved. You can edit the proposed fact before
approving it or discard it. A project only skips this review when its config
explicitly contains `[commons] approval = "auto"`.

### Why are my hand-written `CLAUDE.md` or `AGENTS.md` sections still there?

That is intentional. Cuesheet owns only its marked block. If marker pairs are
damaged or duplicated, fix them manually before the next projection can run.

### Commons sync stopped on a conflict

This is deliberate. Open the paths listed in the Desk under **Cross-machine
sync**, keep the correct parts of both sides, remove Git's conflict markers,
and click **continue after resolution**. Normal Commons writes will not create
new history while a merge remains unresolved.

### Can Cuesheet run fully offline?

Yes with Ollama, but the shipped Ollama harness is worker-only. Hosted CLI
harnesses communicate with their vendors as they normally do. A multi-vendor
Gate therefore requires the relevant external CLIs and connectivity.

### Can I use the documented CLI commands?

No. `packages/cli` is currently an empty package. The Desk and HTTP API are the
working control surfaces. Building the CLI is part of the remaining beta work.

### What is next?

[PLAN-STEP.MD](../PLAN-STEP.MD) is the status of record. It distinguishes
completed beta-track work from the beta release bar and from later features;
this reference deliberately does not duplicate that moving sequence.
