import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HostEnv } from "@cuesheet/core";
import {
  DEFAULT_PATHEXT,
  jsonLineReader,
  lineReader,
  run,
  which,
} from "./spawn.js";

const windows: HostEnv = { platform: "win32", homedir: "C:\\Users\\noah" };
const posix: HostEnv = { platform: "darwin", homedir: "/Users/noah" };

describe("which", () => {
  it("finds a .cmd shim on Windows via PATHEXT", async () => {
    // The failure this guards: `claude` on Windows is `claude.cmd`, and a
    // lookup that only tries the bare name reports "not installed" on a
    // machine where it is installed.
    const present = new Set(["C:\\tools\\claude.CMD"]);
    const found = await which("claude", {
      host: windows,
      path: "C:\\tools;C:\\other",
      pathext: DEFAULT_PATHEXT,
      isExecutable: async (file) => present.has(file),
    });
    expect(found).toBe("C:\\tools\\claude.CMD");
  });

  it("prefers the earlier PATH entry", async () => {
    const found = await which("claude", {
      host: windows,
      path: "C:\\first;C:\\second",
      pathext: ".EXE",
      isExecutable: async (file) =>
        file === "C:\\first\\claude.EXE" || file === "C:\\second\\claude.EXE",
    });
    expect(found).toBe("C:\\first\\claude.EXE");
  });

  it("does not append PATHEXT extensions on POSIX", async () => {
    // A `claude.EXE` on a Mac is not the binary; matching one would resolve to
    // something that cannot run.
    const found = await which("claude", {
      host: posix,
      path: "/usr/local/bin",
      isExecutable: async (file) => file === "/usr/local/bin/claude.EXE",
    });
    expect(found).toBeNull();
  });

  it("returns null when nothing on PATH matches", async () => {
    const found = await which("definitely-not-installed", {
      host: posix,
      path: "/usr/local/bin",
      isExecutable: async () => false,
    });
    expect(found).toBeNull();
  });

  it("treats a name containing a separator as a path, not a PATH search", async () => {
    // `./tools/claude` must never resolve to a different `claude` on PATH.
    const found = await which("./tools/claude", {
      host: posix,
      path: "/usr/local/bin",
      isExecutable: async (file) => file.endsWith("/tools/claude"),
    });
    expect(found).toMatch(/tools\/claude$/);
    expect(found).not.toContain("/usr/local/bin/");
  });

  it("strips quotes from Windows PATH entries", async () => {
    const found = await which("claude", {
      host: windows,
      path: '"C:\\Program Files\\tools";C:\\other',
      pathext: ".CMD",
      isExecutable: async (file) =>
        file === "C:\\Program Files\\tools\\claude.CMD",
    });
    expect(found).toBe("C:\\Program Files\\tools\\claude.CMD");
  });

  it("resolves a real binary to an absolute path", async () => {
    // A probe reports *which* binary it found; "somewhere on PATH" is not a
    // diagnosis when a user has three.
    const found = await which("node");
    expect(found).not.toBeNull();
    expect(path.isAbsolute(found ?? "")).toBe(true);
  });
});

