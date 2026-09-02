<div align="center">

# Interlock

**Two models. Two vendors. One gate.**

A control deck for AI coding agents — pick your engineer, pick a reviewer from a *different* company, give them a shared memory, and drive the whole thing from your desk or your phone.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-orange.svg)](#project-status)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](#requirements)

</div>

---

> **Project status: pre-alpha.** Nothing here is shippable yet. This README is the design spec and the contract — it describes what Interlock is being built to be. See [Roadmap](#roadmap) for what actually exists.

---

## The ten-second version

You have Claude Code, Codex, and a couple of local models on Ollama. Today they are three separate terminals that know nothing about each other, remember nothing between sessions, and can't check each other's work.

Interlock turns them into one crew:

```bash
interlock run "add rate limiting to the upload endpoint" \
  --engineer opus \
  --review   codex \
  --gate     default
```

Claude Opus writes it. Codex — a model from a different company, with its own context and its own blind spots — reviews it adversarially. The **gate** decides whether the diff is accepted or **trips**. Everything all three of them learned lands in a shared memory both vendors can read tomorrow. And you can watch it happen from your phone.

---

## Why this exists

Three problems, none of which any single vendor is going to solve for you.

**A model reviewing its own work shares its own blind spots.** Self-review is not review — it inherits the same training, the same failure modes, and the same sycophancy that produced the bug. A second opinion is only worth something when it comes from a differently-trained model. Interlock makes cross-vendor review a structural property of a run, not a habit you have to remember.

**There is no portable memory between agents.** Claude Code keeps `CLAUDE.md` plus per-project file memory. Codex keeps `AGENTS.md` plus its own generated memories. Ollama keeps nothing at all. None of them can read the others', and the industry has no standard schema for what a "memory" even is. So every tool re-learns your codebase from zero, forever.

**Agent work is not a first-class object.** A run happens in scrollback and then it's gone. There is no record you can replay, audit, cost, or hand to a teammate — no equivalent of a CI run for the thing that is now writing most of your code.

Interlock is a control plane for all three. It does not ship a model, host anything, or touch your credentials.

---

## Core concepts

Interlock has a small vocabulary. Learn these eight words and you know the whole system.

| Term | What it is |
|---|---|
| **Deck** | Your control surface. A grid of live tiles, one per Station. This is the Stream Deck part. |
| **Station** | One model, in one role, bound to one workspace, under one policy. The unit you configure. |
| **Role** | What a Station is *for*: `engineer`, `reviewer`, `worker`, or `conductor`. Roles carry different prompts, different tool permissions, and different defaults. |
| **Run** | One unit of work: a prompt in, a diff and a set of verdicts out. Durable, replayable, costed. |
| **Gate** | The condition a Run must clear before its diff is accepted — e.g. *two reviewers from distinct vendors must pass*. |
| **Trip** | A Run blocked by a Gate, with the reason attached. The interlock did its job. |
| **Commons** | The shared memory and knowledge store every Station reads and writes. Git-backed. |
| **Pipeline** | An ordered list of steps — Stations, actions, and Gates — declared in config and executed verbatim. |
| **Conductor** | An optional planning Station. Reads a task, *proposes* a Pipeline, and hands it to you. It never writes code and never runs its own plan. |
| **Adapter** | The integration for one runtime. Community-maintained, versioned, swappable. |

---

## What it looks like

```
┌─ INTERLOCK ─────────────────────────────────────────── ⌘K ──┐
│                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐    │
│  │ ● OPUS        │  │ ● CODEX       │  │ ○ QWEN3       │    │
│  │ engineer      │  │ reviewer      │  │ worker        │    │
│  │ claude-code   │  │ codex         │  │ ollama        │    │
│  │               │  │               │  │               │    │
│  │ api/ · 4m12s  │  │ idle          │  │ idle          │    │
│  │ ▓▓▓▓▓▓▓░░ 74% │  │               │  │               │    │
│  │ $0.84         │  │ $0.00         │  │ local         │    │
│  └───────────────┘  └───────────────┘  └───────────────┘    │
│                                                             │
│  RUN #241  "add rate limiting to the upload endpoint"       │
│  ├─ opus      implement    ✓ 6 files, +231 −18    $0.84     │
│  ├─ codex     review       ⚠ 2 findings           $0.11     │
│  │            └─ correctness · race in token refill         │
│  │            └─ security    · limiter keyed on user input  │
│  └─ gate      default      ⛔ TRIPPED — blocking: security   │
│                                                             │
│  [ apply anyway ]  [ send back to opus ]  [ open diff ]     │
└─────────────────────────────────────────────────────────────┘
```

Same UI on desktop and on your phone. It is one web app; the desktop build is a thin native shell around it and the daemon serves it to any device on your tailnet.

---

## Quickstart

### Requirements

- **Node.js ≥ 22**
- At least one agent runtime, already installed and authenticated:
  - [Claude Code](https://claude.com/claude-code) — `claude login`
  - [Codex CLI](https://developers.openai.com/codex) — `codex login`
  - [Ollama](https://ollama.com) — `ollama pull qwen3-coder`
- macOS, Windows, or Linux. Git.

Interlock **never sees your model credentials.** Adapters shell out to CLIs you have already logged into; there is no key to paste into Interlock and no proxy in the request path.

### Install

```bash
npm install -g @interlock/cli
interlock init          # writes interlock.toml, detects installed runtimes
interlock up            # starts the daemon, opens the Deck
```

Or grab the desktop app from [Releases](../../releases) — it bundles the daemon and adds a tray icon, native notifications, and start-on-login.

### Your first gated run

```bash
interlock run "add rate limiting to the upload endpoint" \
  --engineer opus --review codex
```

### Reach it from your phone

```bash
interlock pair
# scan the QR from your phone on the same tailnet
```

---

## How it works

```
                    ┌──────────────────────────────────────┐
   iPhone ─────────▶│                                      │
   iPad             │        Interlock Web UI              │◀──── Desktop shell
   Laptop ─────────▶│   (one app, served to every device)  │      (Tauri, thin)
                    └──────────────────┬───────────────────┘
                       tailnet / LAN   │  HTTP + WebSocket
                                       ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                    interlockd  ·  the daemon                       │
   │                                                                    │
   │   Queue      Policy       Gates       Ledger      Run store        │
   │   jobs,      paths,       N-of-M,     tokens,     diffs, verdicts, │
   │   priority   secrets,     vendor      cost per    replayable       │
   │              redaction    diversity   vendor      records          │
   │                                                                    │
   │   ┌──────────────────────┐      ┌──────────────────────────────┐   │
   │   │      Commons         │      │      Connector registry      │   │
   │   │  git-backed memory   │      │  one source → every runtime  │   │
   │   │  + MCP recall server │      │  config format               │   │
   │   └──────────┬───────────┘      └───────────────┬──────────────┘   │
   └──────────────┼──────────────────────────────────┼──────────────────┘
                  │  projections + recall            │  MCP wiring
                  ▼                                  ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                     Adapters  (subprocess, on host)                │
   ├──────────────────┬──────────────────┬──────────────────────────────┤
   │  claude-code     │  codex           │  ollama                      │
   │  engineer        │  reviewer        │  worker                      │
   │  reads CLAUDE.md │  reads AGENTS.md │  reads injected context      │
   └──────────────────┴──────────────────┴──────────────────────────────┘
                                  │
                                  ▼
                        your repos, on disk
```

**Daemon-first, on purpose.** `interlockd` is the product. The Deck is a client of it, and so is the CLI, and so is the HTTP API. Anything you can do by tapping a tile you can do in a script or in CI. This is also what lets the same binary run headless on a box in the corner while you drive it from a laptop.

**Adapters run on the host, not in containers.** Two hard-won reasons: agents are I/O-storm workloads and bind-mounting a Windows path into a Linux container is genuinely unusable; and both major CLIs authenticate interactively and cache tokens on the machine. Optional per-workspace container isolation is on the roadmap for people who want it — it is not the default because the default has to work.

---

## Features

### 🎛 The Deck

A tile per Station. Live status, current file, token burn, elapsed time, cost. Tap a tile to open that agent's stream; hold to reassign its role or point it at a different workspace. Keyboard-first on desktop (`⌘K` for everything), thumb-first on mobile.

### ⚖️ Roles and Gates

Roles are not prompt decoration — they change what a Station is allowed to do.

| Role | Gets | Denied |
|---|---|---|
| `engineer` | Write access to the workspace, full toolset, owns the working tree | — |
| `reviewer` | Read-only clone, the diff, and the brief. Never told what verdict to reach | Cannot write to the workspace |
| `worker` | Narrow, cheap, deterministic tasks: classification, summaries, commit messages, memory dedup | Cannot review; cannot write code |
| `conductor` | The task, the Station roster, the Commons, past Run records, and a read-only view of the repo. Emits a *proposed* Pipeline | Cannot write code, review, run commands, or execute the plan it just wrote |

`worker` exists to keep you from making the mistake everyone makes: **a small local model is not a reviewer.** A 7–30B model reviewing a frontier model's output approves nearly everything, which is worse than no review because it manufactures confidence. Interlock will warn you if you try.

Gates are declarative:

```toml
[gate.default]
require            = "2-of-3"      # how many reviewers must pass
distinct_vendors   = 2             # ...from at least two different companies
blocking           = ["security", "correctness"]   # categories that always trip
skip_if_diff_under = 20            # don't burn tokens reviewing a typo fix
```

### 🎼 The Conductor — optional, and deliberately weak

"An AI that manages your terminals" usually means a model deciding, live, who does what. Interlock does not work that way by default, and the reason isn't caution — it's that a routing model is the worst place to spend a token. It picks wrong, spends 3× the budget picking, and lands a worse diff than handing the whole task to one good engineer would have.

**The manager is deterministic.** Pipelines and Gates are declared; `interlockd` executes exactly what you declared, every time, and you can diff two runs and know the difference came from the models rather than from the plan.

The Conductor is the escape hatch for when you don't yet know what to declare.

```
  you ─── "add rate limiting to the upload endpoint"
              │
              ▼
       ┌─────────────┐   reads   station roster, Commons, past Runs,
       │  conductor  │           repo layout — all read-only
       └──────┬──────┘   writes  nothing
              │
              ▼  a proposed Pipeline, with reasons and an estimate
   ┌───────────────────────────────────────────────────────────┐
   │  opus     implement   src/api/**             ~$0.80       │
   │  codex    review      adversarial            ~$0.12       │
   │  gate     release     distinct_vendors = 2                │
   │                                                           │
   │  why codex: the last 3 Trips on src/api/** were security  │
   │                                                           │
   │  [ run it ]  [ edit ]  [ save as pipeline ]  [ discard ]  │
   └───────────────────────────────────────────────────────────┘
```

Four rules keep it from becoming the thing it replaces:

1. **Its output is a plan, not an action.** The Conductor emits a Pipeline. The daemon executes Pipelines. The Conductor cannot execute anything, including its own proposal — the seam is enforced in the daemon, not requested in a prompt.
2. **It cannot weaken a Gate.** A proposal may tighten `min_gate`; it may never drop below it, shrink `distinct_vendors`, or remove a blocking category. The interlock is not up for negotiation by a model.
3. **Hard budget.** A fixed token ceiling per proposal. Planning that costs a meaningful fraction of the work is planning you shouldn't have bought.
4. **It aims to make itself unnecessary.** Every accepted proposal offers **save as pipeline** — it becomes named, deterministic TOML you own. The Conductor is scaffolding that emits config, not a dependency that re-decides every morning.

Any Station can wear the hat, and which one you pick is a real cost decision: a frontier model plans well and bills for it; a `worker`-class local model is fine at *"this is a two-line typo fix, skip the gate"* and useless at anything structural.

```toml
[conductor]
station  = "opus"        # which Station plans
budget   = 4000          # hard token ceiling per proposal
autorun  = false         # never execute its own plan unattended
min_gate = "default"     # may propose stricter, never weaker
```

`interlock plan "…"` prints a proposal and exits. `interlock run` with no `--engineer` asks the Conductor first, if one is configured, and asks you before it moves.

### 🧠 The Commons — shared memory

One store. Two projections. One server.

```
  ~/.interlock/commons/          git repo · markdown + frontmatter · one fact per file
         │
         ├──▶ CLAUDE.md          generated · always in context · zero tool calls
         ├──▶ AGENTS.md          generated · always in context · zero tool calls
         └──▶ MCP server         memory_search / memory_write · deep recall on demand
                ▲
                └── capture hooks fire after every run → approval inbox → store
```

Why both projections *and* an MCP server: static files cost nothing and are always loaded, including by local models that will never reliably decide to call a tool. The MCP server carries the long tail that would blow your context budget if it were pasted into every session.

Captured memories land in an **approval inbox**, not straight into the store. Without a gate, agent-written memory drifts, duplicates, and quietly poisons every future session. Provenance — which Station, which Run, when — is attached to every entry.

Sync between machines is a git remote. Your memory is plain markdown in a repo you own; you can read it, grep it, diff it, and leave.

### 🔌 Connectors, once

MCP is the common substrate — every major runtime speaks it — but each one reads a different config file. Declare a connector once:

```toml
[[connector]]
id      = "postgres"
command = "npx"
args    = ["-y", "@modelcontextprotocol/server-postgres", "$DATABASE_URL"]
grant   = ["opus", "codex"]        # which Stations get it
```

Interlock renders it into `.mcp.json` and `~/.codex/config.toml` and keeps them in sync.

> **Known limit, stated honestly:** vendor-hosted connectors (the Gmail/Drive/Microsoft 365 integrations managed inside claude.ai) hold OAuth grants tied to that vendor's account and **cannot** be shared with another vendor's agent. To give every Station the same reach you must run your own MCP servers against your own OAuth clients. Interlock will help you wire them; it cannot repeal the constraint.

### 📱 Remote control

The daemon binds to loopback by default. Remote access is opt-in and goes over your tailnet — Interlock does not open a port to the internet and will refuse to bind `0.0.0.0` without an explicit flag and a warning.

Pairing is a QR code carrying a short-lived token. Paired devices are listed and individually revocable. From a phone you can queue runs, watch streams, read diffs, approve or deny a tool call the agent is waiting on, clear the memory inbox, and stop anything that's misbehaving.

### 🛡 Policy

Per-Station path allowlists, deny globs, and command policy. Secret redaction runs on prompts and diffs *before* they leave the machine, with a rule pack you can extend. Every denial is logged to the Run record.

### 💰 Ledger

Token and dollar accounting per Run, per Station, per vendor, per day. Because a gated two-model workflow costs roughly 3× a single session, and you should find that out from a chart rather than from an invoice.

### 📼 Run records

Every Run is a durable object: prompt, brief, diff, verdicts, tool calls, denials, cost, memories written. Replay it, share it, diff two attempts, or attach it to a PR.

---

## Supported runtimes

| Adapter | Vendor | Roles | Status |
|---|---|---|---|
| `claude-code` | Anthropic | engineer, reviewer | 🚧 In progress |
| `codex` | OpenAI | engineer, reviewer | 🚧 In progress |
| `ollama` | local | worker | 🚧 In progress |
| `gemini-cli` | Google | engineer, reviewer | 📋 Planned |
| `opencode` | community | engineer | 📋 Planned |
| `cursor-cli` | Cursor | engineer | 📋 Planned |
| `lmstudio` | local | worker | 📋 Planned |

**Vendor diversity is a feature, not diplomacy.** Gates that require `distinct_vendors ≥ 2` only mean something if the adapter ecosystem is broad. Adding your runtime is the single most valuable contribution you can make.

---

## Writing an adapter

An adapter is a small TypeScript module implementing one interface. It does not need to understand Gates, the Commons, or the Deck — the daemon handles all of that.

```ts
import type { Adapter, RunContext, RunResult } from "@interlock/adapter";

export default {
  id: "my-agent",
  vendor: "acme",
  roles: ["engineer", "reviewer"],

  // How Interlock knows it's installed and authenticated
  async probe() {
    return { installed: await which("my-agent"), authed: await checkAuth() };
  },

  // Where this runtime expects always-loaded context, so the Commons can project into it
  contextFiles: [{ path: "MY_AGENT.md", scope: "project" }],

  // How to register MCP connectors for this runtime
  async writeConnectors(connectors) { /* ... */ },

  // Do the work. Stream events; return a structured result.
  async run(ctx: RunContext): Promise<RunResult> {
    const proc = spawn("my-agent", ["--prompt", ctx.brief, "--json"]);
    for await (const ev of parse(proc.stdout)) ctx.emit(ev);
    return { diff: await ctx.workspace.diff(), cost: ctx.meter.total() };
  },
} satisfies Adapter;
```

Full spec in [`docs/adapters.md`](docs/adapters.md). Adapters are versioned independently and can live outside this repo.

---

## Configuration

One file, `interlock.toml`, in your project or at `~/.interlock/`.

```toml
[deck]
name = "api-team"

# ── Stations ────────────────────────────────────────────────
[[station]]
id        = "opus"
adapter   = "claude-code"
role      = "engineer"
model     = "opus"
workspace = "~/code/api"
paths     = ["src/**", "tests/**"]      # may touch
deny      = ["**/*.env", "infra/**"]    # may not, ever

[[station]]
id      = "codex"
adapter = "codex"
role    = "reviewer"

[[station]]
id      = "qwen"
adapter = "ollama"
role    = "worker"
model   = "qwen3-coder"

# ── Gates ───────────────────────────────────────────────────
[gate.default]
require            = "1-of-1"
distinct_vendors   = 2
blocking           = ["security", "correctness"]
skip_if_diff_under = 20

[gate.release]
require          = "2-of-3"
distinct_vendors = 2
blocking         = ["security", "correctness", "data-loss"]

# ── Pipelines ───────────────────────────────────────────────
[pipeline.ship]
steps = [
  { station = "opus",  action = "implement" },
  { station = "codex", action = "review", mode = "adversarial" },
  { gate    = "release" },
  { station = "qwen",  action = "commit-message" },
]

# ── Conductor (optional) ────────────────────────────────────
[conductor]
station  = "opus"
budget   = 4000
autorun  = false
min_gate = "default"

# ── Commons ─────────────────────────────────────────────────
[commons]
store      = "~/.interlock/commons"
sync       = "git@github.com:you/commons.git"
project_to = ["CLAUDE.md", "AGENTS.md"]
mcp        = true
approval   = "inbox"          # inbox | auto | off

# ── Remote ──────────────────────────────────────────────────
[remote]
bind    = "127.0.0.1:7373"
tailnet = true
pairing = "qr"
```

Then: `interlock ship "add rate limiting to the upload endpoint"`.

---

## Security model

Interlock runs agents that can execute code and reads secrets adjacent to them. Treat it accordingly.

- **No credential proxying.** Interlock never stores, forwards, or sees a model API key. Adapters invoke CLIs you authenticated yourself.
- **Loopback by default.** Remote access requires an explicit opt-in. There is no hosted relay, no phone-home, no telemetry.
- **Short-lived pairing tokens**, per-device, individually revocable, listed in the UI.
- **Redaction before egress.** Prompts and diffs pass a secret scanner before leaving the machine.
- **Policy is enforced in the daemon**, not requested in a prompt. A Station denied `infra/**` cannot write there even if the model decides it should.
- **Every denial and every tool call is recorded** in the Run.

Interlock has not been audited. Do not expose the daemon to an untrusted network. Report vulnerabilities per [SECURITY.md](SECURITY.md) rather than in a public issue.

---

## Roadmap

| Milestone | Contents | State |
|---|---|---|
| **M0 · Spine** | Daemon, run queue, `claude-code` adapter, CLI, run records | 🚧 |
| **M1 · Interlock** | `codex` adapter, roles, Gates, verdict parsing, Trips | 📋 |
| **M2 · Commons** | Git-backed store, projections, MCP recall, capture hooks, approval inbox | 📋 |
| **M3 · Deck** | Web UI, Tauri desktop shell, tray, notifications | 📋 |
| **M4 · Remote** | Tailnet serving, QR pairing, mobile approvals, device revocation | 📋 |
| **M5 · Fleet** | Multiple machines as worker nodes; run on the desktop from the laptop | 📋 |
| **M6 · Ecosystem** | Adapter SDK published, `gemini-cli` + `opencode`, connector registry, policy packs | 📋 |
| **M7 · Conductor** | `conductor` role, `interlock plan`, proposal review UI, save-as-pipeline, budget ceiling | 📋 |

Post-M6 candidates: optional container isolation per workspace, [Agent Client Protocol](https://agentclientprotocol.com) as a transport so one adapter covers many runtimes, CI mode, team-shared Commons with review.

---

## Non-goals

Stating these up front so nobody files the issue.

- **Not a model provider.** Interlock ships no weights and no inference.
- **Not a hosted service.** It runs on your machines. There is no cloud tier and no account.
- **Not an IDE or an editor.** It orchestrates agents; you keep your editor.
- **Not a credential broker.** Bring your own auth, always.
- **Not an autonomous manager.** A Conductor may propose a plan; it never approves, executes, or relaxes a Gate. If you want a system that decides and acts while you sleep, this is the wrong tool on purpose.
- **Not a benchmark suite.** It won't tell you which model is better — it lets you make them check each other.

---

## Contributing

Contributions welcome, especially:

1. **Adapters.** The highest-leverage contribution. See [`docs/adapters.md`](docs/adapters.md).
2. **Verdict parsing.** Turning free-text review output into structured findings with categories is where most of the difficulty lives.
3. **Policy packs.** Redaction rules and path policies for common stacks.
4. **Mobile UX.** Approving a tool call one-handed on a phone is a real design problem.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Be aware that this project integrates against several fast-moving upstreams — adapter churn is the permanent tax, and keeping adapters thin and isolated is a design rule, not a preference.

---

## FAQ

**Isn't this just another web UI for Claude Code?**
No, and if it ends up being that, it has failed. Web UIs for agent CLIs are a crowded field. What Interlock adds is the part nobody has shipped: cross-vendor memory, roles and gates as enforced structure rather than prompt convention, and run records. The Deck is how you touch that, not what it is.

**So is an AI managing the whole thing, or isn't it?**
Neither, exactly. Execution is deterministic — declared Pipelines, enforced Gates, no model in the control path. *Planning* can be delegated to a Conductor Station, which proposes a Pipeline you approve, edit, or save as permanent config. The split is deliberate: models are good at reading a task and suggesting a shape, and bad at being a scheduler you can't audit.

**Why not just use one very good model?**
You should, for writing the code. The claim here is narrower and better supported: a model reviewing its own output shares its own blind spots, so an independent second opinion has to come from somewhere else. Interlock makes "somewhere else" a config line.

**Can I use only local models?**
Yes, and Interlock will run fully offline. But it will warn you when a `worker`-class model is placed in a `reviewer` seat, because that combination produces false confidence rather than safety.

**What does it cost to run?**
Interlock is free. The models are not. A gated two-model workflow runs roughly 3× the tokens of a single session — which is why `skip_if_diff_under` exists and why the Ledger is a headline feature rather than a footnote.

**Does my code or memory leave my machine?**
Only to the model vendors you configured, exactly as it would if you ran their CLI directly. Interlock adds no telemetry, no relay, and no analytics.

**Windows?**
Yes — first class. The daemon and desktop app are built and tested on Windows, macOS, and Linux.

---

## License

[Apache-2.0](LICENSE). Permissive, with an explicit patent grant.
