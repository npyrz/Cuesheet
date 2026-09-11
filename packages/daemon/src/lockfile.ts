/**
 * `~/.cuesheet/daemon.json` — how the CLI and the Electron shell find a
 * running daemon.
 *
 * The port is deliberately not negotiated. Picking a different port on
 * collision would mean every client has to guess, so the daemon records the
 * port it actually bound and refuses to start if a live one already holds it.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  configDir,
  daemonLockFile,
  hostEnv,
  type HostEnv,
} from "@cuesheet/core";
import { DAEMON_VERSION } from "./version.js";

export interface DaemonLock {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
}

/** How long to wait for a `/health` answer before calling a lockfile stale. */
const PROBE_TIMEOUT_MS = 1_000;

export async function writeLock(
  lock: DaemonLock,
  env: HostEnv = hostEnv(),
): Promise<void> {
  // A fresh install has no `~/.cuesheet`. Your own machine has one after the
  // first success, so skipping this fails only for other people.
  await mkdir(configDir(env), { recursive: true });
  await writeFile(
    daemonLockFile(env),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
}

/** The lockfile as written, or `null` if absent, unreadable, or malformed. */
export async function readLock(
  env: HostEnv = hostEnv(),
): Promise<DaemonLock | null> {
  let text: string;
  try {
    text = await readFile(daemonLockFile(env), "utf8");
  } catch {
    return null;
  }

  try {
    const raw: unknown = JSON.parse(text);
    return isLock(raw) ? raw : null;
  } catch {
    // A half-written lockfile is a stale lockfile, not a crash.
    return null;
  }
}

export async function removeLock(env: HostEnv = hostEnv()): Promise<void> {
  await rm(daemonLockFile(env), { force: true });
}

function isLock(raw: unknown): raw is DaemonLock {
  if (raw === null || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o["pid"] === "number" &&
    typeof o["port"] === "number" &&
    typeof o["version"] === "string" &&
    typeof o["startedAt"] === "string"
  );
}

/**
 * Ask whatever is on `port` whether it is a Cuesheet daemon.
 *
 * This is the authority on liveness, not the recorded pid. `process.kill(pid, 0)`
 * only proves *some* process holds that id, and pids are recycled — on a
 * rebooted machine the pid in a stale lockfile may well belong to something
 * else entirely, and refusing to start because of it is unfixable by the user.
 */
export async function probeHealth(
  port: number,
  host = "127.0.0.1",
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      body !== null &&
      typeof body === "object" &&
      (body as { ok?: unknown }).ok === true &&
      typeof (body as { version?: unknown }).version === "string"
    ) {
      return { ok: true, version: (body as { version: string }).version };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The running daemon, if there is one.
 *
 * Returns `null` when the lockfile is missing *or* stale — in both cases the
 * caller is free to start and overwrite it.
 */
export async function findRunningDaemon(
  env: HostEnv = hostEnv(),
): Promise<DaemonLock | null> {
  const lock = await readLock(env);
  if (!lock) return null;
  const health = await probeHealth(lock.port);
  return health ? lock : null;
}

/** Thrown instead of exiting, so a library caller can decide what to do. */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly host: string,
    readonly existing: DaemonLock | null,
  ) {
    super(
      existing
        ? `Cuesheet is already running on http://${host}:${port} (pid ${existing.pid}, version ${existing.version}). ` +
            `Stop it before starting another daemon.`
        : `Port ${port} on ${host} is not available. ` +
            `Cuesheet needs this exact port so the app and the CLI can find it — free it and try again. ` +
            `On Windows it may fall inside a reserved dynamic-port range: ` +
            `check \`netsh interface ipv4 show excludedportrange protocol=tcp\`.`,
    );
    this.name = "PortInUseError";
  }
}

export function currentLock(port: number, pid = process.pid): DaemonLock {
  return {
    pid,
    port,
    version: DAEMON_VERSION,
    startedAt: new Date().toISOString(),
  };
}
