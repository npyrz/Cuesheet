/**
 * Cross-platform path resolution.
 *
 * Every function here takes an injectable {@link HostEnv} rather than reading
 * `process.platform` at module load. That is not ceremony: it is the only way
 * these are testable. Mocking `process.platform` from a macOS test run does not
 * change which platform `node:path` is bound to, so an implementation that used
 * the ambient `path` would still produce POSIX output and the test would pass
 * for the wrong reason. We select `path.win32` / `path.posix` explicitly.
 */
import nodePath from "node:path";
import os from "node:os";

/** Default loopback port for `cuesheetd`. */
export const DEFAULT_PORT = 7373;

/** Name of the config file, in the project or in the config dir. */
export const CONFIG_FILENAME = "cuesheet.toml";

export interface HostEnv {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

/** The real host. Call sites default to this; tests pass their own. */
export function hostEnv(): HostEnv {
  return { platform: process.platform, homedir: os.homedir() };
}

export function isWindows(env: HostEnv = hostEnv()): boolean {
  return env.platform === "win32";
}

/** The `node:path` implementation matching `env`, not the host. */
export function pathFor(env: HostEnv = hostEnv()): nodePath.PlatformPath {
  return isWindows(env) ? nodePath.win32 : nodePath.posix;
}

/**
 * `~/.cuesheet` — which resolves to `%USERPROFILE%\.cuesheet` on Windows.
 * A dotted directory in the home dir is unusual on Windows but works fine, and
 * keeps one documented location across both platforms.
 */
export function configDir(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(env.homedir, ".cuesheet");
}

export function configFile(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), CONFIG_FILENAME);
}

export function runsDir(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "runs");
}

export function logsDir(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "logs");
}

export function commonsDir(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "commons");
}

/**
 * Captured memories waiting for a person.
 *
 * A sibling of the Git-backed Commons rather than a directory inside it. The
 * Commons commits with `git add -A`; putting pending captures underneath that
 * repository would record unapproved memory in history on the next approved
 * write even though projections correctly ignored it.
 */
export function commonsInboxDir(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "commons-inbox");
}

/** Where the daemon advertises `{ pid, port, version, startedAt }`. */
export function daemonLockFile(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "daemon.json");
}

/**
 * The project registry — `~/.cuesheet/projects.json`.
 *
 * The first state Cuesheet keeps that is neither config nor a run record, and
 * the reason it needs its own file rather than a table in `cuesheet.toml`: a
 * config belongs to one project, and this list is the thing that knows a
 * project *exists* before any of its config has been read.
 */
export function projectsFile(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "projects.json");
}

/**
 * The migration log — `~/.cuesheet/migrations.jsonl`.
 *
 * One line per migration that actually changed something, appended by the
 * build that did it. It sits beside `projects.json` rather than inside a
 * project because the migrations it records are mostly about the install: the
 * alpha layout moving into projects happens *before* there is a project to
 * put a log in.
 */
export function migrationLogFile(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "migrations.jsonl");
}

/**
 * A project id is a directory name under `~/.cuesheet/projects` and a URL
 * segment in `/projects/:id/...`, which is why it lives here beside the
 * builders rather than with the registry: the constraint *is* a path
 * constraint. Same rule `isRunId` exists for — anything reaching the
 * filesystem is matched against this first, so `/projects/..%2f..%2fetc` is a
 * refusal rather than a directory traversal.
 *
 * Lowercase-only is not cosmetic. Windows paths are case-insensitive, so
 * `API-3f2a1b` and `api-3f2a1b` would be two ids and one directory — a corrupt
 * registry waiting to happen. Restricting the alphabet makes the collision
 * unrepresentable rather than handled.
 *
 * The trailing `-xxxxxx` is also what keeps a slug clear of Windows' reserved
 * device names: `con`, `nul` and `lpt1` are unusable as directory names, but
 * `con-3f2a1b` is an ordinary one, because the reservation matches the whole
 * name (up to an extension) rather than a prefix.
 */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}-[0-9a-f]{6}$/;

