import { describe, expect, it } from "vitest";
import type { HarnessUsage, Ledger, Limits, Station } from "@cuesheet/core";
import type { StationEnforcement, StationView } from "./api/client.js";
import { describePosture } from "./posture.js";

const LIMITS: Limits = { warn_at: 0.8, block_at: 0.95, when_capped: {} };
const NOW = Date.parse("2026-09-16T12:00:00Z");
const now = () => NOW;

function view(
  station: Partial<Station> & { id: string },
  enforcement: Partial<StationEnforcement> = {},
  probe: Partial<StationView["probe"]> = {},
): StationView {
  const harness = station.harness ?? "claude-code";
  return {
    station: {
      harness,
      role: "engineer",
      workspace: "/Users/noah/code/api",
      paths: ["src/**"],
      ...station,
    },
    probe: { harness, installed: true, authed: true, version: "2.1", ...probe },
    enforcement: { writes: true, refusedBy: [], ...enforcement },
  };
}

const posture = (
  views: StationView[],
  extra: {
    usage?: HarnessUsage[];
    ledger?: Ledger;
  } = {},
) => describePosture(views, { limits: LIMITS, now, ...extra });

describe("what a Station may do", () => {
  it("says a worker's writes are refused, and by whom", () => {
    const [row] = posture([
      view(
        { id: "tagger", role: "worker" },
        { writes: false, refusedBy: ["daemon"] },
      ),
    ]);
    const refusal = row?.permissions.find((line) => line.keptBy === "daemon");
    expect(refusal?.tone).toBe("refused");
    expect(refusal?.text).toContain("worker never writes");
  });

  it("credits the CLI when the CLI is the one refusing", () => {
    const [row] = posture([
      view(
        { id: "rev", harness: "codex", role: "reviewer" },
        { writes: false, refusedBy: ["harness"], confinement: "read-only" },
      ),
    ]);
    const refusal = row?.permissions.find((line) => line.keptBy === "harness");
    expect(refusal?.tone).toBe("refused");
    expect(refusal?.text).toContain("codex");
    expect(refusal?.text).toContain("read-only");
  });

  /**
   * The claim that would be false, and the reason any of this is computed per
   * harness rather than per role. Claude Code takes no role-based sandbox
   * flag, so a reviewer on it really can write inside its leash.
   */
  it("never tells a claude-code reviewer it cannot write", () => {
    const [row] = posture([
      view(
        { id: "rev", role: "reviewer" },
        { writes: true, confinement: "none" },
      ),
    ]);
    expect(row?.permissions.some((line) => line.tone === "refused")).toBe(
      false,
    );
    for (const line of row?.permissions ?? []) {
      expect(line.text).not.toMatch(/cannot write|writes are refused/i);
    }
  });

  /**
   * The fourth value of a four-value union, and the one no shipped harness
   * returns yet — so it had never been rendered. A harness that confines a seat
   * to the workspace has *bounded* it, not refused it, and the difference is
   * the whole subject of this screen.
   */
  it("treats a workspace-write confinement as a bound, not a refusal", () => {
    const [row] = posture([
      view(
        { id: "rev", harness: "someone-elses", role: "reviewer" },
        { writes: true, refusedBy: [], confinement: "workspace-write" },
      ),
    ]);
    const line = row?.permissions.find((entry) => entry.keptBy === "harness");
    expect(line?.tone).toBe("bounded");
    expect(line?.text).toContain("the leash decides");
    for (const entry of row?.permissions ?? []) {
      expect(entry.text).not.toMatch(/cannot write|writes are refused/i);
    }
  });

  it("reports an undeclared harness as unknown rather than unconfined", () => {
    const [row] = posture([
      view({ id: "x", harness: "somebody-elses", role: "reviewer" }),
    ]);
    const line = row?.permissions.find((entry) => entry.tone === "unknown");
    expect(line?.text).toContain("does not say");
  });

  it("puts the seat it cannot play above everything else", () => {
    const [row] = posture([
      view(
        { id: "local", harness: "ollama", role: "reviewer" },
        { canPlaySeat: false },
      ),
    ]);
    expect(row?.permissions[0]?.tone).toBe("refused");
    expect(row?.permissions[0]?.text).toContain(
      "cannot play the reviewer seat",
    );
  });
});

describe("the leash, written as sentences", () => {
  it("says an empty allow list means it can write nothing", () => {
    // The inversion this exists to prevent: the leash defaults to deny, so a
    // Station with no `paths` writes nowhere — and a screen rendering an empty
    // list reads as "no restrictions".
    const [row] = posture([view({ id: "s", paths: [] })]);
    const line = row?.permissions.find((entry) =>
      entry.text.includes("defaults to deny"),
    );
    expect(line?.tone).toBe("refused");
  });

  it("does not offer write permissions to a Station whose writes are refused", () => {
    // Two lines apart, this screen would otherwise say "writes are refused"
    // and "may write src/**".
    const [row] = posture([
      view(
        { id: "tagger", role: "worker" },
        { writes: false, refusedBy: ["daemon"] },
      ),
    ]);
    expect(
      row?.permissions.some((line) => line.text.startsWith("May write")),
    ).toBe(false);
    expect(
      row?.permissions.some((line) => line.text.includes("apply to reads")),
    ).toBe(true);
  });

  it("says a deny rule beats an allow rule", () => {
    const [row] = posture([
      view({ id: "s", paths: ["src/**"], deny: ["infra/**", "**/*.env"] }),
    ]);
    const line = row?.permissions.find((entry) =>
      entry.text.startsWith("Denied"),
    );
    expect(line?.text).toContain("infra/**");
    expect(line?.text).toContain("beats an allow rule");
  });

  it("says a Station with no workspace cannot run", () => {
    const [row] = posture([view({ id: "s", workspace: undefined })]);
    expect(row?.workspace).toBeNull();
    expect(row?.permissions[0]?.text).toContain("cannot run");
  });
});

