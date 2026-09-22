# Architecture and components

## Design center

The daemon is the product. The Desk, Electron shell, future CLI, and future phone are clients of the same HTTP and WebSocket API. Product behavior belongs behind that API; Electron is packaging and native integration, not a second backend.

The daemon currently binds to `127.0.0.1:7373`. It is intentionally unauthenticated while it is loopback-only. Network serving, pairing, revocation, and phone access are planned and must add an authentication boundary before widening exposure.

```mermaid
flowchart LR
    subgraph Clients
        Desk[React Desk]
        Shell[Electron shell]
        FutureCLI[CLI - planned]
        Phone[Phone - planned]
    end

    subgraph Daemon[cuesheetd]
        API[HTTP and WebSocket]
        Registry[Project registry]
        Runtimes[Project runtimes]
        Usage[Usage cache]
        Memory[Commons store and projector]
    end

    subgraph Host[Host machine]
        Harness[Harness registry]
        Vendor[Agent CLI or local runtime]
        Repo[Project workspace]
        Disk[Run and config files]
    end

    Shell --> Desk
    Desk --> API
    FutureCLI -.-> API
    Phone -.-> API
    API --> Registry
    API --> Runtimes
    API --> Usage
    API --> Memory
    Runtimes --> Harness
    Harness --> Vendor
    Vendor --> Repo
    Runtimes --> Disk
```

## Package dependency direction

Dependencies point in one direction. UI and Electron consume the daemon contract; the daemon adapts harnesses; harnesses consume core vocabulary.

```mermaid
flowchart LR
    Core[packages/core]
    Harness[packages/harness]
    Daemon[packages/daemon]
    UI[packages/ui]
    CLI[packages/cli]
    Desktop[packages/desktop]

    Core --> Harness
    Harness --> Daemon
    Daemon --> UI
    Daemon --> CLI
    Daemon --> Desktop
    UI --> Desktop
```

The arrows mean “is depended on by.” The important boundary is that `core` has no process-running concerns, and harnesses do not import the daemon. `packages/daemon/src/harness-executor.ts` is the composition adapter that knows both sides without creating a cycle.

| Package | Current responsibility |
|---|---|
| `core` | Domain and wire types, config schemas, roles, leashes, gates, limits, project registry, Commons fact format, paths |
| `harness` | Harness interface, registry, process/workspace helpers, built-in `mock`, `claude-code`, `codex`, and `ollama` adapters |
| `daemon` | API, project runtimes, queues, execution, event buses, run storage, usage cache, Commons storage, projection and MCP recall |
| `ui` | Responsive React Desk; project, run, limits, ledger, and first-run surfaces |
| `desktop` | Electron lifecycle, daemon ownership/attachment, preload bridge, tray, notifications, native folder picker |
| `cli` | Empty package today; a real client is planned for Phase 13 |

## Current and planned boundary

```mermaid
flowchart TB
    Current[Current source]
    Planned[Planned work]

    Current --> C1[Multi-project daemon and Desk]
    Current --> C2[Sequential cues and Gates]
    Current --> C3[Limits, ledger, fallback]
    Current --> C4[Commons store, approval, projections, recall]

    Planned --> P1[Commons cross-machine sync]
    Planned --> P2[Working CLI]
    Planned --> P3[Phone pairing and remote access]
    Planned --> P4[SQLite, migration framework, signing]
    Planned --> P5[Caller, On-Call, fleet, ecosystem]
```

The UI is already responsive, but that is not the same as having a phone client. Likewise, the CLI package exists, but its command surface does not.
