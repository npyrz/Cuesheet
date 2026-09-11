import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configDir, daemonLockFile, type HostEnv } from "@cuesheet/core";
import {
  currentLock,
  findRunningDaemon,
  PortInUseError,
  probeHealth,
  readLock,
  removeLock,
  writeLock,
} from "./lockfile.js";
import { startDaemon } from "./server.js";

let env: HostEnv;

beforeEach(async () => {
  // The Phase 0 HostEnv seam, used exactly as intended: a temp home means a
  // lockfile test never touches the developer's real `~/.cuesheet/daemon.json`.
  const home = await mkdtemp(path.join(tmpdir(), "cuesheet-home-"));
  env = { platform: process.platform, homedir: home };
});

describe("read and write", () => {
  it("creates the config directory on a fresh install", async () => {
    // `~/.cuesheet` does not exist yet. Your own machine has it after the
    // first success, so skipping the mkdir fails only for other people.
    const lock = currentLock(7373);
    await writeLock(lock, env);
    expect(await readLock(env)).toEqual(lock);
  });

  it("writes the lockfile where core says it lives", async () => {
    await writeLock(currentLock(7373), env);
    const text = await readFile(daemonLockFile(env), "utf8");
    expect(JSON.parse(text).port).toBe(7373);
  });

  it("records pid, port, version and startedAt", async () => {
    const lock = currentLock(1234, 999);
    expect(lock.pid).toBe(999);
    expect(lock.port).toBe(1234);
    expect(lock.version).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(lock.startedAt))).toBe(false);
  });

  it("is null when absent", async () => {
    expect(await readLock(env)).toBeNull();
  });

  it("treats a half-written lockfile as absent rather than crashing", async () => {
    await mkdir(configDir(env), { recursive: true });
    await writeFile(daemonLockFile(env), '{"pid":123,"por', "utf8");
    expect(await readLock(env)).toBeNull();
  });

  it("rejects a lockfile that parses but has the wrong shape", async () => {
    await mkdir(configDir(env), { recursive: true });
    await writeFile(daemonLockFile(env), '{"pid":"not-a-number"}', "utf8");
    expect(await readLock(env)).toBeNull();
  });

  it("removes cleanly, and removing a missing one is not an error", async () => {
    await writeLock(currentLock(7373), env);
    await removeLock(env);
    expect(await readLock(env)).toBeNull();
    await expect(removeLock(env)).resolves.toBeUndefined();
  });
});

describe("staleness", () => {
  it("treats a lockfile with nothing listening as stale", async () => {
    // A pid check alone would be wrong here: pids are recycled, so a live pid
    // is not proof it is our daemon, and refusing to boot over it is a state
    // the user cannot fix.
    await writeLock({ ...currentLock(1), port: 9 }, env);
    expect(await findRunningDaemon(env)).toBeNull();
  });

  it("recognises a genuinely running daemon", async () => {
    const daemon = await startDaemon({ port: 0, env, writeLockFile: true });
    try {
      const found = await findRunningDaemon(env);
      expect(found?.port).toBe(daemon.port);
      expect(found?.pid).toBe(process.pid);
    } finally {
      await daemon.close();
    }
  });

  it("is null again once that daemon exits", async () => {
    const daemon = await startDaemon({ port: 0, env, writeLockFile: true });
    await daemon.close();
    // A clean exit removes the lockfile.
    expect(await readLock(env)).toBeNull();
    expect(await findRunningDaemon(env)).toBeNull();
  });
});

describe("probeHealth", () => {
  it("returns the version from a live daemon", async () => {
    const daemon = await startDaemon({ port: 0, env, writeLockFile: false });
    try {
      const health = await probeHealth(daemon.port);
      expect(health?.ok).toBe(true);
      expect(health?.version).toBeTypeOf("string");
    } finally {
      await daemon.close();
    }
  });

  it("is null for a closed port rather than throwing", async () => {
    expect(await probeHealth(9, "127.0.0.1", 250)).toBeNull();
  });
});

describe("port collision", () => {
  it("refuses to start a second daemon on the same port", async () => {
    // Deliberately not falling back to another port: the CLI and the app find
    // the daemon at a known port, so moving silently would make it
    // undiscoverable rather than unavailable.
    const first = await startDaemon({ port: 0, env, writeLockFile: true });
    try {
      const attempt = startDaemon({
        port: first.port,
        env,
        writeLockFile: false,
      });
      await expect(attempt).rejects.toThrow(PortInUseError);
      await expect(attempt).rejects.toThrow(/already running/i);
    } finally {
      await first.close();
    }
  });

  it("says the port is taken by something else when it is not our daemon", async () => {
    const error = new PortInUseError(7373, "127.0.0.1", null);
    expect(error.message).toMatch(/not available/i);
    // Windows reserves blocks of dynamic ports and a bind inside one fails
    // with EACCES rather than EADDRINUSE, so the message has to say where
    // to look rather than just "in use".
    expect(error.message).toMatch(/excludedportrange/i);
    expect(error.message).toContain("7373");
  });

  it("leaves the running daemon's lockfile intact after a refused start", async () => {
    const first = await startDaemon({ port: 0, env, writeLockFile: true });
    try {
      await startDaemon({ port: first.port, env, writeLockFile: true }).catch(
        () => undefined,
      );
      // The loser must not clobber the winner's lockfile on its way out.
      expect((await readLock(env))?.port).toBe(first.port);
    } finally {
      await first.close();
    }
  });
});
