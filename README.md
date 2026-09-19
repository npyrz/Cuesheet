<div align="center">

# Cuesheet

**The control room for every AI that writes your code.**

A desktop app that turns Claude Code, Codex, Ollama and whatever comes next into one crew you actually manage — models, harnesses, roles, memory, limits, and permissions on a single desk. Then hands you the whole thing on your phone.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Development](https://img.shields.io/badge/development-beta-blue.svg)](#what-actually-works-right-now)
[![Platform](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-desktop-black.svg)](#requirements)

</div>

---

> **Development track: beta. Latest release: [`v0.1.0-alpha`](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha).** Alpha shipped; current source is now building toward `v0.5.0-beta`, not claiming to be that release already. The Desk runs, the daemon runs, and `claude-code` and `codex` both do real work through them on macOS and Windows. Gates work with two real vendors, `ollama` works worker-only, limits and fallback routing are live, and one daemon serves many isolated projects. The Commons store and its byte-stable `CLAUDE.md` / `AGENTS.md` projections work; approval, MCP recall and sync remain. The public installers are still the unsigned alpha builds, so macOS quarantine and Windows SmartScreen caveats apply. [What actually works right now](#what-actually-works-right-now) is the honest list; the [build plan](PLAN-STEP.MD) separates completed beta-track work from the remaining beta release bar.

### What actually works right now

Everything below this line is either built or building. Nothing here needs `cuesheet.toml` opened by hand.

| | |
|---|---|
| ✅ **The daemon** | `cuesheetd` on `127.0.0.1:7373` — run queue, run records, WebSocket stream. Every client, including the phone later, is a client of these routes. |
| ✅ **The Desk** | React UI: Station tiles, live run log, `⌘K` palette, add-a-Station panel that writes your TOML for you. |
| ✅ **`claude-code`** | Real runs: streamed output, a `diff.patch`, cost, and stop-means-stop on the whole process tree. |
| ✅ **The desktop app** | Electron shell with the daemon embedded — one process tree, no sidecar. Tray menu, native notifications, start-at-login, and a shutdown that never leaves a run stuck `running`. |
| ✅ **Installers** | `dmg`/`zip` (arm64 + x64) and an `nsis` installer, each built on its own platform and launched from a path with a space. Unsigned, but no longer unpublished: the tag workflow built all five on runners and `v0.1.0-alpha` is out. Unsigned still means quarantine on macOS and SmartScreen on Windows — see [Install](#install). |
| ✅ **Windows** | Run on a real Windows 10 box: install, build, the full test suite, a live `claude-code` run, a stop that takes the process tree to zero, a `taskkill /F` that reconciles to `interrupted`, the NSIS installer, and the installed app launched from a path with a space. Two things are still open: a toast nobody has seen, because the test box has notifications disabled system-wide, and the tray glyph at 16px, which has been decoded and rendered but wants its own proportions. The `.cmd` shim is no longer among them — a Windows-gated test writes a real CRLF `.cmd` and executes it on the runner. |
| ✅ **Gates** | A `{ gate = … }` cue runs a real second-opinion check: the reviewer gets the diff, its verdict is parsed, and a failed gate holds the run with the findings attached. Needs both CLIs installed — and with them, proven on two real vendors rather than fixtures: `claude-code` wrote a rate limiter, `codex` found unbounded memory growth in it, and the run landed `held` at $0.56. |
| ✅ **Projects** | One daemon serves many. Each project has its own config, run history, queue and event stream, addressed as `/projects/:id/…` — the daemon deliberately has no "current project", so which one you mean is a path segment. An alpha install upgrades into this without losing anything: its config becomes project #1, rooted where its Stations said the code was, and every run record moves across byte for byte. |
| ✅ **Switching** | The Desk reopens whichever project you were last in, and moves between them without disturbing anything: **a switch is not a stop.** Switch away mid-run and it keeps streaming to disk with nobody watching; switch back and the log comes back whole, because the run store is the authority and the socket's replay buffer is only a convenience. Switching is one action and reachable without a mouse — a menu in the shell, or `⌘K` and the project's name — and the window title and tray menu follow it, so two windows on two projects are told apart from the dock. The Desk never shows one project's runs under another's name: the state carries the project it belongs to, and the surface draws nothing it cannot vouch for. |
| ✅ **Limits** | `GET /usage` reports every harness's plan windows, and the Desk draws them above the tiles. A run that cannot finish is refused *before* it starts, with the window that stopped it — and if `when_capped` could not route around the cap, the refusal says why. **Read the honest part:** the strip tells you what each vendor actually said, and today that is mostly a sentence rather than a bar — Claude Code reports a *status* (`not blocked yet`) rather than a percentage, Codex reports no plan window at all, and a local model cannot run out. The one real measurement any shipped harness produces is Claude Code reporting it is into overage. |
| ✅ **The ledger** | What a project spent, by day, by vendor, by Station — including how much of each input was served from cache, which is the difference between two runs with identical token counts and severalfold different bills. Per-Station spend is on every run record. Runs from before that field existed are counted and *labelled* as unsplit rather than blamed on whichever Station happened to be first. |
| ✅ **Fallback routing** | `when_capped` moves a step to another Station instead of stopping. It **refuses a swap that changes the seat**: a worker cannot stand in for a reviewer, and a harness that does not declare the role cannot take it. A Gate needs no special handling — it counts the vendors that actually acted, so a substitution that breaks `distinct_vendors` holds the run on its own. |
| ✅ **The run surface** | A live run ordered by what it costs to miss, not by what arrived last: a blocking finding is a headline above the stream, with the Gate's own reasons under it, and the run's row in the list carries it too — so it is what you see before you click, not what you scroll for. Prose is coalesced per Station, costs live in the header rather than the log, and a denial keeps its own colour because it is the only visible evidence a leash held. |
| ✅ **The project view** | Everything about a project on one screen: who is on it, what each Station may and may not do, what it has spent, and how close its harness is to a cap. Permissions are written as constraints with the process that keeps each one named — because they are not all kept by the same one. The daemon refuses a `worker`'s writes; Codex's own sandbox runs a reviewer read-only; Claude Code does neither and leaves the leash as the whole boundary. A harness that declares nothing is reported as unknown rather than as unconfined. |
| ✅ **The launch surface** | What the app opens on when no project is active, and where "All projects…" takes you back to: recents with when each was last opened, a folder that has gone marked as such rather than failing when you press it, `forget` for an entry you are done with, and the native picker. Leaving a project is a client action — its runs keep going. |
| ◐ **The Commons** | The git-backed fact store and byte-stable `CLAUDE.md` / `AGENTS.md` projections are built. Approval, MCP recall and cross-machine sync are not. |
| 📋 **Not built yet** | Phone pairing, the Caller, On-Call. One more that is easy to miss because this README describes it as if it exists: **the `cuesheet` CLI** is an empty package. The next phases are in [PLAN-STEP.MD](PLAN-STEP.MD). |

**Concretely, today:** download the unsigned alpha, or clone current beta-track source and run `npm install`, `npm run build`, `npm run dev -w packages/desktop`. Two harnesses, and a gate between them if you have both CLIs installed. The config format can still change under you — the freeze and general migration framework are part of the remaining beta bar — but run records are no longer discarded on upgrade, which is a promise the alpha-to-projects migration now keeps rather than states.

---

## The ten-second version

Open the app. Add your AIs.

```
+ Add Claude      →  Claude Code detected, logged in
+ Add Codex       →  Codex CLI detected, logged in
+ Add Ollama      →  4 local models found
```

Give each one a harness, a role, a workspace, and a leash. Watch them work on one screen. Scan a QR code and carry the whole crew in your pocket — approve a command from a coffee shop, kill a run from bed, read the diff on the train.

Arm On-Call and production paging you at 3am gets you a reviewed patch instead of a stack trace.

Your memory, your knowledge, your rules, and your history live in Cuesheet. The models are interchangeable parts.

---

## Why this exists

**The coding terminal is the wrong unit of work.** A terminal is one session, one model, one machine, one person staring at scrollback. That was fine when the AI needed you watching every token. It doesn't any more. What you need now isn't a better terminal — it's the thing that manages a crew of them.

**Every harness you use today is disposable.** Claude Code, Codex, Gemini CLI, whatever ships next quarter — they are excellent and they are temporary. Betting your setup on one of them means re-learning your codebase, re-teaching your conventions, and re-wiring your tools every time the industry moves. That has already happened twice.

**The durable layer is everything around the model.** Your accumulated project memory. Which agent is allowed to touch which files. What "reviewed" means in your shop. The record of what was built and why. The bill. None of that belongs to a vendor, and no vendor is going to build it for you across their competitors.

Cuesheet is that layer. When the best coding model changes — and it will, repeatedly — you swap a harness in a dropdown and everything else stays exactly where it is.

---

## What it looks like

### The Desk

```
┌─ CUESHEET ────────────────────────────────────────────── ⌘K ─┐
│                                                              │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐     │
│  │ ● OPUS        │  │ ● CODEX       │  │ ○ QWEN3       │     │
│  │ engineer      │  │ reviewer      │  │ worker        │     │
│  │ claude-code   │  │ codex         │  │ ollama        │     │
│  │               │  │               │  │               │     │
│  │ api/ · 4m12s  │  │ reading diff  │  │ idle          │     │
│  │ ▓▓▓▓▓▓▓░░ 74% │  │ ▓▓░░░░░░░ 18% │  │               │     │
│  │ $0.84         │  │ $0.11         │  │ local         │     │
│  └───────────────┘  └───────────────┘  └───────────────┘     │
│                                                              │
│  RUN #241  "add rate limiting to the upload endpoint"        │
│  ├─ opus      implement    ✓ 6 files, +231 −18     $0.84     │
│  ├─ codex     review       ⚠ 2 findings            $0.11     │
│  │            └─ correctness · race in token refill          │
│  │            └─ security    · limiter keyed on user input   │
│  └─ gate      default      ✋ HELD — blocking: security       │
│                                                              │
│  [ send back to opus ]  [ open diff ]  [ override ]          │
└──────────────────────────────────────────────────────────────┘
```

One app, one desk, every agent. Same UI on your laptop and your phone — the desktop build is a native shell around it, and the daemon serves it to any device you've paired.

---

## The main screen

Adding an AI is five choices, and Cuesheet has already made four of them by the time you open the panel.

```
┌─ ADD A STATION ─────────────────────────────────────────────┐
│                                                             │
│  1 · HARNESS                          found on this machine │
│      ● Claude Code    v2.1.4    ✓ logged in                 │
│      ● Codex CLI      v0.9.2    ✓ logged in                 │
│      ● Ollama         v0.6.1    qwen3-coder, llama3.3, +2   │
│      ○ Gemini CLI               not installed      install ↓│
│      ○ opencode                 not installed      install ↓│
│                                                             │
│  2 · MODEL      opus ▾                                      │
│  3 · ROLE       engineer ▾   reviewer · worker · caller     │
│  4 · WORKSPACE  ~/code/api                         browse   │
│  5 · LEASH      may touch   src/**  tests/**                │
│                 never       **/*.env  infra/**  .git/**     │
│                                                             │
│                                  [ cancel ]      [ add ]    │
└─────────────────────────────────────────────────────────────┘
```

**Harness and role are separate choices, and that is the whole point.** The same Claude install is three different Stations depending on the seat you put it in. One writes code with full tool access. One gets a read-only clone and the diff, and is never told what verdict to reach. One does cheap, narrow work all day for a fraction of a cent.

Nothing here requires you to type a path, paste a key, or read a config reference. The TOML exists and you can drive everything from it — but you never have to start there.

### Limits, on the same screen

```
┌─ LIMITS ────────────────────────────────────────────────────┐
│  Anthropic    5-hour   ▓▓▓▓▓▓▓░░░  71%   resets in 1h 48m   │
│               weekly   ▓▓▓░░░░░░░  34%                      │
│  OpenAI       plan     ▓▓▓▓▓▓▓▓▓░  88%   ⚠ near cap         │
│  Ollama       local    ∞                                    │
│                                                             │
│  ⚠  codex is close to its cap. Worker steps will fall back  │
│     to qwen3-coder until it resets.        [ configure ]    │
└─────────────────────────────────────────────────────────────┘
```

Every vendor meters differently and none of them tell you where you stand until you hit the wall — usually eleven minutes into something that mattered. Cuesheet reads each harness's own reported usage, shows every window on one strip, warns you before a run starts that can't finish, and can route around a station that's tapped out.

**That is the strip as designed, and what it draws today is narrower.** A bar appears only where a vendor reported a *fraction*, and most of them do not: Claude Code reports a status rather than a percentage, Codex reports no plan window at all, and a local model has no cap to draw. So the real strip is mostly sentences — "not blocked yet", "reports no plan windows", "cannot run out" — and it says how old each reading is, because Claude Code can only tell you what a run overheard. That is deliberate. A row of confident zeroes for vendors that reported nothing would be worse than no strip.

**One correction to the mock-up above:** the fallback is not unconditional. Worker steps falling back to `qwen3-coder` is exactly the swap Cuesheet will make — a worker standing in for a worker. What it will *not* do is move a reviewer's step to a worker, or to any Station in a different seat, however the config is written. A router that quietly reseats an agent is doing at runtime what the config linter exists to warn a human about, and the README's own argument against a small local model in a reviewer's chair is a safety argument, not an ergonomic one. When it cannot route, the run is refused up front and told you why.

---

## Away from the desk

Scan a QR code once. That's the setup.

```
        ┌──────────────────┐
        │ CUESHEET   ● live│
        │                  │
        │ RUN #241         │
        │ add rate limiting│
        │ ───────────────  │
        │ ● opus  writing  │
        │ src/api/limit.ts │
        │ 4m 12s    $0.84  │
        │                  │
        │ ┌──────────────┐ │
        │ │   STANDBY    │ │
        │ │              │ │
        │ │ opus wants   │ │
        │ │ to run:      │ │
        │ │              │ │
        │ │ npm test     │ │
        │ │              │ │
        │ │ [ GO ] [ NO ]│ │
        │ └──────────────┘ │
        └──────────────────┘
```

Away from your desk you can queue a run, watch any station's stream live, read a diff, clear the memory inbox, answer a **standby** — the moment an agent needs a permission you haven't pre-granted — and stop anything misbehaving. Your phone buzzes, you tap **GO**, the run continues. That is the whole interaction.

**It is not a hosted mode.** There is no relay, no cloud worker, no copy of your repo on someone else's infrastructure. Your phone talks to *your* machine over *your* tailnet, running against *your* working tree with *your* credentials. Pairing tokens are short-lived, per-device, listed in the UI, and revocable in one tap. The daemon binds to loopback by default and refuses to bind `0.0.0.0` without an explicit flag and a warning.

Nothing is public. Nothing is shared. Nothing leaves except what your models were always going to see.

---

## Core concepts

Twelve words and you know the system.

| Term | What it is |
|---|---|
| **Desk** | Your control surface. A grid of live tiles, one per Station. |
| **Station** | One model, on one harness, in one role, bound to one workspace, under one leash. The unit you add. |
| **Harness** | The integration for one runtime — `claude-code`, `codex`, `ollama`. Versioned, swappable, community-maintained. |
| **Role** | What a Station is *for*: `engineer`, `reviewer`, `worker`, or `caller`. Roles change permissions, not just prompts. |
| **Project** | A codebase Cuesheet knows about: a folder, its Stations, its cuesheets, and its run history. You open one, and switch between them without losing what is running in the other. *Not built yet* — today there is a single global config. |
| **Cue** | One step: a Station and an action. |
| **Cuesheet** | An ordered list of cues and gates. The plan. |
| **Run** | One execution of a cuesheet: a prompt in, a diff and a set of verdicts out. Durable, replayable, costed. |
| **Standby** | A run paused, waiting on you. Answer it from anywhere. |
| **Incident** | An externally-triggered Run — an alert came in, not a prompt. Same record, same gates, stricter defaults. |
| **Gate** | A condition a Run must clear before its diff is accepted. |
| **Hold** | A Run stopped by a Gate, with the reason attached. |
| **Commons** | The shared memory and knowledge every Station reads and writes. Git-backed, synced across your devices. |

---

## Quickstart

### Requirements

- **macOS 13+, Windows 10+, or Linux.** Git.
- At least one harness installed and authenticated — two from different vendors if you want Gates:
  - [Claude Code](https://claude.com/claude-code) — `claude login`
  - [Codex CLI](https://developers.openai.com/codex) — `codex login`
  - [Ollama](https://ollama.com) — `ollama pull qwen3-coder`
- **Node.js ≥ 22.** Required in alpha — the app is run from a checkout, not installed.

**Cuesheet never sees your model credentials.** Harnesses shell out to CLIs you already logged into. There is no key to paste, no proxy in the request path, and no account to create.

### Install

> **[`v0.1.0-alpha` is out.](https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha)** An `nsis` installer for Windows x64, and `dmg` + `zip` for Apple Silicon and Intel. Both are **unsigned** — see below for what that looks like. It is an alpha in the sense the table above means it: one harness, one Station at a time, config that may change under you.
>
> Installing into a **non-empty folder is not supported** on Windows: the installer lets you choose the directory and its uninstaller then removes that directory wholesale. Accept the default, or give it an empty folder of its own — never a folder you keep other files in.
>
> To run from a checkout instead:

```bash
git clone <this repo> && cd cuesheet
npm install
npm run build
npm run dev -w packages/desktop   # the app, with the daemon inside it
```

The window opens on the Desk. Click **add a station**, pick the harness it found on your machine, point it at a workspace, and it writes `~/.cuesheet/cuesheet.toml` for you.

Prefer a browser? `npx cuesheetd` in one terminal and `npm run dev -w packages/ui` in another puts the same Desk on `http://localhost:5173` — the app and the browser are the same UI talking to the same daemon.

<details>
<summary><b>The installers are unsigned.</b> Here is what that looks like.</summary>

Code signing costs money and a developer account; neither is worth blocking an alpha on. What it is *not* worth doing is pretending the friction is not there:

- **macOS** — the app is not signed or notarized, so Gatekeeper quarantines it. Right-click the app and choose **Open**, or `xattr -d com.apple.quarantine /Applications/Cuesheet.app`.
- **Windows** — the installer is not signed, so SmartScreen warns. **More info** → **Run anyway**.

Signing and notarization are on the list for beta. Until then, every release says all of this in its own notes as well.

</details>

Building them yourself, if you want to see what a release contains:

```bash
npm run dist -w packages/desktop   # builds everything, installers land in packages/desktop/release
```

### Your first run

Press `⌘K` (`Ctrl+K` on Windows), type what you want, and watch it stream into the tile:

```
add rate limiting to the upload endpoint
```

The run lands as a record on disk — prompt, event log, and a `diff.patch` you can read.

**What this is not yet:** Gates are built and the two-vendor review below really runs — but only from the Desk and the HTTP API. The `cuesheet` CLI is still an empty package, so these flags are the shape it is heading for rather than something you can type.

```bash
cuesheet run "add rate limiting to the upload endpoint" \
  --engineer opus --review codex          # 📋 the gate runs; this CLI does not exist yet
```

### Pair your phone

📋 Planned — M3. `cuesheet pair` does not exist yet.

---

## Features

### 🎛 The Desk

A tile per Station: live status, current file, token burn, elapsed time, cost. Tap a tile to open that agent's stream; hold to change its role or point it at a different workspace. Keyboard-first on desktop (`⌘K` reaches everything), thumb-first on the phone.

### 🎚 Harnesses and roles

A harness is *how* a model runs. A role is *what it is allowed to do*. Roles are enforced in the daemon, not requested in a prompt.

| Role | Gets | Denied |
|---|---|---|
| `engineer` | Write access to the workspace, full toolset, owns the working tree | — |
| `reviewer` | Read-only clone, the diff, and the brief. Never told what verdict to reach | Cannot write to the workspace |
| `worker` | Narrow, cheap, deterministic tasks: classification, summaries, commit messages, memory dedup | Cannot review; cannot write code |
| `caller` | The task, the roster, the Commons, past Runs, a read-only view of the repo. Emits a *proposed* cuesheet | Cannot write code, review, run commands, or execute its own plan |

`worker` exists to stop the mistake everyone makes: **a small local model is not a reviewer.** A 7–30B model reviewing a frontier model's output approves nearly everything, which is worse than no review because it manufactures confidence. Cuesheet warns you when you drop one into a reviewer seat.

### 📊 Usage limits and routing

Every vendor meters differently — rolling windows, weekly caps, per-model quotas, plan tiers — and each one hides the number somewhere else. Cuesheet reads what each harness reports and puts all of it on one strip.

- **Before a run starts,** you are told if a station cannot finish it.
- **Fallbacks are declarative.** `when_capped` moves steps to another station instead of stopping.
- **Ledger.** Tokens and dollars per Run, per Station, per vendor, per day — because a gated two-model workflow costs roughly 3× a single session, and you should learn that from a chart rather than an invoice.

```toml
[limits]
warn_at     = 0.85            # warn when a window passes 85%
block_at    = 0.97            # refuse to start a run that cannot finish
when_capped = { codex = "qwen", opus = "sonnet" }
```

### 🎼 The Caller — optional, and deliberately weak

"An AI that manages your terminals" usually means a model deciding, live, who does what. Cuesheet does not work that way by default, and the reason isn't caution — it's that a routing model is the worst place to spend a token. It picks wrong, spends 3× the budget picking, and lands a worse diff than handing the whole task to one good engineer would have.

**Execution is deterministic.** Cuesheets and Gates are declared; the daemon runs exactly what you declared, every time, so when two runs differ you know the difference came from the models rather than from the plan.

The Caller is the escape hatch for when you don't yet know what to declare.

```
  you ─── "add rate limiting to the upload endpoint"
              │
              ▼
       ┌─────────────┐   reads   roster, Commons, past Runs,
       │   caller    │           repo layout — all read-only
       └──────┬──────┘   writes  nothing
              │
              ▼  a proposed cuesheet, with reasons and an estimate
   ┌───────────────────────────────────────────────────────────┐
   │  opus     implement   src/api/**             ~$0.80       │
   │  codex    review      adversarial            ~$0.12       │
   │  gate     release     distinct_vendors = 2                │
   │                                                           │
   │  why codex: the last 3 Holds on src/api/** were security  │
   │                                                           │
   │  [ run it ]  [ edit ]  [ save as cuesheet ]  [ discard ]  │
   └───────────────────────────────────────────────────────────┘
```

Four rules keep it from becoming the thing it replaces:

1. **Its output is a plan, not an action.** The Caller emits a cuesheet. The daemon executes cuesheets. It cannot execute anything, including its own proposal — the seam is enforced in the daemon, not requested in a prompt.
2. **It cannot weaken a Gate.** A proposal may tighten `min_gate`; it may never drop below it, shrink `distinct_vendors`, or remove a blocking category.
3. **Hard budget.** A fixed token ceiling per proposal. Planning that costs a meaningful fraction of the work is planning you shouldn't have bought.
4. **It aims to make itself unnecessary.** Every accepted proposal offers **save as cuesheet** — it becomes named, deterministic config you own.

```toml
[caller]
station  = "opus"        # which Station plans
budget   = 4000          # hard token ceiling per proposal
autorun  = false         # never execute its own plan unattended
min_gate = "default"     # may propose stricter, never weaker
```

`cuesheet plan "…"` prints a proposal and exits.

### ⚖️ Gates — the check no vendor will build for you

A model reviewing its own work shares its own blind spots. Self-review inherits the same training, the same failure modes, and the same eagerness to agree that produced the bug. An independent second opinion has to come from a differently-trained model — and no vendor is ever going to ship first-class support for a competitor grading their output.

Cuesheet makes that a config line instead of a habit you have to remember.

```toml
[gate.default]
require            = "1-of-1"
distinct_vendors   = 2             # reviewers from at least two companies
blocking           = ["security", "correctness"]
skip_if_diff_under = 20            # don't burn tokens reviewing a typo

[gate.release]
require            = "2-of-3"
distinct_vendors   = 2
blocking           = ["security", "correctness", "data-loss"]
```

A Run that fails its gate is **held**, with the finding attached, and lands as a standby on whatever device you are holding.

**This works today, with two real vendors.** `claude-code` and `codex` both ship, so the config above is satisfiable with the CLIs you already have — no third-party harness required. It has been run end to end rather than fixtured: Claude Code added a rate limiter, Codex reviewed the actual diff and filed a blocking `security` finding for a limiter that retains every caller IP forever, and the gate held the run.

An unreadable review counts as an abstention, never as approval; a reviewer that crashes cannot wave anything through.

### 🚨 On-Call — a reviewed patch waiting for you when the pager goes off

Every other feature here starts with you typing a prompt. This one starts with production breaking at 3am.

On-Call is a standing cuesheet, armed and waiting on a trigger instead of on you. When an alert fires, Cuesheet triages it, writes a candidate patch, has a *different vendor's* model tear that patch apart, and puts the result on your phone with a verdict attached. You wake up to a reviewed diff and a test that now passes — not to a stack trace and an empty editor.

```
   🔔 alert         Sentry · PagerDuty · Datadog · webhook · failing CI
        │
        ▼
   ┌──────────┐   qwen · local · free
   │  triage  │   dedupe, pull the trace, git blame the frames,
   └────┬─────┘   search the Commons for prior incidents on this path
        │
        ├── duplicate of INC-118, or noise ──▶ logged · no run · no spend
        ▼
   ┌──────────┐   opus · branched from the commit actually deployed
   │  patch   │   narrow leash: only the files in the trace
   └────┬─────┘   must ship a test that fails before and passes after
        │
        ▼
   ┌──────────┐   codex · different vendor · read-only clone
   │  review  │   adversarial, never told what verdict to reach
   └────┬─────┘
        ▼
   ┌──────────┐
   │   gate   │   hotfix · distinct_vendors = 2 · never merges
   └────┬─────┘
        ▼
   📱 standby on your phone — diff, verdict, test result, [ PR ] [ NO ]
```

```
        ┌──────────────────┐
        │ CUESHEET INCIDENT│
        │                  │
        │ 502s on /upload  │
        │ since 03:12      │
        │ ───────────────  │
        │ ✓ reproduced     │
        │ ✓ patch ready    │
        │ ✓ codex reviewed │
        │   1 note 0 block │
        │                  │
        │ +14 −3           │
        │ api/limit.ts     │
        │ ───────────────  │
        │ [ open PR ][ NO ]│
        └──────────────────┘
```

Six rules make this safe to leave armed:

1. **It never deploys.** On-Call opens a branch and a PR. It cannot merge, cannot touch `infra/**`, and holds no credential for anything but your repo. Shipping stays a human act at 3am the same as at 3pm.
2. **No reproduction, no patch.** If the patch station can't produce a test that fails on the deployed commit and passes with its change, the run stops and says so. A confident-looking fix for a bug nobody reproduced is worse than an empty inbox — it is the fastest way to turn one incident into two.
3. **It branches from what is actually running,** not from `main`. Main has moved on; the deployed commit is the thing that's broken.
4. **The gate is not optional.** `[oncall]` refuses to arm without a reviewer from a distinct vendor. This is the one place in Cuesheet where a model's output reaches a production repo without you having written the prompt, so it is the one place the interlock is not a preference.
5. **Storm control.** Dedupe window, max incidents per hour, hard token budget per incident. A flapping alert should cost you one triage, not forty patches and a surprise invoice.
6. **Triage runs local and free.** Most pages are duplicates or noise. Putting the first pass on Ollama means the 90% that go nowhere burn no plan quota at all — and it is what finally makes the local station earn its seat.

```toml
[oncall]
enabled       = true
workspace     = "~/code/api"
branch_from   = "deployed"        # the commit in production, never main
budget        = 15000             # tokens per incident, hard stop
max_per_hour  = 3                 # storm control
dedupe_window = "30m"
quiet_hours   = false             # an incident is an incident

cues = [
  { station = "qwen",  action = "triage" },
  { station = "opus",  action = "patch",  require_failing_test = true },
  { station = "codex", action = "review", mode = "adversarial" },
  { gate    = "hotfix" },
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
merges           = false          # not configurable — hotfix gates never merge
```

On-Call adds no new role. It is an ordinary cuesheet wired to an ordinary trigger, run by the same `worker`, `engineer`, and `reviewer` seats you already configured — which is the point. The thing that answers your pager is governed by exactly the same leashes, gates, and run records as the thing that adds a button.

### 🧠 The Commons — memory that follows you

One store. Two projections. One server. Synced across every machine you work on.

```
  ~/.cuesheet/commons/           git repo · markdown + frontmatter · one fact per file
         │
         ├──▶ CLAUDE.md          generated · always in context · zero tool calls
         ├──▶ AGENTS.md          generated · always in context · zero tool calls
         └──▶ MCP server         memory_search / memory_write · deep recall on demand
                ▲
                └── capture hooks fire after every run → approval inbox → store
```

Today Claude Code keeps `CLAUDE.md`, Codex keeps `AGENTS.md`, Ollama keeps nothing, none of them can read the others', and every tool re-learns your codebase from zero, forever. Cuesheet keeps one store and projects it into whatever each harness expects.

**One store, many projects, and the files land where each AI already looks.** A fact carries the projects it belongs to, and the projection has two layers:

```
  scope: project   →  <each project root>/CLAUDE.md      that project's facts
                      <each project root>/AGENTS.md      same body, Codex's filename
  scope: user      →  ~/.claude/CLAUDE.md                how you work · written once per machine
                      ~/.codex/AGENTS.md                 never re-written per project
```

The split is not cosmetic. There is exactly one `~/.claude/CLAUDE.md` on your machine, so rendering a project's facts into it would mean the last project you opened wins and every other project's agents read someone else's context. Project-scope facts go to project roots; the user-scope files hold only what is true in every repo. Two Stations working the same project share one file rather than getting one each — what narrows a Station is its role and its leash, not a private copy of your memory.

Generated content lives between markers, so a hand-written `CLAUDE.md` survives untouched, and committing the generated block is your call: it is how a teammate without Cuesheet gets the same context.

Why both static files *and* an MCP server: files cost nothing and are always loaded, including by local models that will never reliably decide to call a tool. The MCP server carries the long tail that would blow your context budget if it were pasted into every session.

Captured memories land in an **approval inbox**, not straight into the store — without a gate, agent-written memory drifts, duplicates, and quietly poisons every future session. Provenance is attached to every entry: which Station, which Run, when.

Sync is a git remote you control. Your laptop, your desktop, and the box in the corner see the same knowledge. It is plain markdown in a repo you own — you can read it, grep it, diff it, and leave.

### 🔌 Connectors, once

MCP is the common substrate — every major harness speaks it — but each one reads a different config file. Declare a connector once:

```toml
[[connector]]
id      = "postgres"
command = "npx"
args    = ["-y", "@modelcontextprotocol/server-postgres", "$DATABASE_URL"]
grant   = ["opus", "codex"]        # which Stations get it
```

Cuesheet renders it into `.mcp.json` and `~/.codex/config.toml` and keeps them in sync.

> **Known limit, stated honestly:** vendor-hosted connectors (the Gmail/Drive/Microsoft 365 integrations managed inside claude.ai) hold OAuth grants tied to that vendor's account and **cannot** be shared with another vendor's agent. To give every Station the same reach you must run your own MCP servers against your own OAuth clients. Cuesheet will help you wire them; it cannot repeal the constraint.

### 🪙 The context economy

📋 **Not built.** A gated two-model workflow burns roughly 3× a single session — that is the honest price of a second opinion and it is not going away. What *is* going away is the waste around it.

| Lever | What it does | Why it is Cuesheet's to pull |
|---|---|---|
| **Cache-aware ledger** | Separates cached input from fresh input, per run and per Station | Cached input is billed at a fraction of fresh. Both CLIs already report it and Cuesheet currently throws it away — Claude Code's figures get summed into one input total, Codex's `cached_input_tokens` is dropped. So today the ledger can tell you what a run cost and not why |
| **Brief budgets** | A byte cap on what a Station is handed, eliding whole files with a note rather than truncating mid-hunk | A reviewer gets the whole workspace diff today. Regenerate a lockfile and you have sent every line of it to a second vendor at full price |
| **Path-weighted gates** | `always_review` / `never_review` globs alongside `skip_if_diff_under` | A line count is blind in both directions: five lines of auth is worth a review, five hundred lines of vendored bump is not |
| **Repo map** | A stable symbol index in the projected context — files, exports, where they live | The biggest token sink in an agent run is rediscovering a repo that has not changed since yesterday. A captured Codex run in this repo opens with `rg --files` and a `cat` loop hunting for `AGENTS.md` |
| **Context audit** | What every always-loaded file costs, per run, times the Stations that load it | A 40k-token hand-written `CLAUDE.md` is paid on every run by every Station forever, and no tool tells anybody |
| **Local first pass** | Triage, labelling and commit messages on a `worker` Station | The cheapest token is the one a local model spent. This is the same argument On-Call makes, applied to ordinary work |

**Everything generated must be byte-stable when nothing changed.** Prompt caching is prefix-based — one reordered line near the top of a context file invalidates the whole cache behind it, and a miss on 30k tokens costs an order of magnitude more than a hit. So no timestamps, no run ids and no `readdir`-ordered maps in anything Cuesheet writes into context.

**Token counting is local and approximate, and says so.** The exact answer lives behind a vendor endpoint, and Cuesheet never holds the key to call one.

### 🔀 One set of features, every harness

Each CLI has something the other lacks, and neither can lend it across. The point of a manager is that the feature becomes yours rather than your vendor's.

| What you would miss | Claude Code | Codex | The Cuesheet concept that covers both |
|---|---|---|---|
| A second opinion | subagents, same vendor only | — | **Stations + Gates** — any vendor reviews any other, and `distinct_vendors` makes it structural |
| Always-loaded memory | `CLAUDE.md` | `AGENTS.md` | **The Commons** — one store, both files, per project |
| Named repeatable workflows | slash commands, skills | prompts | **Cuesheets** — the same named flow whichever model runs it |
| Run something after every change | hooks | none in 0.154.0 | **Hook cues** — a cue kind, so every harness has hooks, including local models |
| Propose before doing | plan mode | — | **The Caller** — vendor-neutral, and the plan is config you can keep |
| Undo a bad run | rewind | — | **Run records** — every run stores its patch; reverse-apply it |
| Scoped permissions | `--permission-mode` | `--sandbox` | **Roles + leashes** — one vocabulary, mapped onto whichever flag the CLI speaks, and enforced in the daemon either way |
| Pick up where you left off | its own sessions | its own sessions | **Run records** — honestly, this re-briefs from the record; it cannot resume a vendor's own session state, which lives in their store |
| Connectors | `.mcp.json` | `~/.codex/config.toml` | **Declare once** — rendered into both |

**The vendor columns describe what this repo has actually exercised** — `codex` 0.154.0, whose flags were read out of `--help` rather than recalled, and `claude-code` as captured in `packages/harness/src/fixtures/`. Both churn; the right-hand column is the part that is meant to survive them.

**The mechanism is the cue list, which is why most of this is cheap.** Cues were an ordered list before Gates existed, and a gate turned out to be a cue kind; a hook is one too. The one place this does *not* work is worth stating: a harness cannot currently say what it supports — there is no `capabilities` on the interface — so "use plan mode if the runtime has one" has nowhere to live yet. That is a real gap, not a rounding error, and [PLAN-STEP.MD](PLAN-STEP.MD) Step 61 is where it gets decided.

### 🛡 Leashes

Per-Station path allowlists, deny globs, and command policy. Secret redaction runs on prompts and diffs *before* they leave the machine, with a rule pack you can extend. A Station denied `infra/**` cannot write there even if the model decides it should — the check lives in the daemon, not in a system prompt. Every denial is recorded.

### 📼 Run records

Every Run is a durable object: prompt, brief, diff, verdicts, tool calls, denials, standbys, cost, memories written. Replay it, share it, diff two attempts, or attach it to a PR. This is the CI-run equivalent for the thing that now writes most of your code.

---

## How it works

```
                    ┌──────────────────────────────────────┐
   iPhone ─────────▶│                                      │
   iPad             │           Cuesheet UI                │◀──── Desktop app
   Laptop ─────────▶│   (one app, served to every device)  │      (native shell)
                    └──────────────────┬───────────────────┘
                       tailnet / LAN   │  HTTP + WebSocket
                                       ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                     cuesheetd  ·  the daemon                       │
   │                                                                    │
   │   Queue      Leashes      Gates       Limits      Run store        │
   │   cues,      paths,       N-of-M,     windows,    diffs, verdicts, │
   │   priority   redaction    vendors     fallback    replayable       │
   │                                                                    │
   │   ┌──────────────────────┐      ┌──────────────────────────────┐   │
   │   │      Commons         │      │      Connector registry      │   │
   │   │  git-backed memory   │      │  one source → every harness  │   │
   │   │  + MCP recall server │      │  config format               │   │
   │   └──────────┬───────────┘      └───────────────┬──────────────┘   │
   └──────────────┼──────────────────────────────────┼──────────────────┘
                  │  projections + recall            │  MCP wiring
                  ▼                                  ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                    Harnesses  (subprocess, on host)                │
   ├──────────────────┬──────────────────┬──────────────────────────────┤
   │  claude-code     │  codex           │  ollama                      │
   │  engineer        │  reviewer        │  worker                      │
   │  reads CLAUDE.md │  reads AGENTS.md │  reads injected context      │
   └──────────────────┴──────────────────┴──────────────────────────────┘
                                  │
                                  ▼
                        your repos, on disk
```

**Daemon-first, on purpose.** `cuesheetd` is the product. The desktop app is a client of it, and so is your phone, and so is the CLI, and so is the HTTP API. Anything you can do by tapping a tile you can do in a script or in CI. It is also what lets the same binary run headless on a machine in the corner while you drive it from a laptop.

**Harnesses run on the host, not in containers.** Two hard-won reasons: agents are I/O-storm workloads, and bind-mounting a Windows path into a Linux container is genuinely unusable; and the major CLIs authenticate interactively and cache tokens on the machine. Optional per-workspace isolation is on the roadmap for people who want it — it is not the default, because the default has to work.

---

## Supported harnesses

| Harness | Vendor | Roles | Status |
|---|---|---|---|
| `claude-code` | Anthropic | engineer, reviewer | ✅ Working — caller needs M6 |
| `mock` | none | engineer | ✅ Working — ships on purpose, for developing against without burning tokens |
| `codex` | OpenAI | engineer, reviewer | ✅ Working — the second vendor a Gate needs. Caller needs M6 |
| `ollama` | local | worker | ✅ Working — worker only, and it refuses any other seat rather than warning about it. Lists the models actually pulled on your machine |
| `gemini-cli` | Google | engineer, reviewer | 📋 Planned |
| `opencode` | community | engineer | 📋 Planned |
| `cursor-cli` | Cursor | engineer | 📋 Planned |
| `lmstudio` | local | worker | 📋 Planned |

**A harness is meant to be replaceable.** That is the thesis of the whole project: the one on top today will not be the one on top in two years, and the cost of that change should be a dropdown, not a migration. Adding a harness is the single most valuable contribution you can make.

---

## Writing a harness

A harness is a small TypeScript module implementing one interface. It does not need to understand Gates, the Commons, limits, or the Desk — the daemon handles all of that.

```ts
import type { Harness, RunContext, RunResult } from "@cuesheet/harness";

export default {
  id: "my-agent",
  vendor: "acme",
  roles: ["engineer", "reviewer"],

  // How Cuesheet knows it's installed and authenticated
  async probe() {
    return { installed: await which("my-agent"), authed: await checkAuth() };
  },

  // What this runtime reports about plan usage, for the limits strip
  async usage() {
    return [{ window: "5h", used: 0.71, resetsAt: "2026-09-01T18:00:00Z" }];
  },

  // Where this runtime expects always-loaded context, so the Commons can project into it
  contextFiles: [{ path: "MY_AGENT.md", scope: "project" }],

  // Optional. What *your own* sandbox does with a seat, so the Desk can say who
  // enforces what. Leave it out and Cuesheet reports your harness as "does not
  // say" rather than guessing that nothing is confined. The answer for a seat
  // you did not list in `roles` is never read.
  confinement(role) {
    return role === "reviewer" ? "read-only" : "workspace-write";
  },

  // How to register MCP connectors for this runtime
  async writeConnectors(connectors) { /* ... */ },

  // Do the work. Stream events; raise standbys; return a structured result.
  async run(ctx: RunContext): Promise<RunResult> {
    const proc = spawn("my-agent", ["--prompt", ctx.brief, "--json"]);
    for await (const ev of parse(proc.stdout)) ctx.emit(ev);
    return { diff: await ctx.workspace.diff(), cost: ctx.meter.total() };
  },
} satisfies Harness;
```

Full spec in [`docs/harnesses.md`](docs/harnesses.md). Harnesses are versioned independently and can live outside this repo.

---

## Configuration

The app writes this for you. You can also write it yourself — one file, `cuesheet.toml`, in your project or at `~/.cuesheet/`.

```toml
[desk]
name = "api-team"

# ── Stations ────────────────────────────────────────────────
[[station]]
id        = "opus"
harness   = "claude-code"
role      = "engineer"
model     = "opus"
workspace = "~/code/api"
paths     = ["src/**", "tests/**"]      # may touch
deny      = ["**/*.env", "infra/**"]    # may not, ever

[[station]]
id      = "codex"
harness = "codex"
role    = "reviewer"

[[station]]
id      = "qwen"
harness = "ollama"
role    = "worker"
model   = "qwen3-coder"

# ── Gates ───────────────────────────────────────────────────
[gate.default]
require            = "1-of-1"
distinct_vendors   = 2
blocking           = ["security", "correctness"]
skip_if_diff_under = 20

# ── Cuesheets ───────────────────────────────────────────────
[cuesheet.ship]
cues = [
  { station = "opus",  action = "implement" },
  { station = "codex", action = "review", mode = "adversarial" },
  { gate    = "default" },
  { station = "qwen",  action = "commit-message" },
]

# ── Caller (optional) ────────────────────────────────────
[caller]
station  = "opus"
budget   = 4000
autorun  = false
min_gate = "default"

# ── Limits ──────────────────────────────────────────────────
[limits]
warn_at     = 0.85
block_at    = 0.97
when_capped = { codex = "qwen" }

# ── On-Call ────────────────────────────────────────────────
[oncall]
enabled       = true
workspace     = "~/code/api"
branch_from   = "deployed"
budget        = 15000
max_per_hour  = 3
dedupe_window = "30m"
cues = [
  { station = "qwen",  action = "triage" },
  { station = "opus",  action = "patch",  require_failing_test = true },
  { station = "codex", action = "review", mode = "adversarial" },
  { gate    = "hotfix" },
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

# ── Commons ─────────────────────────────────────────────────
[commons]
store      = "~/.cuesheet/commons"
sync       = "git@github.com:you/commons.git"
project_to = ["CLAUDE.md", "AGENTS.md"]
mcp        = true
approval   = "inbox"          # inbox | auto | off

# ── Devices ─────────────────────────────────────────────────
[remote]
bind    = "127.0.0.1:7373"
tailnet = true
pairing = "qr"
```

Then: `cuesheet ship "add rate limiting to the upload endpoint"`.

---

## Security and privacy

Cuesheet runs agents that execute code and reads secrets adjacent to them. Treat it accordingly.

- **No credential proxying.** Cuesheet never stores, forwards, or sees a model API key. Harnesses invoke CLIs you authenticated yourself.
- **No account, no cloud, no telemetry.** There is no hosted tier, no relay, no analytics, and nothing to sign up for.
- **Loopback by default.** Remote access is opt-in and goes over your own tailnet. Cuesheet will not open a port to the internet.
- **Short-lived pairing tokens**, per-device, individually revocable, listed in the UI.
- **Redaction before egress.** Prompts and diffs pass a secret scanner before leaving the machine.
- **Leashes are enforced in the daemon**, not requested in a prompt.
- **Every denial, standby, and tool call is recorded** in the Run.

Cuesheet has not been audited. Do not expose the daemon to an untrusted network. Report vulnerabilities per [SECURITY.md](SECURITY.md) rather than in a public issue.

---

## Roadmap

| Milestone | Contents | State |
|---|---|---|
| **M0 · Spine** | Daemon, run queue, `claude-code` harness, CLI, run records | ✅ macOS **and** Windows — except the CLI, which is still an empty package |
| **M1 · Desk** | Desktop app (macOS first), add-station flow, live tiles, streams, tray | ✅ Desk, shell, tray and packaging done on both; signing still open. A rebuild around projects is sequenced next |
| **M2 · Limits** | Usage windows per vendor, pre-run warnings, fallback routing, ledger | ✅ Done — with the honest caveat that most vendors report less than the strip can draw |
| **M3 · Pocket** | QR pairing, tailnet serving, mobile standby/GO, push, device revocation | 📋 |
| **M4 · Commons** | Git-backed store, projections, MCP recall, capture hooks, approval inbox, cross-device sync | ◐ Store and projections done |
| **M5 · Gates** | `codex` harness, reviewer role, verdict parsing, Gates, Holds | ✅ Done — two real vendors, end to end |
| **M6 · Caller** | `caller` role, `cuesheet plan`, proposal review, save-as-cuesheet | 📋 |
| **M7 · On-Call** | Triggers, triage/patch/review cuesheet, hotfix gate, storm control, incident records | 📋 |
| **M8 · Fleet** | Multiple machines as nodes; run on the desktop from the laptop | 📋 |
| **M9 · Ecosystem** | Harness SDK published, `gemini-cli` + `opencode`, connector registry, policy packs | 📋 |
| **M10 · Economy** | Cache-aware ledger, brief budgets, path-weighted gates, repo map, context audit | 📋 |
| **M11 · Parity** | Hooks as cues, rewind from a run record, harness capability probing | 📋 |

**This table is a catalogue, not a running order.** It numbers features for a reader deciding whether to care; what gets built next is decided in [PLAN-STEP.MD](PLAN-STEP.MD), and the two have already diverged — M5 · Gates was built well ahead of M2–M4. The current order puts **projects and a rebuilt Desk ahead of M2 and M4**, because "open the app on the repo you were working on yesterday" is missing from this table entirely, and both of those milestones need it before they can be scoped.

Later candidates: optional container isolation per workspace, [Agent Client Protocol](https://agentclientprotocol.com) as a transport so one harness covers many runtimes, CI mode, team-shared Commons with review.

---

## Non-goals

Stating these up front so nobody files the issue.

- **Not a model provider.** Cuesheet ships no weights and no inference.
- **Not a hosted service.** It runs on your machines. There is no cloud tier and no account.
- **Not an IDE or an editor.** It manages agents; you keep your editor.
- **Not a credential broker.** Bring your own auth, always.
- **Not an autonomous manager.** A Caller may propose a plan; it never approves, executes, or relaxes a Gate. If you want a system that decides and acts while you sleep, this is the wrong tool on purpose.
- **Not auto-remediation.** On-Call prepares a reviewed patch and stops. It never merges, deploys, restarts, scales, or rolls anything back. If you want a system that fixes production without you, this is the wrong tool on purpose.
- **Not a benchmark suite.** It won't tell you which model is better — it lets you make them check each other.

---

## Contributing

Contributions welcome, especially:

1. **Harnesses.** The highest-leverage contribution. See [`docs/harnesses.md`](docs/harnesses.md).
2. **Triggers.** Sentry, PagerDuty, Datadog, Grafana, CI — On-Call is only as good as the signals it can listen to.
3. **Usage reporting.** Every vendor exposes limits differently, and some barely expose them at all.
4. **Verdict parsing.** Turning free-text review output into structured findings with categories is where most of the difficulty lives.
5. **Mobile UX.** Answering a standby one-handed, correctly, in eight seconds is a real design problem.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. This project integrates against several fast-moving upstreams — harness churn is the permanent tax, and keeping harnesses thin and isolated is a design rule, not a preference.

---

## FAQ

**Isn't this just another web UI for Claude Code?**
No, and if it ends up being that, it has failed. What Cuesheet adds is the part nobody has shipped: memory that outlives the harness, roles and gates as enforced structure rather than prompt convention, usage across every vendor on one strip, and a durable record of every run. The Desk is how you touch that, not what it is.

**Why would I need a manager when the harness already has subagents?**
Because a vendor's orchestration only ever reaches their own models. It cannot give you a second opinion from a competitor, a memory store both companies read, one view of usage across your plans, or a setup that survives you switching. Those four things are what Cuesheet exists to own.

**So is an AI managing the whole thing, or isn't it?**
Neither, exactly. Execution is deterministic — declared cuesheets, enforced gates, no model in the control path. *Planning* can be delegated to a Caller Station, which proposes a cuesheet you approve, edit, or save as permanent config. Models are good at suggesting a shape and bad at being a scheduler you can't audit.

**How is the phone mode different from a vendor's remote agent?**
It runs on your machine, against your working tree, with your credentials, over your tailnet. No relay, no cloud worker, no copy of your repo anywhere else. And it is a control surface for *all* your agents at once, not one session with one vendor.

**Will On-Call push code to production while I'm asleep?**
No. It opens a branch and a PR, and that is the end of its authority. It cannot merge, cannot reach your infrastructure, and cannot arm at all without a reviewer from a second vendor. If it could not reproduce the bug with a failing test, it does not hand you a patch — it hands you what it found and stops.

**Can I use only local models?**
Yes, and Cuesheet runs fully offline. It warns you when a `worker`-class model is placed in a `reviewer` seat, because that combination produces false confidence rather than safety — the daemon says so at `GET /stations`, while you are still writing the config rather than three steps into a run.

**What does it cost to run?**
Cuesheet is free. The models are not. A gated two-model workflow runs roughly 3× the tokens of a single session — which is why `skip_if_diff_under` exists and why limits and the ledger are headline features rather than footnotes.

**Does my code or memory leave my machine?**
Only to the model vendors you configured, exactly as it would if you ran their CLI directly. Cuesheet adds no telemetry, no relay, and no analytics.

**Windows and Linux?**
Yes — first class. macOS ships first because that is where the build is furthest along, not because the others are second-tier.

---

## License

[Apache-2.0](LICENSE). Permissive, with an explicit patent grant.
