# Desktop, API, and events

## Client topology

```mermaid
flowchart TB
    Electron[Electron main process]
    Preload[Sandboxed preload bridge]
    Desk[React Desk]
    Existing[Existing cuesheetd]
    Embedded[In-process cuesheetd]
    API[HTTP and project WebSocket]
    Tray[Tray and notifications]

    Electron -->|start if port is free| Embedded
    Electron -->|attach if healthy daemon owns port| Existing
    Embedded --> API
    Existing --> API
    Electron --> Preload --> Desk
    Desk --> API
    Embedded --> Tray
```

Electron starts the real harness runtime in-process. If port `7373` already belongs to a healthy Cuesheet daemon, the shell attaches to it and does not own or stop it. The renderer receives only a small preload bridge for API location, folder selection, platform details, and active-project display.

The shell's direct access to the in-process global event bus is only for native notifications. The Desk always uses the network contract. When attached to an external daemon, the shell currently has no native notification stream, while the Desk still receives project events over WebSocket.

## Current routes

The daemon registers the same surface at the root and under `/api`. The table
uses the root form; the browser development server normally reaches it through
the `/api` prefix.

| Scope | Route | Purpose |
|---|---|---|
| Global | `GET /health` | Liveness and daemon version |
| Global | `GET /usage` | Harness plan windows |
| Global | `GET /commons` | List facts |
| Global | `GET /commons/history` | Git-backed history or a reason it is unavailable |
| Global | `GET /commons/:id` | Read one fact |
| Global | `POST /commons` | Write a fact and regenerate projections |
| Global | `DELETE /commons/:id` | Delete a fact and regenerate projections |
| Global | `GET /projects` | List registered projects |
| Global | `POST /projects` | Open or register a project |
| Global | `POST /standbys/:id` | Answer `go` or `no` |
| Project | `GET /projects/:id` | Project detail |
| Project | `DELETE /projects/:id` | Forget registry entry without deleting files |
| Project | `GET /projects/:id/stations` | Stations, probes, cuesheets, limits, warnings |
| Project | `POST /projects/:id/stations` | Add a Station and reload config |
| Project | `GET /projects/:id/runs` | List run summaries |
| Project | `POST /projects/:id/runs` | Validate and enqueue a run |
| Project | `GET /projects/:id/runs/:runId` | Run record and event history, excluding patch bytes |
| Project | `GET /projects/:id/runs/:runId/diff` | Fetch the patch on demand |
| Project | `POST /projects/:id/runs/:runId/stop` | Stop queued or active work |
| Project | `GET /projects/:id/ledger` | Project spend aggregation |
| Project | `GET /projects/:id/ws` | Project-only event stream and bounded replay |

These Desk routes are loopback-only and unauthenticated. Pocket's separate listener exposes only pairing, authenticated standby reads/answers and device disconnect. Tailscale Serve supplies private HTTPS; it must target Pocket on port 7374, never the unrestricted Desk on 7373. See [Pocket's route and access contracts](../pocket.md).

## Live events and reconnect

The wire event is a discriminated union: status, text, tool, file, standby, denial, cost, verdict, done, or error. Every event carries a run id and timestamp; Station-specific variants also carry a Station id.

```mermaid
sequenceDiagram
    participant D as Desk
    participant W as Project WebSocket
    participant A as HTTP API
    participant R as Reducer

    D->>W: connect /projects/:id/ws
    W-->>D: bounded backlog then live events
    D->>D: buffer events during resync
    par authoritative snapshot
        D->>A: GET runs
        D->>A: GET stations
    end
    A-->>D: project snapshot
    D->>R: replace project state
    D->>A: GET selected run detail
    A-->>D: durable event history
    D->>R: apply run detail
    D->>R: flush buffered live events in arrival order
```

The replay buffer is a convenience, not the authority. On each socket open the Desk fetches durable runs and Station state, buffers events arriving during that fetch, installs the snapshot, then replays the buffer. It uses a project-switch epoch so a slow response from the project just left cannot overwrite the one now visible.

Unknown run ids seen in live events are adopted with `GET /runs/:runId`; this supports work started by another client. Project switching closes one subscription and opens another but sends no stop or active-project mutation to the daemon.

## Native-only responsibilities

Electron owns native lifecycle and presentation: single-instance behavior, window creation, close-to-tray behavior, start-at-login, notifications, native folder selection, and clean shutdown of a daemon it owns. Starting runs, adding Stations, listing projects, and answering standbys remain API operations.

## Phone and terminal clients

The terminal client controls projects, Stations, runs and standbys through the Desk API. Pocket pairs through a one-time QR and reads/answers standbys across projects using expiring, revocable credentials. The phone polls every three seconds and resyncs when it returns to the foreground. Background push, actual tailnet/physical-phone acceptance and the independent network-security review remain open.
