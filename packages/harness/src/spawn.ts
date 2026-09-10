/**
 * Cross-platform process spawning.
 *
 * Every harness that shells out goes through here, because the three things
 * this file gets right are three things that are silently wrong everywhere
 * else on Windows:
 *
 * 1. **`.cmd` shims.** `claude` and `codex` install as `claude.cmd` on
 *    Windows. Node's bare `spawn` will not execute a `.cmd` — it needs a
 *    shell — and `shell: true` re-opens quoting and injection problems on a
 *    string the *user* typed. `cross-spawn` rewrites the invocation to
 *    `cmd.exe /c` with correct escaping and no shell parsing of our argv.
 * 2. **Grandchildren survive `child.kill()`.** A CLI that spawns its own
 *    helpers leaves them running when the parent dies. On Windows the fix is
 *    `taskkill /T /F`; on POSIX it is spawning detached and signalling the
 *    process *group*.
 * 3. **`\r\n`.** A line parser that splits on `\n` alone hands every consumer
 *    a trailing `\r`, which turns `JSON.parse` into a coin flip depending on
 *    where the chunk boundary landed.
 */
import crossSpawn from "cross-spawn";
import { access, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { isWindows, pathFor, type HostEnv, hostEnv } from "@cuesheet/core";

// ── Executable resolution ───────────────────────────────────────────────────

/**
 * The environment a lookup reads, injectable for the same reason `HostEnv` is:
 * a `process.platform` mock does not rebind `node:path`, so a test that pokes
 * the global passes on macOS while proving nothing about Windows.
 */
export interface LookupEnv {
  host?: HostEnv;
  /** `PATH` (or `Path` on Windows). Defaults to the real one. */
  path?: string;
  /** `PATHEXT`. Windows only; defaults to the real one, then to a sane list. */
  pathext?: string;
  /** Overrides the "is this file executable" test. Tests inject a fake. */
  isExecutable?: (file: string) => Promise<boolean>;
}

/** What Windows treats as executable when `PATHEXT` is unset. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolve a command to an absolute path, or `null` if it is not on `PATH`.
 *
 * Absolute is the point: a probe reports *which* binary it found, and
 * "somewhere on your PATH" is not a diagnosis when a user has three.
 */
export async function which(
  command: string,
  env: LookupEnv = {},
): Promise<string | null> {
  const host = env.host ?? hostEnv();
  const p = pathFor(host);
  const win = isWindows(host);
  const executable = env.isExecutable ?? isExecutableFile;

  const extensions = win
    ? (env.pathext ?? process.env["PATHEXT"] ?? DEFAULT_PATHEXT)
        .split(";")
        .map((ext) => ext.trim())
        .filter((ext) => ext !== "")
    : [];

  // A command with a separator is a path, not a name — never search PATH for
  // it, or `./tools/claude` silently resolves to a different binary.
  if (command.includes("/") || (win && command.includes("\\"))) {
    const direct = p.resolve(command);
    return firstExecutable(direct, extensions, executable, win);
  }

  const rawPath = env.path ?? process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = rawPath.split(win ? ";" : ":").filter((dir) => dir !== "");
  // cmd.exe searches the current directory first; POSIX shells deliberately
  // do not, and neither do we.
  for (const dir of dirs) {
    const candidate = p.resolve(unquote(dir), command);
    const found = await firstExecutable(candidate, extensions, executable, win);
    if (found) return found;
  }
  return null;
}

async function firstExecutable(
  base: string,
  extensions: readonly string[],
  executable: (file: string) => Promise<boolean>,
  win: boolean,
): Promise<string | null> {
  // On Windows an extensionless hit is only valid if the name already carries
  // a PATHEXT extension; `claude` alone is the shim's *stem*, not the shim.
  const alreadyExtended =
    win &&
    extensions.some((ext) => base.toLowerCase().endsWith(ext.toLowerCase()));

  if (!win || alreadyExtended) {
    if (await executable(base)) return base;
    if (!win) return null;
  }
  for (const ext of extensions) {
    const candidate = `${base}${ext}`;
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/** `PATH` entries on Windows may be quoted; the quotes are not part of the path. */
function unquote(dir: string): string {
  return dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true; // No x-bit; PATHEXT decides.
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Spawning ────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin and closed. The safe way to pass a user's prompt. */
  stdin?: string;
  signal?: AbortSignal;
  /** Kill the process tree if it outlives this. `0` disables. */
  timeoutMs?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  host?: HostEnv;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the tree was killed by `stop`, an abort, or the timeout. */
  killed: boolean;
}

export class SpawnError extends Error {
  constructor(
    readonly command: string,
    override readonly cause: unknown,
  ) {
    super(`Could not start ${command}: ${errorText(cause)}`);
    this.name = "SpawnError";
  }
}

/**
 * Run a command to completion, streaming lines as they arrive.
 *
 * Resolves with a non-zero `code` rather than rejecting: a harness CLI exiting
 * 1 is a *result* to map onto a `RunEvent`, not an exception. It rejects only
 * when the process could not be started at all.
 */
export function run(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const host = options.host ?? hostEnv();
  const win = isWindows(host);

  return new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = crossSpawn(command, [...args], {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        // POSIX: its own process group, so one signal reaches grandchildren.
        // Windows: meaningless here, and `detached` there would open a console
        // window — `taskkill /T` is how the tree dies instead.
        detached: !win,
        windowsHide: true,
      });
    } catch (error) {
      reject(new SpawnError(command, error));
      return;
    }

    if (child.pid === undefined) {
      // cross-spawn reports a failed launch through `error`, not a throw.
      child.once("error", (error) => reject(new SpawnError(command, error)));
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    const outLines = lineReader((line) => {
      stdout += `${line}\n`;
      options.onStdout?.(line);
    });
    const errLines = lineReader((line) => {
      stderr += `${line}\n`;
      options.onStderr?.(line);
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => outLines.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => errLines.push(chunk));

    const stop = () => {
      killed = true;
      void killTree(child, host);
    };

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(stop, options.timeoutMs)
        : null;

    if (options.signal) {
      if (options.signal.aborted) stop();
      else options.signal.addEventListener("abort", stop, { once: true });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    };

    if (options.stdin !== undefined && child.stdin) {
      // EPIPE is normal: a CLI may exit before reading all of stdin.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin, "utf8");
    } else {
      child.stdin?.end();
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SpawnError(command, error));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Flush whatever arrived without a trailing newline; a CLI's last line
      // frequently has none, and dropping it loses the result.
      outLines.flush();
      errLines.flush();
      resolve({ code, signal, stdout, stderr, killed });
    });
  });
}

