import { describe, expect, it, vi } from "vitest";
import {
  parseConfig,
  type HarnessProbe,
  type LoadedConfig,
  type Role,
} from "@cuesheet/core";
import {
  describeStations,
  unknownConfinement,
  unknownRoles,
  unprobed,
  type HarnessConfinement,
  type HarnessRoles,
} from "./stations.js";

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

[remote]
tailnet = true
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
    // `[remote]` rather than `[gate]` or `[limits]`: both of those have since
    // shipped and no longer warn. The route's job — telling a user which of
    // their tables are parsed but not live — is unchanged, and the table it
    // has to name keeps moving.
    const response = await describeStations(loaded(), unprobed);
    expect(response.warnings.some((w) => w.table === "remote")).toBe(true);
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

/** What the real registry answers, for the two harnesses these configs use. */
const ROLE_TABLE: Record<string, readonly Role[]> = {
  "claude-code": ["engineer", "reviewer", "caller"],
  ollama: ["worker"],
};

const realRoles: HarnessRoles = (harness) => ROLE_TABLE[harness];

describe("seats a harness cannot play", () => {
  const seated = (harness: string, role: string) =>
    parseConfig(
      `
[[station]]
id = "local"
harness = "${harness}"
role = "${role}"
workspace = "/ws"
`,
      "/ws/cuesheet.toml",
    );

  it("warns when a worker-only harness is put in a reviewer seat", async () => {
    // The README promises this out loud, and the reason is not pedantry: a
    // small local model asked to review a frontier model's diff approves
    // nearly everything, so the failure looks exactly like a pass.
    const response = await describeStations(
      seated("ollama", "reviewer"),
      unprobed,
      realRoles,
    );
    const warning = response.warnings.find((w) =>
      w.message.includes('Station "local"'),
    );
    expect(warning?.table).toBe("station");
    expect(warning?.message).toContain(
      '"ollama" harness can only play the worker seat',
    );
    // No backticks: the Desk renders a warning as bare text in a banner.
    expect(warning?.message).not.toContain("`");
    expect(warning?.message).toContain("worse than none");
  });

  it("says nothing when the seat fits", async () => {
    const response = await describeStations(
      seated("ollama", "worker"),
      unprobed,
      realRoles,
    );
    expect(response.warnings).toEqual([]);
  });

  it("says nothing about a harness nobody has registered", async () => {
    // `BUILTIN_HARNESS_IDS` lists `ollama` for probe ordering, but no build
    // ships one — and third-party harnesses are a supported case. A config
    // that could not be opened without the plugin declaring its roles would
    // make writing one hostile.
    const response = await describeStations(
      seated("ollama", "reviewer"),
      unprobed,
      unknownRoles,
    );
    expect(response.warnings).toEqual([]);
  });

  it("keeps the loader's own warnings alongside its own", async () => {
    const response = await describeStations(loaded(), unprobed, realRoles);
    expect(response.warnings.some((w) => w.table === "remote")).toBe(true);
    // `TOML`'s ollama station is a worker in a worker seat, so the only seat
    // warning that could appear is one that should not.
    expect(
      response.warnings.some((w) => w.message.includes("can only be")),
    ).toBe(false);
  });
});

/**
 * Step 42. The project view has to show a seat as a constraint, and the two
 * halves of that constraint are kept by two different processes — so the
 * assembly happens here, where both are known, rather than in a Desk that
 * cannot import a harness.
 */
describe("what a Station is allowed to do", () => {
  const seatedOn = (harness: string, role: string) =>
    parseConfig(
      `
[[station]]
id = "s"
harness = "${harness}"
role = "${role}"
workspace = "/ws"
`,
      "/ws/cuesheet.toml",
    );

  /** Codex's real mapping: reviewer, caller and worker run read-only. */
  const codexLike: HarnessConfinement = (_harness, role) =>
    role === "engineer" ? "workspace-write" : "read-only";
  /** Claude Code's real answer: it takes no role-based sandbox flag at all. */
  const claudeLike: HarnessConfinement = () => "none";

  const enforcementFor = async (
    config: LoadedConfig,
    confinement: HarnessConfinement,
    roles: HarnessRoles = realRoles,
  ) =>
    (await describeStations(config, unprobed, roles, confinement)).stations[0]
      ?.enforcement;

  it("refuses a worker's writes in this process, whatever the CLI does", async () => {
    const enforcement = await enforcementFor(
      seatedOn("ollama", "worker"),
      claudeLike,
    );
    expect(enforcement).toMatchObject({ writes: false, refusedBy: ["daemon"] });
  });

  it("names both keepers when the daemon and the CLI both refuse", async () => {
    const enforcement = await enforcementFor(
      seatedOn("codex", "worker"),
      codexLike,
      () => ["engineer", "reviewer", "worker", "caller"],
    );
    expect(enforcement?.refusedBy).toEqual(["daemon", "harness"]);
  });

  it("says a codex reviewer cannot write, and credits the CLI for it", async () => {
    const enforcement = await enforcementFor(
      seatedOn("codex", "reviewer"),
      codexLike,
    );
    expect(enforcement).toMatchObject({
      writes: false,
      refusedBy: ["harness"],
      confinement: "read-only",
    });
  });

  it("does not claim a claude-code reviewer cannot write", async () => {
    // The claim that would be false, and the whole reason this is computed per
    // harness rather than per role: nothing refuses these writes outright. The
    // leash bounds *where* they may land, which is a different sentence.
    const enforcement = await enforcementFor(
      seatedOn("claude-code", "reviewer"),
      claudeLike,
    );
    expect(enforcement).toMatchObject({
      writes: true,
      refusedBy: [],
      confinement: "none",
    });
  });

  it("leaves confinement absent for a harness that does not declare one", async () => {
    // Absent is not `"none"`. A third-party harness that says nothing has not
    // said it confines nothing, and the Desk prints those differently.
    const enforcement = await enforcementFor(
      seatedOn("claude-code", "reviewer"),
      unknownConfinement,
    );
    expect(enforcement && "confinement" in enforcement).toBe(false);
    expect(enforcement?.writes).toBe(true);
  });

  it("reports whether the harness can play the seat at all", async () => {
    const bad = await enforcementFor(
      seatedOn("ollama", "reviewer"),
      claudeLike,
    );
    expect(bad?.canPlaySeat).toBe(false);
    const good = await enforcementFor(seatedOn("ollama", "worker"), claudeLike);
    expect(good?.canPlaySeat).toBe(true);
  });

  it("leaves the seat unjudged when nobody knows the harness's roles", async () => {
    const enforcement = await enforcementFor(
      seatedOn("somebody-elses", "reviewer"),
      unknownConfinement,
      unknownRoles,
    );
    expect(enforcement && "canPlaySeat" in enforcement).toBe(false);
  });
});
