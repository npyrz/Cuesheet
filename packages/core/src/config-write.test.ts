import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addStation,
  appendStationText,
  DEFAULT_STATION_DENY,
  DEFAULT_STATION_PATHS,
  normalizeStation,
  stationBlock,
  stationIdTaken,
} from "./config-write.js";
import { ConfigError, parseConfig } from "./config.js";
import type { HostEnv } from "./paths.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cuesheet-config-"));
}

/** A host whose home is a temp dir, so `configFile()` lands somewhere safe. */
function envAt(home: string): HostEnv {
  return { platform: process.platform, homedir: home };
}

const BASE = {
  id: "opus",
  harness: "claude-code",
  role: "engineer",
} as const;

describe("normalizeStation", () => {
  it("seeds paths and deny so a new Station can actually work", () => {
    const station = normalizeStation({ ...BASE });
    expect(station.paths).toEqual([...DEFAULT_STATION_PATHS]);
    expect(station.deny).toEqual([...DEFAULT_STATION_DENY]);
  });

  it("seeds .git/** specifically, since an allow of ** reaches .git/hooks", () => {
    expect(normalizeStation({ ...BASE }).deny).toContain(".git/**");
  });

  it("does not overwrite a leash the user chose", () => {
    const station = normalizeStation({
      ...BASE,
      paths: ["src/**"],
      deny: ["**/*.env"],
    });
    expect(station.paths).toEqual(["src/**"]);
    expect(station.deny).toEqual(["**/*.env"]);
  });

  it("respects a deliberately empty deny list", () => {
    expect(normalizeStation({ ...BASE, deny: [] }).deny).toEqual([]);
  });

  it("rejects an invalid role rather than writing it to disk", () => {
    expect(() => normalizeStation({ ...BASE, role: "pilot" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an id that would not be safe as a directory name", () => {
    expect(() => normalizeStation({ ...BASE, id: "../escape" })).toThrow(
      ConfigError,
    );
  });

  it("does not mutate the caller's object", () => {
    const input: Record<string, unknown> = { ...BASE };
    normalizeStation(input);
    expect(input["paths"]).toBeUndefined();
  });
});

describe("stationBlock", () => {
  it("renders a parseable [[station]] table", () => {
    const block = stationBlock(normalizeStation({ ...BASE }));
    expect(block.startsWith("[[station]]")).toBe(true);
    expect(parseConfig(block).config.station[0]?.id).toBe("opus");
  });

  it("escapes a Windows workspace path instead of emitting a bad escape", () => {
    const block = stationBlock(
      normalizeStation({ ...BASE, workspace: "C:\\Users\\noah\\code\\api" }),
    );
    // The whole point: this must survive a round trip through the parser.
    expect(parseConfig(block).config.station[0]?.workspace).toBe(
      "C:\\Users\\noah\\code\\api",
    );
  });
});

describe("appendStationText", () => {
  it("is the whole block when the file was empty", () => {
    const station = normalizeStation({ ...BASE });
    expect(appendStationText("", station)).toBe(stationBlock(station));
    expect(appendStationText("   \n", station)).toBe(stationBlock(station));
  });

  it("adds the missing newline so the header never lands mid-line", () => {
    const existing = '[desk]\nname = "Cuesheet"';
    const text = appendStationText(existing, normalizeStation({ ...BASE }));
    expect(text).toContain('name = "Cuesheet"\n\n[[station]]');
    expect(parseConfig(text).config.station).toHaveLength(1);
  });

  it("leaves the user's comments and spacing untouched", () => {
    const existing = [
      "# my desk, hand written",
      "[desk]",
      'name    = "Studio"   # aligned on purpose',
      "",
    ].join("\n");
    const text = appendStationText(existing, normalizeStation({ ...BASE }));
    expect(text.startsWith(existing)).toBe(true);
    expect(text).toContain("# aligned on purpose");
  });
});

describe("stationIdTaken", () => {
  it("matches case-insensitively, since ids are compared loosely elsewhere", () => {
    const loaded = parseConfig(
      '[[station]]\nid = "Opus"\nharness = "claude-code"\nrole = "engineer"\n',
    );
    expect(stationIdTaken(loaded, "opus")).toBe(true);
    expect(stationIdTaken(loaded, "codex")).toBe(false);
  });
});

describe("addStation", () => {
  it("creates ~/.cuesheet/cuesheet.toml when there is no config yet", async () => {
    const home = await scratch();
    const result = await addStation(
      { ...BASE, workspace: "/tmp/api" },
      { sourcePath: null, env: envAt(home) },
    );

    expect(result.created).toBe(true);
    expect(result.sourcePath).toBe(join(home, ".cuesheet", "cuesheet.toml"));
    const text = await readFile(result.sourcePath, "utf8");
    expect(parseConfig(text).config.station[0]?.id).toBe("opus");
  });

  it("appends to the file the config was loaded from", async () => {
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    await writeFile(target, '[desk]\nname = "Studio"\n', "utf8");

    await addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) });
    const loaded = parseConfig(await readFile(target, "utf8"));
    expect(loaded.config.desk.name).toBe("Studio");
    expect(loaded.config.station.map((s) => s.id)).toEqual(["opus"]);
  });

  it("preserves deferred tables verbatim — the user's Commons is not eaten", async () => {
    // This used to use `[gate.*]` as its example of a table written ahead of
    // its implementation. Gates are implemented now, so the example moved to
    // one that still is not; the guarantee under test never changed, and it
    // is the reason `addStation` appends to the file's *text* instead of
    // re-emitting a parsed config.
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    const original = [
      "# the commons, written ahead of the implementation",
      "[commons]",
      "store = '~/.cuesheet/commons'",
      "project_to = [ 'CLAUDE.md', 'AGENTS.md' ]",
      "",
    ].join("\n");
    await writeFile(target, original, "utf8");

    await addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) });

    const text = await readFile(target, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain(
      "# the commons, written ahead of the implementation",
    );
    expect(parseConfig(text, target).deferred["commons"]).toEqual({
      store: "~/.cuesheet/commons",
      project_to: ["CLAUDE.md", "AGENTS.md"],
    });
  });

  it("keeps a hand-written gate table through a UI write", async () => {
    // Gates are parsed now rather than deferred, which is a different code
    // path through the writer — and the same promise: what you wrote by hand
    // survives the app writing beside it.
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    const original = [
      "[gate.default]",
      'require = "2-of-3"',
      "distinct_vendors = 2",
      "blocking = [ 'security' ]",
      "",
    ].join("\n");
    await writeFile(target, original, "utf8");

    await addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) });

    const text = await readFile(target, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(parseConfig(text, target).config.gate["default"]).toMatchObject({
      require: "2-of-3",
      distinct_vendors: 2,
      blocking: ["security"],
    });
  });

  it("adds two Stations without the second dropping the first", async () => {
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    await writeFile(target, "", "utf8");

    await addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) });
    await addStation(
      { id: "codex", harness: "codex", role: "reviewer" },
      { sourcePath: target, env: envAt(dir) },
    );

    const loaded = parseConfig(await readFile(target, "utf8"));
    expect(loaded.config.station.map((s) => s.id)).toEqual(["opus", "codex"]);
  });

  it("serializes concurrent adds rather than losing one", async () => {
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    await writeFile(target, "", "utf8");

    await Promise.all([
      addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) }),
      addStation(
        { id: "codex", harness: "codex", role: "reviewer" },
        { sourcePath: target, env: envAt(dir) },
      ),
      addStation(
        { id: "qwen", harness: "ollama", role: "worker" },
        { sourcePath: target, env: envAt(dir) },
      ),
    ]);

    const ids = parseConfig(await readFile(target, "utf8")).config.station.map(
      (s) => s.id,
    );
    expect(ids.sort()).toEqual(["codex", "opus", "qwen"]);
  });

  it("leaves a broken config untouched instead of appending to it", async () => {
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    const broken = "[[station]]\nid = \nharness = 'claude-code'\n";
    await writeFile(target, broken, "utf8");

    await expect(
      addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) }),
    ).rejects.toThrow(ConfigError);
    expect(await readFile(target, "utf8")).toBe(broken);
  });

  it("writes nothing when the Station itself is invalid", async () => {
    const dir = await scratch();
    const target = join(dir, "cuesheet.toml");
    await writeFile(target, "[desk]\n", "utf8");

    await expect(
      addStation(
        { ...BASE, role: "nonsense" },
        { sourcePath: target, env: envAt(dir) },
      ),
    ).rejects.toThrow(ConfigError);
    expect(await readFile(target, "utf8")).toBe("[desk]\n");
  });

  it("creates the parent directory when it does not exist", async () => {
    const dir = await scratch();
    const target = join(dir, "nested", "deeper", "cuesheet.toml");
    await addStation({ ...BASE }, { sourcePath: target, env: envAt(dir) });
    expect(
      parseConfig(await readFile(target, "utf8")).config.station,
    ).toHaveLength(1);
  });

  it("leaves no .tmp file behind", async () => {
    const dir = await scratch();
    await mkdir(join(dir, ".cuesheet"), { recursive: true });
    const result = await addStation(
      { ...BASE },
      { sourcePath: null, env: envAt(dir) },
    );
    await expect(
      readFile(`${result.sourcePath}.tmp`, "utf8"),
    ).rejects.toThrow();
  });
});
