import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFERRED_TABLES,
  configSearchPaths,
  isGateRef,
  loadConfig,
  parseConfig,
} from "./config.js";
import type { HostEnv } from "./paths.js";

/**
 * The done-when for this step is "the exact TOML block from the README's
 * Configuration section parses". So the test reads it out of the README rather
 * than copying it — a copy is exact for exactly as long as nobody edits the
 * README, which is not a property worth testing.
 */
function readmeConfigBlock(): string {
  const readme = readFileSync(
    path.resolve(fileURLToPath(import.meta.url), "../../../..", "README.md"),
    "utf8",
  );
  const section = readme.slice(readme.indexOf("\n## Configuration"));
  const match = /```toml\n([\s\S]*?)```/.exec(section);
  if (!match?.[1]) throw new Error("no toml block under ## Configuration");
  return match[1];
}

describe("the README's config example", () => {
  const loaded = parseConfig(readmeConfigBlock(), "README.md");

  it("parses to a typed object", () => {
    expect(loaded.config.desk.name).toBe("api-team");
    expect(loaded.config.station.map((s) => s.id)).toEqual([
      "opus",
      "codex",
      "qwen",
    ]);

    const opus = loaded.config.station[0];
    expect(opus).toMatchObject({
      harness: "claude-code",
      role: "engineer",
      model: "opus",
      workspace: "~/code/api",
      paths: ["src/**", "tests/**"],
      deny: ["**/*.env", "infra/**"],
    });
  });

  it("keeps cues and gate references in one ordered list", () => {
    const ship = loaded.config.cuesheet["ship"];
    expect(ship?.cues).toHaveLength(4);
    expect(ship?.cues.map(isGateRef)).toEqual([false, false, true, false]);
    expect(ship?.cues[1]).toMatchObject({
      station: "codex",
      action: "review",
      mode: "adversarial",
    });
    expect(ship?.cues[2]).toEqual({ gate: "default" });
  });

  it("warns about every table it does not implement, and keeps them verbatim", () => {
    const warned = new Set(
      loaded.warnings.map((w) => w.table).filter((t): t is string => !!t),
    );
    for (const table of Object.keys(DEFERRED_TABLES)) {
      expect(warned, table).toContain(table);
      expect(loaded.deferred, table).toHaveProperty(table);
    }
  });

  it("does not discard deferred config it warned about", () => {
    // A UI-driven rewrite that dropped these would eat the user's Gates.
    expect(loaded.deferred["limits"]).toMatchObject({ warn_at: 0.85 });
    expect(loaded.deferred["remote"]).toMatchObject({ tailnet: true });
  });

  it("flags the gate cue as not yet executable", () => {
    const messages = loaded.warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('gate "default"'))).toBe(true);
  });
});

describe("cue options", () => {
  it("preserves unknown cue keys rather than silently dropping them", () => {
    // `require_failing_test` is in the README's On-Call cuesheet. Zod strips
    // unknown keys by default, which would discard it without a word.
    const { config } = parseConfig(`
[cuesheet.hotfix]
cues = [{ station = "opus", action = "patch", require_failing_test = true }]
`);
    expect(config.cuesheet["hotfix"]?.cues[0]).toMatchObject({
      station: "opus",
      action: "patch",
      require_failing_test: true,
    });
  });
});

describe("validation", () => {
  it("rejects an unknown role, naming the field", () => {
    const bad = `
[[station]]
id = "x"
harness = "claude-code"
role = "architect"
`;
    expect(() => parseConfig(bad, "cuesheet.toml")).toThrow(ConfigError);
    expect(() => parseConfig(bad, "cuesheet.toml")).toThrow(/station\.0\.role/);
  });

  it("rejects malformed TOML with the source path attached", () => {
    try {
      parseConfig("[[station]\nid = 1", "/tmp/cuesheet.toml");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).sourcePath).toBe("/tmp/cuesheet.toml");
    }
  });

  it("warns, rather than fails, on a station with no workspace", () => {
    const { config, warnings } = parseConfig(`
[[station]]
id = "codex"
harness = "codex"
role = "reviewer"
`);
    expect(config.station).toHaveLength(1);
    expect(warnings.some((w) => w.message.includes("no workspace"))).toBe(true);
  });

  it("warns when a cuesheet names a station that does not exist", () => {
    const { warnings } = parseConfig(`
[cuesheet.ship]
cues = [{ station = "ghost", action = "implement" }]
`);
    expect(
      warnings.some((w) => w.message.includes('unknown station "ghost"')),
    ).toBe(true);
  });

  it("warns on a table that is not a Cuesheet table at all", () => {
    const { warnings } = parseConfig(`[nonsense]\nx = 1`);
    const warning = warnings.find((w) => w.table === "nonsense");
    expect(warning?.message).toMatch(/not a Cuesheet config table/);
  });
});

describe("resolution order", () => {
  const win: HostEnv = { platform: "win32", homedir: "C:\\Users\\noah" };

  it("prefers the project file, then the user file", () => {
    expect(configSearchPaths("C:\\code\\api", win)).toEqual([
      "C:\\code\\api\\cuesheet.toml",
      "C:\\Users\\noah\\.cuesheet\\cuesheet.toml",
    ]);
  });

  it("falls back to built-in defaults with a warning when nothing exists", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "cuesheet-cfg-"));
    const home = await mkdtemp(path.join(tmpdir(), "cuesheet-home-"));
    const loaded = await loadConfig(empty, {
      platform: process.platform,
      homedir: home,
    });

    expect(loaded.sourcePath).toBeNull();
    expect(loaded.config.station).toEqual([]);
    expect(loaded.warnings[0]?.message).toMatch(/using defaults/);
  });

  it("loads the project file over the user file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cuesheet-cfg-"));
    const home = await mkdtemp(path.join(tmpdir(), "cuesheet-home-"));
    await mkdir(path.join(home, ".cuesheet"), { recursive: true });
    await writeFile(
      path.join(home, ".cuesheet", "cuesheet.toml"),
      `[desk]\nname = "user"\n`,
    );
    await writeFile(
      path.join(cwd, "cuesheet.toml"),
      `[desk]\nname = "project"\n`,
    );

    const loaded = await loadConfig(cwd, {
      platform: process.platform,
      homedir: home,
    });
    expect(loaded.config.desk.name).toBe("project");
    expect(loaded.sourcePath).toBe(path.join(cwd, "cuesheet.toml"));
  });

  it("falls through to the user file when there is no project file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cuesheet-cfg-"));
    const home = await mkdtemp(path.join(tmpdir(), "cuesheet-home-"));
    await mkdir(path.join(home, ".cuesheet"), { recursive: true });
    await writeFile(
      path.join(home, ".cuesheet", "cuesheet.toml"),
      `[desk]\nname = "user"\n`,
    );

    const loaded = await loadConfig(cwd, {
      platform: process.platform,
      homedir: home,
    });
    expect(loaded.config.desk.name).toBe("user");
  });
});
