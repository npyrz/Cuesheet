# The Commons and projections

## What exists now

The Commons is one global directory at `~/.cuesheet/commons`. Each fact is a Markdown file with TOML frontmatter. The store can read, list, write, delete, report history, and synchronize through an operator-owned Git remote. Mutations try to commit through git with a Cuesheet-specific identity and report whether the commit succeeded.

Git is optional at runtime. If it is unavailable, fact files are still written and the API reports that history was not recorded. The store remains readable with ordinary filesystem and git tools.

```mermaid
flowchart LR
    API[Global Commons API]
    Store[Commons store]
    Fact[One fact per Markdown file]
    Git[Git history when available]
    Projector[Serialized projector]
    Context[Harness context files]
    MCP[Streamable HTTP MCP recall]
    Remote[Operator-owned Git remote]

    API --> Store
    Store --> Fact
    Store --> Git
    Store --> Projector
    Projector --> Context
    Store --> MCP
    Store <--> Remote
```

## Fact scope

A fact with no project ids belongs to the user layer. A fact with project ids belongs only to those projects. An empty project list is not a wildcard copied into every repository.

```mermaid
flowchart TB
    Facts[Global fact store]
    User{projects list empty?}
    UserFiles[User context files]
    ProjectFilter[Match each registered project id]
    ProjectFiles[Project-root context files]

    Facts --> User
    User -->|yes| UserFiles
    User -->|no| ProjectFilter --> ProjectFiles
```

Current targets come from live `Harness.contextFiles` declarations rather than a daemon-owned filename list:

- Claude Code: `<project>/CLAUDE.md` and `~/.claude/CLAUDE.md`;
- Codex: `<project>/AGENTS.md` and `~/.codex/AGENTS.md`;
- mock: `<project>/MOCK.md`;
- Ollama: no always-loaded file, so the executor assembles approved user and
  project facts into its brief.

## Safe, stable projection

```mermaid
sequenceDiagram
    participant M as Commons mutation or boot
    participant P as Projector queue
    participant S as Commons store
    participant R as Project registry
    participant F as Context file

    M->>P: regenerate
    P->>S: list facts
    P->>R: list available projects
    P->>P: filter by scope and sort by fact id
    P->>F: read existing bytes
    P->>P: replace only Cuesheet marker block
    alt bytes changed
        P->>F: write updated file
    else identical
        P-->>M: unchanged
    end
```

Generated content lives between `<!-- cuesheet:begin -->` and `<!-- cuesheet:end -->`. Everything outside that pair is preserved byte for byte. A missing pair is appended; incomplete or duplicate markers cause an error instead of a guess. Targets must remain beneath their declared user or project root.

Projection work is serialized so adjacent writes cannot finish out of order and resurrect deleted content. Output has deterministic ASCII-id ordering, no timestamps, and no run-specific noise. An identical projection is not rewritten, protecting both clean diffs and prefix-based prompt caches.

## Lifecycle

Regeneration currently happens after Commons mutations, successful pulls and conflict resolutions, at daemon boot, and when a new project is opened. Missing project roots are skipped rather than recreated.

## Recall and capture

```mermaid
flowchart LR
    Capture[Captured memory]
    Inbox[Approval inbox]
    Store[Committed Commons fact]
    Static[Static projection]
    Recall[MCP memory search and write]
    Sync[Operator-owned Git remote]

    Capture --> Inbox
    Inbox --> Store
    Store --> Static
    Store --> Recall
    Store <--> Sync
```

The daemon serves stateless Streamable HTTP MCP at `/mcp`. Claude Code and
Codex register it through their own CLI configuration commands. `memory_search`
can search a project's user-plus-project scope or, when the project is omitted,
the global operator-owned store. `memory_write` requires project, Station, and
Run provenance and enters the same `inbox` or `auto` approval path as the HTTP
capture route.

Sync configuration lives in the Commons repository as its `origin`, not in a
project's `cuesheet.toml`: one global store cannot safely take its destination
from whichever project loaded last. The Desk and global HTTP routes expose
configure, pull, push, and continue-after-resolution operations.

Before network work, local edits are committed so no operator change is hidden
inside a merge. Pull fetches and invokes Git's normal merge, including for two
independently initialized Commons histories. A clean merge proceeds; a textual
conflict remains in the working tree with both sides and is returned to the
Desk. No `ours`, `theirs`, rebase, force push, or automatic abort is used.
Regular fact mutations refuse to create history while unmerged paths remain.
After a human edits the listed files, an explicit continuation stages and
commits the resolution. Operations on one daemon are serialized so a fact
commit cannot overlap a fetch or merge.