export type ProjectId = string;

export function isProjectId(value: unknown): value is ProjectId {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

/**
 * Enforced, not documented.
 *
 * An earlier draft of this file asked callers to validate ids themselves. That
 * is the guard being advisory, and the next step to be written hands a URL
 * segment straight to {@link projectDir} — so the check lives where the path is
 * built, and every caller gets it whether or not they read the comment.
 */
function assertProjectId(id: string): asserts id is ProjectId {
  if (!isProjectId(id)) {
    throw new Error(
      `"${id}" is not a project id, so it cannot be used as a path.`,
    );
  }
}

/** `~/.cuesheet/projects` — one directory per project, named by its id. */
export function projectsDir(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "projects");
}

/**
 * Per-project private state: the config a project has no repo-committed one
 * for, and (from Step 32) its runs.
 *
 * Throws on anything that is not a project id, because `id` reaches the
 * filesystem here.
 */
export function projectDir(id: string, env: HostEnv = hostEnv()): string {
  assertProjectId(id);
  return pathFor(env).join(projectsDir(env), id);
}

/**
 * A project's run store root — `~/.cuesheet/projects/<id>/runs`.
 *
 * Exists so the daemon's store root and Step 33's migration target are one
 * expression rather than two `join(projectDir(id), "runs")` calls that agree
 * until somebody changes one. A migration that moves history to a directory
 * the store does not read loses it just as completely as deleting it would.
 */
export function projectRunsDir(id: string, env: HostEnv = hostEnv()): string {
  return pathFor(env).join(projectDir(id, env), "runs");
}

/**
 * Where a project's config lives when the repo does not carry one.
 *
 * **The decision Phase 8 left open, settled: the repo wins when present.** A
 * `cuesheet.toml` at the project root commits with the code, reviews like
 * code, and is what a team sharing a set of Stations actually wants — so it is
 * preferred whenever it exists. This path is the fallback for the ordinary
 * case of a checkout you do not want to add a file to, and it keeps the
 * promise that using Cuesheet on someone else's repository leaves no trace in
 * it.
 *
 * That ordering is deliberately the same one `loadConfig` already applies —
 * nearest-to-the-work first, then the home directory. Step 32 is what replaces
 * that function's fixed two-candidate search with this pair; nothing in Step 31
 * changes the loader.
 */
export function projectConfigFile(
  id: string,
  env: HostEnv = hostEnv(),
): string {
  return pathFor(env).join(projectDir(id, env), CONFIG_FILENAME);
}

/**
 * Expand a leading `~`. The OS does not do this for you — the shell does, and
 * on Windows not even that. Config files are full of `~/code/api`.
 *
 * Only a leading `~` or `~/` (plus `~\` on Windows) is expanded; `~user` is
 * deliberately not supported, since resolving another user's home is a
 * platform-specific lookup we have no reason to make.
 */
export function expandHome(p: string, env: HostEnv = hostEnv()): string {
  if (p === "~") return env.homedir;
  const rest = p.startsWith("~/")
    ? p.slice(2)
    : isWindows(env) && p.startsWith("~\\")
      ? p.slice(2)
      : undefined;
  if (rest === undefined) return p;
  return pathFor(env).join(env.homedir, rest);
}

/**
 * Normalize separators to `/` for glob matching.
 *
 * Gated on platform on purpose: a backslash is a legal character in a POSIX
 * filename, so rewriting it there would corrupt real paths. On Windows it can
 * only be a separator.
 */
export function toPosix(p: string, env: HostEnv = hostEnv()): string {
  return isWindows(env) ? p.replace(/\\/g, "/") : p;
}

/** Absolute path, with `~` expanded, resolved against `cwd`. */
export function resolveUserPath(
  p: string,
  cwd: string,
  env: HostEnv = hostEnv(),
): string {
  return pathFor(env).resolve(cwd, expandHome(p, env));
}
