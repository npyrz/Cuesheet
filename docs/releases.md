# Source releases and updates

Cuesheet's primary distribution is a cloned repository, built locally and used
through the app, CLI or browser. This path does not need Apple or Windows
signing credentials. Signing belongs to the optional prebuilt installer path.

## Update a checkout

After the initial `npm install` and `npm run build`, from the Cuesheet checkout:

```bash
npm run update:check
# Stop the desktop app or standalone daemon, and any Vite dev server first.
npm run update
```

The script queries this repository's public GitHub releases, fetches its
exact tag from `https://github.com/npyrz/Cuesheet.git`, and compares commits.
Checks fetch Git metadata without modifying the checked-out source. Normal
updates choose the newest non-prerelease release. While only alpha/development
prereleases exist, they choose the newest published prerelease. To select a
specific published release explicitly:

```bash
npm run update:check -- --tag RELEASE_TAG
npm run update -- --tag RELEASE_TAG
```

Updates fast-forward a clean checkout, run `npm ci`, then rebuild all packages.
A running daemon, tracked edits, untracked files, a divergent checkout or a
concurrent updater refuses the operation. A checkout already ahead of a release
is left alone; no downgrade, forced reset, automatic stash or `git clean` runs.
If installation/build fails and the tracked checkout is still unchanged, the
script restores the previous commit and reinstalls/rebuilds it. If another
process edits tracked source during that attempt, it leaves the checkout alone
and reports the previous commit for manual recovery. Stop the Vite dev server
as well: the daemon lock detects Cuesheet, not a standalone Vite process.

Restart the app or daemon after success. Projects, configuration, Commons and
run history under `~/.cuesheet` are outside the updater's write path. Ignored
local files such as `.env` are preserved. Shallow clones may need a full fetch
to establish ancestry; unknown history is refused rather than overwritten.

## Check from any client

Source app and standalone daemon check at startup and every four hours.
The Desk offers **check for updates** on the launcher, an **updates** button
in a project, and a command palette action. The desktop menu uses the same
API. `npx cuesheet updates` checks through the daemon without needing an active
project. The independent `npm run update:check` command needs no running daemon.

| Route | Source behavior |
|---|---|
| `GET /updates` | Status, exact current/target revisions, release tag and terminal instructions |
| `POST /updates/check` | Coalesced release check, returns 202; poll status |
| `POST /updates/install` | Refuses source installation; stop Cuesheet and use the script |

Checks send ordinary GitHub API/Git requests; they do not upload prompts, run
history or telemetry. Offline/rate-limit errors leave the checkout usable.
No account token is required for this public repository. Unsigned packaged
apps have no source checkout to update; rebuild/install them manually or use
the optional signed installer updater below.

## Step 54 acceptance

The original Step 54 required signed installers and a terminal-free update.
On 2026-09-30 the maintainer clarified source checkout distribution as the
product's intended path. That replaces the acceptance requirement explicitly;
missing signing credentials no longer block Phase 13.

