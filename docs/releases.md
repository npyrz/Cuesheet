# Signed releases and updates

Step 54's code is built; its installed-machine acceptance check is still open.
On 2026-09-30 the audit again found no Actions signing secrets or variables,
and the development Mac had no valid code-signing identity. No signed release or
successful installed update is claimed by this document.

## Configure signing

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

## Release behavior

Every branch push attempts a signed build. Until the credentials above are
configured, the release job **fails rather than publishing unsigned installers**.
Ordinary CI and local development do not need credentials. Local `dist` and
`pack:dir` builds remain unsigned with updating disabled.

CI stages the version before building every package: for example,
`0.1.0-alpha` becomes `0.1.0-alpha.123.1` (workflow run number and attempt).
This gives updates semver ordering; `+build` metadata would not. Source files
keep their current version. A source version without a prerelease suffix gets
`-build.RUN.ATTEMPT`, so automatic builds remain below the corresponding final
semantic version. When a final release is made, the next development line must
advance its base version.

Both runners must pass build, typecheck, lint, formatting and tests, then signing
and platform verification. Installer, ZIP, update manifest and blockmap assets
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

They also have the normal `/api` aliases. A standalone daemon, unsigned build,
branch build, or shell attached to an existing daemon reports unavailable.
The browser can control an updater supplied by a signed desktop-owned daemon.

## Acceptance on real installations

1. Configure credentials, then run the release workflow manually. Confirm both
   architectures' macOS packages and the Windows installer pass verification.
2. Publish two increasing signed `main` builds. On a separate Mac and Windows
   machine, install the older build, including a real downloaded/quarantined
   macOS copy. Older unsigned alpha installs need this one manual installation;
   they contain no updater.
3. Open a project, complete a run, and start another. Download the newer build,
   choose Later once, and confirm normal quit does not install. Reopen, confirm
   restart, and verify the new version, completed history, interrupted run,
   projects and Commons. Repeat the Mac check for Intel and Apple Silicon.
4. Exercise offline checks, an invalid signature/checksum, and failed
   notarization. Nothing invalid may install or publish.
5. Record Gatekeeper and SmartScreen observations in `PLAN-STEP.MD`. Signing
   identifies the Windows publisher; it does not promise immediate SmartScreen
   reputation or removal of a new-publisher warning.
6. Capture each published release's profile using `scripts/capture-profile.mjs`.
   All five releases currently published are captured, including the first
   SQLite release (`build-36170856000-bb9ab14`). Capture now recovers committed
   WAL data and relocates text through SQLite; replay restores JSON paths with
   Windows escaping and checks database integrity. Each new publication adds
   its own captured profile before claiming coverage for that version.

## Phase 13 completion record

Source checks and installed acceptance are separate evidence. The current
published set has five captured profiles. The 2026-09-30 audit found no signing
secrets/variables or local signing identity; latest release run
[36806837821](https://github.com/npyrz/Cuesheet/actions/runs/36806837821) refused
macOS packaging for missing credentials. Its Windows checks also exposed two
5s test-budget failures, now addressed with explicit 30s ceilings for profile
replay and Commons Git/API work. Step 56's crash tests passed on that Windows
runner. A passing CI job alone does not close signed-install acceptance.

Record the following here or in the plan when actual signed builds exist:

| Evidence | Required observation | Current state |
|---|---|---|
| Both CI platforms | All five checks on the final source commit | Updated profile/timeout checks awaiting CI |
| Signing configuration | Apple and Windows credentials installed in Actions | Missing |
| Signed build A and B | Two increasing versions, all installers/manifests/blockmaps verified | Not produced |
| macOS arm64 and x64 install/update | Downloaded/quarantined install opens and updates without terminal work; Gatekeeper observed | Not exercised |
| Windows install/update | Valid publisher, SmartScreen observed, confirmed restart preserves history | Not exercised |
| Failure paths | Invalid payload refuses install; failed notarization prevents publication | Unit policy checks pass; real signed acceptance outstanding |
| Published profile coverage | Capture and replay every published build, including A and B | Five current releases captured; future A/B captures remain |

Do not mark Phase 13 complete or change the source version to `0.5.0-beta`
until these installed observations are recorded. No certificate purchase,
account enrollment or credential upload is performed by this audit.

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