/**
 * Kill a process and everything it started.
 *
 * On Windows `child.kill()` kills exactly one process; a CLI's helpers keep
 * running, keep the workspace locked, and keep costing money. `taskkill /T /F`
 * is the only reliable tree kill. On POSIX the child was spawned detached, so
 * it leads its own group and `kill(-pid)` reaches every descendant.
 */
export async function killTree(
  child: ChildProcess,
  host: HostEnv = hostEnv(),
): Promise<void> {
  const pid = child.pid;
  if (
    pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  if (isWindows(host)) {
    await new Promise<void>((resolve) => {
      const killer = crossSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => {
        // taskkill missing is not a reason to leave the child running.
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The group is already gone, or we never got one. Fall back to the child.
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    return;
  }

  // Give it a moment to unwind, then insist.
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ── Line buffering ──────────────────────────────────────────────────────────

export interface LineReader {
  push(chunk: string): void;
  /** Emit a trailing partial line, if any. Call once at close. */
  flush(): void;
}

/**
 * Split a byte stream into lines across arbitrary chunk boundaries.
 *
 * The bug this prevents is specific and common: a JSON event straddles two
 * `data` events, the naive parser calls `JSON.parse` on half an object, and
 * the harness reports a crash for a run that was fine. Chunks are not lines,
 * ever, and a 4KB stdout pipe splits wherever it wants.
 */
export function lineReader(onLine: (line: string) => void): LineReader {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        // `\r` is stripped rather than trimmed: leading whitespace can be
        // meaningful in a `text` chunk, and eating it garbles indented output.
        const line = stripCr(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer === "") return;
      const line = stripCr(buffer);
      buffer = "";
      onLine(line);
    },
  };
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Parse a stream of JSON lines, tolerating everything a real CLI prints.
 *
 * Blank lines and non-JSON noise are handed to `onText` rather than thrown:
 * the plan is explicit that "anything unrecognized becomes a `text` event
 * rather than an error", and a CLI that prints one progress line to stdout
 * must not be able to fail a run.
 */
export function jsonLineReader(
  onValue: (value: unknown) => void,
  onText?: (line: string) => void,
): LineReader {
  return lineReader((line) => {
    const text = line.trim();
    if (text === "") return;
    if (!text.startsWith("{") && !text.startsWith("[")) {
      onText?.(line);
      return;
    }
    try {
      onValue(JSON.parse(text));
    } catch {
      onText?.(line);
    }
  });
}

/** Whether a directory exists — used by probes before they shell out. */
export async function directoryExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
