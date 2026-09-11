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

/** Where the daemon advertises `{ pid, port, version, startedAt }`. */
export function daemonLockFile(env: HostEnv = hostEnv()): string {
  return pathFor(env).join(configDir(env), "daemon.json");
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
