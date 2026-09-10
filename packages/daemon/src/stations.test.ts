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
reviewers = 2
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

  it("passes the loader's warnings straight through", async () => {
    const response = await describeStations(loaded(), unprobed);
    expect(response.warnings.some((w) => w.table === "gate")).toBe(true);
    expect(response.sourcePath).toBe("/ws/cuesheet.toml");
  });

  it("defaults to reporting nothing installed rather than guessing", async () => {
    const response = await describeStations(loaded());
    expect(response.stations.every((s) => s.probe.installed === false)).toBe(
      true,
    );
    expect(response.stations[0]?.probe.error).toMatch(/not implemented yet/);
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
