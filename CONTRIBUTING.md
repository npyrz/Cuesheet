# Contributing to Cuesheet

Cuesheet is on the beta development track; the signed-beta acceptance bar is
still open. Start with the [README](README.md), [current build plan](PLAN-STEP.MD)
and [engineering rules](AGENTS.md). The [code of conduct](CODE_OF_CONDUCT.md)
applies to issues, reviews and other project spaces.

## Choose a contribution

- Report a reproducible defect with the [bug form](https://github.com/npyrz/Cuesheet/issues/new?template=bug_report.yml).
- Propose a behavior change with the [feature form](https://github.com/npyrz/Cuesheet/issues/new?template=feature_request.yml).
- Add a runtime using the [harness guide](docs/harnesses.md), which includes a
  runnable example and the contract checks expected in a first PR.
- Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not a
  public bug report or pull request.

A small fix or documentation correction can go straight to a PR. For a new
subsystem, breaking format change, or added runtime dependency, open an issue
describing the problem and proposed scope first so review starts with the same
assumptions. Check existing issues and the plan before duplicating work.

## Set up a checkout

Use Node.js 22 or newer, npm and Git on macOS or Windows. Fork the repository,
clone your fork, and create a branch from the current development branch,
`beta`. Target `beta` when opening the PR; `main` is the release channel.

```bash
git clone https://github.com/YOUR-USERNAME/Cuesheet.git
cd Cuesheet
git switch beta
git switch -c your-change
npm ci
npm run build
```

The workspace packages are private and are not an installable public npm SDK.
Run commands from the repository root unless a command specifies a workspace.
No model account is needed to build or run the default tests. Use the shipped
`mock` harness for a free demo in a disposable workspace.

For the desktop: `npm run dev -w packages/desktop`. For browser work, run
`npx cuesheetd` in one terminal and `npm run dev -w packages/ui` in another,
then open `http://localhost:5173`. If Electron starts as Node and reports that
`app` is undefined, remove `ELECTRON_RUN_AS_NODE` from that terminal's environment.

## Make and verify a change

Keep behavior in the daemon's HTTP API; the Desk, CLI and Electron shell are
clients. Keep dependency direction `core ← harness ← daemon ← clients`.
Harnesses never import one another. Share helpers outside individual harnesses.

Run all five checks, in this order, before submitting:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

CI runs those checks on macOS and Windows. The desktop build strips types, so a
green build does not replace typecheck. Workspace imports resolve through
`dist/`; after a core export changes, rebuild core before checking its consumers.
Use `npx prettier --write path/to/changed-file.ts` for formatting. Markdown is
intentionally excluded from Prettier.

For a focused test: `npx vitest run packages/daemon/src/server.test.ts`.
Tests belong beside source as `.test.ts`; this repository does not collect
`.test.tsx`. Add regression coverage for behavior and failure paths, rather
than tests that restate implementation. Documentation-only corrections do not
need a new test.

Every test calling `startDaemon` must pass a temporary, isolated `HostEnv` and
`port: 0`. Otherwise it can write to the developer's real project registry.
Wait for observable conditions, not guessed sleeps. Real CLI runs are optional
and may spend money: set `CUESHEET_E2E=1` only when intentionally exercising
installed, authenticated harnesses. Captured, scrubbed streams provide the
offline CI evidence; never invent a vendor stream from memory.

Windows is a first-class target. Inject `HostEnv` to test platform behavior;
do not mock `process.platform`. Use `pathFor(env)` for path arithmetic and
ambient `node:path` for real filesystem operations, resolve symlinks before
containment checks, and use the harness spawning helper for `.cmd` support.
State what you actually exercised on each OS. A Windows CI pass is different
from having inspected a Windows UI or installer.

## Prepare the PR

Describe the concrete problem, resulting behavior, and validation. Include a
minimal reproduction for a bug and screenshots for visible UI changes. Name
any migration, role/sandbox, compatibility or release risks that changed.
If a check could not run, give the command and actual blocker.

Keep the README's status and the plan's done-when criteria honest. Add a concise
user-visible entry to [CHANGELOG.md](CHANGELOG.md)'s `Unreleased` section for
behavior changes, fixes and contributor-facing improvements. Do not change old
release history or claim that local work has shipped. Update docs when routes,
commands or configuration change. Review the diff for unrelated generated files,
credentials, private prompts and machine-specific paths before opening the PR.

Use a draft PR for work that is ready for discussion but still fails a stated
acceptance criterion. Signing credentials are not needed for PR checks; the
release workflow has a separate signing gate. Maintainers follow
[the release guide](docs/releases.md) for publishing and profile capture.

Contributions are made under the repository's [Apache-2.0 license](LICENSE).
