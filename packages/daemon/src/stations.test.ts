import { describe, expect, it, vi } from "vitest";
import {
  parseConfig,
  type HarnessProbe,
  type LoadedConfig,
} from "@cuesheet/core";
import { describeStations, unprobed } from "./stations.js";

const TOML = `
[[station]]
id = "opus"
harness = "claude-code"
role = "engineer"
workspace = "/ws"

[[station]]
id = "sonnet"
harness = "claude-code"
role = "reviewer"
workspace = "/ws"

[[station]]
id = "local"
harness = "ollama"
role = "worker"
workspace = "/ws"

[gate.default]
require = "1-of-1"

[cuesheet.ship]
cues = [
  { station = "opus", action = "implement" },
  { gate = "default" },
  { station = "sonnet", action = "review" },
]

[limits]
warn_at = 0.85
`;

const loaded = (): LoadedConfig => parseConfig(TOML, "/ws/cuesheet.toml");

const installed = (harness: string): HarnessProbe => ({
  harness,
  installed: true,
  authed: true,
  version: "1.2.3",
});

describe("describeStations", () => {
  it("pairs every configured station with its harness probe", async () => {
    const response = await describeStations(loaded(), async (h) =>
      installed(h),
    );
    expect(response.stations.map((s) => s.station.id)).toEqual([
      "opus",
      "sonnet",
      "local",
    ]);
    expect(response.stations[0]?.probe.version).toBe("1.2.3");
  });

  it("probes each distinct harness once, not once per station", async () => {
    // Two stations share `claude-code`. A probe shells out to a binary, so
    // three stations must not mean three `--version` calls.
    const probe = vi.fn(async (h: string) => installed(h));
    await describeStations(loaded(), probe);
    const probed = probe.mock.calls.map(([h]) => h);
    expect(new Set(probed).size).toBe(probed.length);
    expect(probed).toContain("claude-code");
  });

  it("includes harnesses no station uses, so the panel can grey them out", async () => {
    const response = await describeStations(loaded(), unprobed);
    const ids = response.harnesses.map((h) => h.harness);
    expect(ids).toContain("codex");
    expect(ids).toContain("ollama");
    expect(ids).toContain("claude-code");
  });

  it("sorts installed harnesses first", async () => {
    const response = await describeStations(loaded(), async (h) =>
      h === "ollama"
        ? installed(h)
        : { harness: h, installed: false, authed: false },
    );
    expect(response.harnesses[0]?.harness).toBe("ollama");
  });

  it("reports the named cuesheets, so the palette can offer them", async () => {
    // The Desk has no other way to learn a cuesheet exists, and a cuesheet it
    // cannot see is a Gate nobody can reach without curl. This shape is also
    // hand-mirrored in `packages/ui/src/api/client.ts`, so this test is what
    // catches the two drifting apart.
    const response = await describeStations(loaded(), unprobed);
    expect(response.cuesheets).toEqual([
      { id: "ship", stationIds: ["opus", "sonnet"], gates: ["default"] },
    ]);
  });

  it("reports a cuesheet with no gate as having none", async () => {
    const plain = parseConfig(
      `${TOML}\n[cuesheet.solo]\ncues = [{ station = "opus", action = "implement" }]\n`,
      "/ws/cuesheet.toml",
    );
    const response = await describeStations(plain, unprobed);
    expect(response.cuesheets).toContainEqual({
      id: "solo",
      stationIds: ["opus"],
      gates: [],
    });
  });

  it("passes the loader's warnings straight through", async () => {
    // `[limits]` rather than `[gate]`: gates are implemented now, so they no
    // longer warn. The route's job — telling a user which of their tables are
    // parsed but not live — is unchanged.
    const response = await describeStations(loaded(), unprobed);
    expect(response.warnings.some((w) => w.table === "limits")).toBe(true);
    expect(response.sourcePath).toBe("/ws/cuesheet.toml");
  });

  it("defaults to reporting nothing installed rather than guessing", async () => {
    const response = await describeStations(loaded());
    expect(response.stations.every((s) => s.probe.installed === false)).toBe(
      true,
    );
    expect(response.stations[0]?.probe.error).toMatch(/No prober is wired up/);
  });

  it("marks a station on an unknown harness rather than dropping it", async () => {
    const custom = parseConfig(
      `[[station]]\nid = "x"\nharness = "third-party"\nrole = "engineer"\nworkspace = "/ws"\n`,
    );
    const response = await describeStations(custom, unprobed);
    // Harness ids are open by design — a third-party harness must still show
    // up as a Station, just an unusable one.
    expect(response.stations).toHaveLength(1);
    expect(response.stations[0]?.probe.harness).toBe("third-party");
  });
});
