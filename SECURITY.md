# Security policy

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/npyrz/Cuesheet/security/advisories/new)
for Cuesheet. Sign in to GitHub, open this repository's **Security** tab, and
choose **Report a vulnerability**. Do not put exploit details, credentials,
private source, or affected users' data in a public issue or PR.

Include the affected version or commit, OS and architecture, installation
method, harness/CLI version, relevant role and configuration, reproduction in
a disposable repository, expected boundary, observed impact, and any proposed
fix. A minimal synthetic example is preferable to a full profile. Share secrets
only as redacted placeholders, even in the private report.

If the private form is unavailable, open an issue titled **Request for private
security contact** with no vulnerability details. A maintainer can arrange a
private channel. This follows [GitHub's reporting guidance](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).
Reports are reviewed by project maintainers; no response deadline or bounty is
promised. Coordinate publication of the finding and any fix in that private
thread, and say whether you want public credit.

## Versions and fixes

The project is pre-beta and has not undergone a security audit. Report findings
against both published installers and current source. Fixes are developed on
the current development line; older alpha or per-commit builds have no promised
backport or long-term support window. There is no supported 1.0 release.
Check [release status](README.md#project-status) and the
[changelog](CHANGELOG.md) before assuming a fix is in an installer.

## Current trust boundaries

- The daemon defaults to `127.0.0.1:7373` and has **no API authentication**.
  Loopback is not a boundary against other local processes. Do not expose it
  through port forwarding, a public bind address or an untrusted reverse proxy.
  Pairing tokens, phone access and tailnet serving are not implemented.
- Direct workspace operations enforce roles and path leashes, including
  symlink-resolved containment checks. External CLIs execute their own tools:
  observed file events do not constrain arbitrary shell commands. Codex gets
  role-derived sandbox flags; the Claude Code integration declares no equivalent
  role sandbox. A leash is not a container, and a review Gate is not a security
  proof. Use only repositories, harnesses and commands you trust to execute.
- Vendor CLIs use accounts you authenticated with them. Cuesheet does not manage
  those credentials, but briefs, diffs and tool output may contain sensitive
  material. Automatic secret redaction is not implemented. Review what you send
  and use synthetic data when demonstrating a failure.
- Run history, prompts, patches and Commons are stored locally without an
  application encryption layer. The default state root is `~/.cuesheet`
  (`%USERPROFILE%\.cuesheet` on Windows); project configuration may also live
  in a repository. Do not upload an entire profile as a bug attachment.
- Local diagnostics select runtime metadata rather than copying arbitrary errors
  or run payloads. Exported reports omit error messages, prompts, diffs, tool
  input/output and personal paths; project and Station identifiers are hashed.
  Timestamps, run IDs and stack file basenames/line numbers remain. Hashing is
  not a promise of anonymity. Review reports before attaching them. The Desk
  and HTTP endpoint only read local files; there is no automatic report upload.
- Commons projections put approved memory into runtime context files. Agent
  captures normally await approval; an operator can enable automatic capture.
  A configured Commons remote sends facts through Git, using Git's credentials.
  Review that content and remote before syncing.
- There is no Cuesheet telemetry service. Vendor calls, operator-requested Git
  sync and enabled desktop update checks still make network requests. Signed
  `main` builds use public GitHub release metadata; restarting to install an
  update requires confirmation. The first signed-install acceptance remains
  outstanding; existing published installers are unsigned.

See [the security reference](docs/REFERENCE.md#security-and-privacy) for operating
limits and [the release guide](docs/releases.md) for signing and update behavior.