The source update tests use real Git repositories and real npm installation/
builds in paths containing spaces, with a local published-tag fixture. They
verify a stopped update, exact release selection, unchanged user files, refusal
of dirty/divergent/ahead/running states, API errors, HTTP access and restoration
of the previous checkout after a failed build. All five checks pass locally (1,130 tests passed, 9 skipped), and the Desk
dialog/retry was exercised with an isolated available-release fixture. The live
GitHub check correctly refuses a downgrade from this development checkout.
[Release run 36875660969](https://github.com/npyrz/Cuesheet/actions/runs/36875660969)
on 2026-10-01 passed all five checks and unsigned packaging on Windows for
`68c1290` (1,134 passed tests, 5 skipped). macOS failed an older stop-test
fixture race, now fixed locally. The canceled standalone CI run was retried;
[CI run 36875667986](https://github.com/npyrz/Cuesheet/actions/runs/36875667986)
passed all five checks on both platforms for `68c1290`, completing Step 54's
source acceptance. Push and verify the local fixture fix before merging; the
earlier Release failure remains recorded. Phase 13's source criteria are met,
but the named beta release has not been cut. Evidence is in `PLAN-STEP.MD`. Every new published release
still needs its own captured state profile for Step 53.

## Optional signed installers

Set repository Actions variable `CUESHEET_SIGNED_RELEASE=true` only when you
want signed downloadable installers, then configure the values below. This
is separate from source checkout updates and is not a Phase 13 prerequisite.

### Configure signing

Add these in the repository's **Settings → Secrets and variables → Actions**.
Keep certificates and passwords in secrets, never in the repository or chat.

| Kind | Name | Value |
|---|---|---|
| Secret | `MAC_CSC_LINK` | Base64 Developer ID Application `.p12`, including its private key |
| Secret | `MAC_CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| Variable | `MAC_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` identity |
| Secret | `APPLE_ID` | Apple developer account used for notarization |
| Secret | `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| Variable | `APPLE_TEAM_ID` | Developer team ID |
| Secret | `WINDOWS_CSC_LINK` | Base64 Windows Authenticode `.pfx`, including its private key |
| Secret | `WINDOWS_CSC_KEY_PASSWORD` | Password protecting that `.pfx` |
| Variable | `WINDOWS_PUBLISHER_NAME` | Publisher common name exactly as it appears in the certificate |

The Windows integration currently uses electron-builder 26's certificate-file
signing path. If the certificate lives in a hardware token or a cloud service,
adapt `win.signtoolOptions` or use `win.azureSignOptions` for the actual provider;
do not export a non-exportable key or disable signature verification. Provider
enrollment and certificate purchase are operator setup, not actions performed
by the release workflow. See the [electron-builder 26 Windows signing guide](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

The release configuration refuses missing credentials before packaging.
`forceCodeSigning` refuses unsigned output. macOS uses hardened runtime,
Developer ID signing and notarization; the workflow then validates the app's
signature, stapled ticket, and Gatekeeper assessment on both packaged
architectures. Windows verifies Authenticode on the app and installer.
Failure on either runner prevents publication. Notarization credentials are
explicitly required because electron-builder can otherwise skip notarization.
See [macOS notarization](https://www.electron.build/v26/docs/features/code-signing/notarization/).

### Installer release behavior

Every branch push builds optional unsigned convenience installers by default.
Source release checks use the published tag, not those installers. With
`CUESHEET_SIGNED_RELEASE=true`, packaging requires the credentials above and
fails if any are missing. Local `dist` and `pack:dir` builds remain unsigned.

CI stages the version before building every package: for example,
`0.1.0-alpha` becomes `0.1.0-alpha.123.1` (workflow run number and attempt).
This gives updates semver ordering; `+build` metadata would not. Source files
keep their current version. A source version without a prerelease suffix gets
`-build.RUN.ATTEMPT`, so automatic builds remain below the corresponding final
semantic version. When a final release is made, the next development line must
advance its base version.

Both runners must pass build, typecheck, lint, formatting and tests. Signed
builds also require platform signature verification, notarization and update
manifests. Installer, ZIP, update manifest and blockmap assets
are uploaded together to a draft; it becomes visible only after upload succeeds.
`main` becomes GitHub's Latest release. Other branches remain prereleases.

Only signed `main` builds enable the updater. It reads the public GitHub Latest
feed for `npyrz/Cuesheet`, checks on startup and every four hours, and downloads
a newer version. It never switches to a branch prerelease or downgrades. No GitHub
token is shipped to clients. `latest.yml` and `latest-mac.yml` are required release
assets; macOS keeps its ZIP target because the updater needs it.
See the [updater documentation](https://www.electron.build/v26/docs/features/auto-update/).

Choose **Check for updates…** from the application or tray menu, then
**Restart and install**. A download never installs merely because the app quits.
The confirmation explains that active and queued runs will be interrupted.
The daemon stops its queues and flushes history before the installer starts;
a shutdown error or timeout prevents installation. Failed checks/downloads are
reported and can be retried.

The same controls are available over HTTP:

| Route | Behavior |
|---|---|
| `GET /updates` | Current phase, version, progress or error |
| `POST /updates/check` | Start/coalesce a check and download; returns 202 |
| `POST /updates/install` with `{"confirm":true}` | Reserve a verified download, acknowledge, then restart; returns 202 |

They also have the normal `/api` aliases. An unsigned packaged app or packaged
branch build reports installer updates unavailable. Source apps and standalone
daemons supply the source release checker above. An attached shell uses whichever
service the existing daemon supplies; browser clients use those same routes.

## Changelog and release notes

Update `CHANGELOG.md`'s `Unreleased` section in the PR that changes behavior.
The publish job checks out the exact build commit and runs
`node scripts/release-notes.mjs release-notes.md` before creating a release.
Missing, duplicate or empty sections stop publication. No release notes are
assembled from unreviewed commit messages. The generated notes link back to the
changelog and release guide at that immutable commit.

Per-commit releases use the cumulative `Unreleased` section; do not empty it
after each branch push. At a named milestone, move its entries into a dated
`## [VERSION]` section, add the release link, and start the next `Unreleased`
section with actual pending changes. The generator supports `CHANGELOG_SECTION`
for a named section when used by a future named-release workflow. The current
push workflow continues to select `Unreleased` and does not publish semantic
milestones automatically.

To preview notes without publishing (POSIX shell):

```bash
GITHUB_REPOSITORY=npyrz/Cuesheet GITHUB_REF_NAME=beta GITHUB_SHA="$(git rev-parse HEAD)" node scripts/release-notes.mjs /tmp/cuesheet-release-notes.md
```

PowerShell:

```powershell
$env:GITHUB_REPOSITORY = "npyrz/Cuesheet"
$env:GITHUB_REF_NAME = "beta"
$env:GITHUB_SHA = git rev-parse HEAD
node scripts/release-notes.mjs "$env:TEMP/cuesheet-release-notes.md"
```

Review the generated changes and installation notes before publication. Existing
published entries in the changelog are historical records, not promises that
unreleased features were present in an older installer.
