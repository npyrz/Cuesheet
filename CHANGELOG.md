# Changelog

User-visible changes are written here before a release is cut. Per-commit
release notes take the `Unreleased` section at the exact released commit; it is
cumulative since the last named milestone, not a claim that every bullet first
arrived in that build. Published tags below identify actual installers.

## [Unreleased]

### Added

- Pocket: opt-in QR phone pairing, 24-hour revocable device sessions, private Tailscale HTTPS setup, and a foreground phone view for pending permissions and Gate Holds with GO/NO. A separate restricted listener exposes redacted summaries; the Desk API refuses non-loopback binds. Physical phone/tailnet acceptance and background push delivery remain open.

- Context cost audit in the Desk and `cuesheet context --runs N`: current declared files, projection subtotals, per-Station and repeated-cue estimates through a read-only daemon route. The Desk also displays prompt token estimates and files omitted from Gate reviews.

- Source checkout updates: app, browser and CLI check published GitHub releases; `npm run update:check` and `npm run update` select exact tags, refuse unsafe checkout states, rebuild and recover from failed builds. No signing subscription is required for the primary clone-and-run path.

- Multi-project daemon and rebuilt Desk with project switching, role/confinement information, usage limits, fallback routing and a cost ledger.
- Codex review alongside Claude Code, independent-vendor Gates and Holds, and worker-only Ollama inference.
- Git-backed Commons facts, projections, approval inbox, MCP recall and operator-owned Git sync.
- Terminal client for projects, Stations, runs and standbys; per-project SQLite run storage and version-aware upgrade checks.
- Optional signed-release configuration and installer updater with explicit restart confirmation. **Its credentials and installed-update acceptance are still outstanding; source checkout updates do not require them.**
- Contributor and harness guides, a runnable offline harness example, security policy, code of conduct, issue forms, PR template and changelog-based release notes.

- Hook cues: `{ hook = "format" }` runs `[hook.format]`'s command between Stations — the same way after any harness — with the run's id, status and own change on stdin. A failing hook fails the run unless `on_failure = "continue"`. Harnesses can declare `connectsMcp`; the daemon no longer decides which runtimes get Commons provenance by their id.

- Rewind: `cuesheet rewind RUN_ID` and `POST /projects/:id/runs/:runId/rewind` undo a finished run's own changes, all or nothing, refusing with the conflicting paths named when files have moved since. Runs now record their own change separately from the workspace diff, which also contains uncommitted work from before the run. Run history moves to SQLite schema 2; older builds refuse to open an upgraded database.

- Repo map: `[repo_map] mode = "projection"` adds a byte-stable map of the workspace's files and exported symbols to the project's context files, rebuilt at run start, parsed with WebAssembly tree-sitter grammars (no native module). Off by default; `GET /projects/:id/repo-map` previews it with an estimated token cost.

- Context audit: the project view's **Context** section, `cuesheet context` and `GET /projects/:id/context` show what every always-loaded context file costs a run. The audit multiplies each file by the Stations that load it, separates Cuesheet's generated block from hand-written text, and prices the total at the project's own observed price per input token. All figures are labelled as estimates.

- Brief budgets: `[limits] max_brief_bytes` bounds every brief, a reviewer's diff is cut in whole named files rather than mid-hunk, and Gates take `always_review` / `never_review` path rules. A skipped Gate no longer runs (or bills) its reviewer, and an over-budget prompt is refused before it is queued.

- Local crash/error diagnostics with bounded logs, interrupted-run context, path-free stack locations and a Desk preview/copy/download flow. Reports are never uploaded automatically.

### Fixed

- Stop-run integration test waits for the harness cancellation boundary, preventing a file-visibility race from hanging CI.

- Signing is opt-in for convenience installers; the default release workflow no longer fails merely because signing credentials are absent.

- SQLite schema creation and file-history import now commit together, so a failed import cannot mark an empty database as migrated.
- A project with newer state is refused without taking down the entire daemon.
- Selecting the file backend over SQLite history now refuses instead of displaying an empty or stale run list.
- SQLite release-profile capture preserves committed WAL history and safely relocates stored paths; Windows profile/Commons tests have explicit budgets for real HTTP/Git work.

### Compatibility and known limits

- The beta release bar remains open. Phone pairing, Caller automation and On-Call are not implemented.
- All five published releases now have captured profiles, including the first SQLite release. SQLite-to-files conversion is unsupported; incompatible selection leaves the database untouched.
- Signed release jobs refuse to publish without signing/notarization credentials. Local unsigned development builds remain available.

## [build-36170856000-bb9ab14] — 2026-09-25

- First published build with per-project SQLite history, migration logging, versioned config and captured upgrade-profile replay.
- Increased the SQLite scale-test timeout after Windows CI exposed its timing limit.
- Unsigned development prerelease; packaged application version remained `0.1.0-alpha`.

## [build-35811098632-8a7d891] — 2026-09-23

- Added the terminal daemon client and Commons Git sync since the previous published build.
- Stabilized Commons sync tests on Windows.
- Unsigned development prerelease; run storage was file-based.

## [build-35765620187-4cf40ba] — 2026-09-22

- Added Commons MCP recall and runtime connector registration.
- Unsigned development prerelease; run storage was file-based.

## [build-35749614938-150f136] — 2026-09-22

- First per-commit installer release on the beta development branch. Included the multi-project Desk, limits, Codex/Ollama, Gates, and Commons projection/inbox work developed after alpha.
- Unsigned development prerelease; run storage was file-based.

## [v0.1.0-alpha] — 2026-09-15

- First named milestone: local daemon, streaming Desk, mock and Claude Code harnesses, durable file-based run history, and Electron shell.
- macOS Intel/Apple Silicon DMG and ZIP downloads and a Windows x64 installer.
- Unsigned, single-project alpha without independent-vendor Gates or guaranteed upgrade compatibility.

[Unreleased]: https://github.com/npyrz/Cuesheet/compare/v0.1.0-alpha...beta
[build-36170856000-bb9ab14]: https://github.com/npyrz/Cuesheet/releases/tag/build-36170856000-bb9ab14
[build-35811098632-8a7d891]: https://github.com/npyrz/Cuesheet/releases/tag/build-35811098632-8a7d891
[build-35765620187-4cf40ba]: https://github.com/npyrz/Cuesheet/releases/tag/build-35765620187-4cf40ba
[build-35749614938-150f136]: https://github.com/npyrz/Cuesheet/releases/tag/build-35749614938-150f136
[v0.1.0-alpha]: https://github.com/npyrz/Cuesheet/releases/tag/v0.1.0-alpha