describe("lineReader", () => {
  it("reassembles a line split across chunk boundaries", () => {
    // The actual bug: a JSON event straddles two `data` events and the naive
    // parser calls JSON.parse on half an object.
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    reader.push('{"type":"assis');
    reader.push('tant","message"');
    reader.push(':{"id":"m1"}}\n');
    expect(lines).toEqual(['{"type":"assistant","message":{"id":"m1"}}']);
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
  });

  it("strips \\r so a Windows-written stream parses", () => {
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    reader.push('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps leading whitespace, which is meaningful in output", () => {
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    reader.push("    indented code\n");
    expect(lines).toEqual(["    indented code"]);
  });

  it("emits a trailing partial line only on flush", () => {
    // A CLI's last line often has no newline; dropping it loses the result.
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    reader.push("no newline here");
    expect(lines).toEqual([]);
    reader.flush();
    expect(lines).toEqual(["no newline here"]);
  });

  it("handles several lines arriving in one chunk", () => {
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    reader.push("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });
});

describe("jsonLineReader", () => {
  it("routes malformed JSON to text instead of throwing", () => {
    // "Anything unrecognized becomes a text event rather than an error."
    const values: unknown[] = [];
    const text: string[] = [];
    const reader = jsonLineReader(
      (value) => values.push(value),
      (line) => text.push(line),
    );
    reader.push('{"ok":true}\n');
    reader.push("Loading plugins...\n");
    reader.push("{ not json at all\n");
    expect(values).toEqual([{ ok: true }]);
    expect(text).toEqual(["Loading plugins...", "{ not json at all"]);
  });

  it("ignores blank lines", () => {
    const values: unknown[] = [];
    const text: string[] = [];
    const reader = jsonLineReader(
      (v) => values.push(v),
      (l) => text.push(l),
    );
    reader.push("\n\n   \n");
    expect(values).toEqual([]);
    expect(text).toEqual([]);
  });
});

describe("run", () => {
  it("streams stdout line by line and reports the exit code", async () => {
    const lines: string[] = [];
    const result = await run(
      process.execPath,
      ["-e", "console.log('one');console.log('two');process.exit(3)"],
      { onStdout: (line) => lines.push(line) },
    );
    expect(lines).toEqual(["one", "two"]);
    expect(result.code).toBe(3);
  });

  it("resolves rather than rejecting on a non-zero exit", async () => {
    // A harness CLI exiting 1 is a result to map onto an event, not a throw.
    const result = await run(process.execPath, ["-e", "process.exit(1)"]);
    expect(result.code).toBe(1);
  });

  it("rejects when the command does not exist", async () => {
    await expect(run("cuesheet-no-such-binary-anywhere", [])).rejects.toThrow(
      /Could not start/,
    );
  });

  it("writes stdin and closes it", async () => {
    const result = await run(
      process.execPath,
      [
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('got:'+d.trim()))",
      ],
      { stdin: "the prompt" },
    );
    expect(result.stdout.trim()).toBe("got:the prompt");
  });

  it("kills the whole tree, not just the child", async () => {
    // Step 15's done-when. The child spawns a *grandchild* that would outlive
    // a plain `child.kill()`; the grandchild writes its pid so the test can
    // prove it actually died.
    const dir = await mkdtemp(path.join(tmpdir(), "cuesheet-spawn-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.env.PIDFILE, String(process.pid)); setInterval(() => {}, 1000);",
      ], { stdio: "ignore", env: { ...process.env, PIDFILE: ${JSON.stringify(pidFile)} } });
      console.log("spawned " + child.pid);
      setInterval(() => {}, 1000);
    `;
    const parentFile = path.join(dir, "parent.js");
    await writeFile(parentFile, script, "utf8");
    await chmod(parentFile, 0o755);

    const controller = new AbortController();
    const started = run(process.execPath, [parentFile], {
      signal: controller.signal,
      onStdout: () => undefined,
    });

    const grandchildPid = await waitForPid(pidFile);
    expect(alive(grandchildPid)).toBe(true);

    controller.abort();
    const result = await started;
    expect(result.killed).toBe(true);

    // Polled rather than checked once: a not-yet-reaped process still answers
    // signal 0 for a moment after it is signalled.
    await expect(waitForDeath(grandchildPid)).resolves.toBe(true);
  }, 30_000);

  it("kills a tree that outlives its timeout", async () => {
    const result = await run(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 300 },
    );
    expect(result.killed).toBe(true);
  }, 15_000);
});

/** Does a pid exist? Signal 0 checks without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(file: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text !== "") return Number.parseInt(text, 10);
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The grandchild never wrote ${file}`);
}

async function waitForDeath(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