describe("spend", () => {
  const ledger = (usd: number | undefined): Ledger => ({
    totals: { tokensIn: 0, tokensOut: 0, runs: 0 },
    byDay: [],
    byVendor: [],
    byStation: [
      {
        key: "opus",
        tokensIn: 12_000,
        tokensOut: 3_000,
        runs: 4,
        ...(usd !== undefined && { usd }),
      },
    ],
    runs: [],
    unattributed: { tokensIn: 0, tokensOut: 0, runs: 0 },
  });

  it("joins the ledger to the Station by id", () => {
    const [row] = posture([view({ id: "opus" })], { ledger: ledger(1.24) });
    expect(row?.spend).toEqual({
      usd: "$1.24",
      tokens: "15.0k",
      runs: "4 runs",
    });
  });

  it("counts one run singularly", () => {
    const one = ledger(0.4);
    one.byStation[0]!.runs = 1;
    const [row] = posture([view({ id: "opus" })], { ledger: one });
    expect(row?.spend?.runs).toBe("1 run");
  });

  it("says nothing about a Station that has never run", () => {
    const [row] = posture([view({ id: "sonnet" })], { ledger: ledger(1.24) });
    expect(row?.spend).toBeNull();
  });

  it("prints a dash rather than $0.00 when nothing reported a price", () => {
    // The same refusal the limits strip makes: unreported is not zero.
    const [row] = posture([view({ id: "opus" })], {
      ledger: ledger(undefined),
    });
    expect(row?.spend?.usd).toBe("—");
  });

  it("renders without a ledger at all", () => {
    // It is a second fetch. A screen that is blank until it lands is a screen
    // that is blank whenever the ledger is slow.
    const [row] = posture([view({ id: "opus" })]);
    expect(row?.spend).toBeNull();
    expect(row?.permissions.length).toBeGreaterThan(0);
  });
});

describe("how close this Station is to a cap", () => {
  const usage = (windows: HarnessUsage["windows"]): HarnessUsage[] => [
    { harness: "claude-code", vendor: "anthropic", windows },
  ];

  it("shows the harness's nearest measured window", () => {
    const [row] = posture([view({ id: "opus" })], {
      usage: usage([
        { window: "weekly", state: "measured", used: 0.1 },
        { window: "five_hour", state: "measured", used: 0.9 },
      ]),
    });
    expect(row?.cap?.window).toBe("five_hour");
    expect(row?.cap?.value).toBe("90%");
    expect(row?.cap?.tone).toBe("warn");
  });

  it("asks per harness, not per vendor", () => {
    // The strip groups by vendor, because a plan belongs to one. This does not:
    // a Station runs on a harness, and it is the harness that was asked.
    const [row] = posture([view({ id: "rev", harness: "codex" })], {
      usage: usage([{ window: "five_hour", state: "measured", used: 0.9 }]),
    });
    expect(row?.cap).toBeNull();
  });

  it("keeps a reported status rather than showing nothing", () => {
    const [row] = posture([view({ id: "opus" })], {
      usage: usage([{ window: "session", state: "not-blocked" }]),
    });
    expect(row?.cap?.value).toBe("—");
    expect(row?.cap?.note).toContain("status, not a number");
  });

  it("says a local harness cannot run out", () => {
    // Step 35 is skipped, so the local row this step renders is `mock`'s real
    // answer rather than a placeholder for a harness nobody has written.
    const [row] = posture([view({ id: "m", harness: "mock" })], {
      usage: [
        {
          harness: "mock",
          vendor: "cuesheet",
          windows: [{ window: "local", state: "unmetered" }],
        },
      ],
    });
    expect(row?.cap?.value).toBe("∞");
    expect(row?.cap?.tone).toBe("free");
  });
});

describe("the rest of a row", () => {
  it("carries the seat's purpose from core", () => {
    const [row] = posture([view({ id: "rev", role: "reviewer" })]);
    expect(row?.purpose).toContain("verdict");
  });

  it("reports an uninstalled harness with the probe's own reason", () => {
    const [row] = posture([
      view(
        { id: "s" },
        {},
        {
          installed: false,
          authed: false,
          error: "`claude` is not on your PATH.",
        },
      ),
    ]);
    expect(row?.available).toBe(false);
    expect(row?.availability).toContain("not on your PATH");
  });

  it("never prints markdown punctuation in a sentence it composes", () => {
    // Step 36 and Step 40 both shipped a backtick to screen. Every sentence
    // this file builds is checked; a probe's own text is the daemon's to fix.
    const [row] = posture([
      view(
        { id: "s", role: "worker", deny: ["**/*.env"] },
        { writes: false, refusedBy: ["daemon"] },
      ),
    ]);
    for (const line of row?.permissions ?? []) {
      expect(line.text).not.toContain("`");
    }
  });
});
