import { describe, expect, it } from "vitest";
import { chooseFallback } from "./fallback.js";
import { parseConfig, type Station } from "./config.js";
import type { Role } from "./types.js";

const limits = (when_capped: Record<string, string> = {}) =>
  parseConfig(
    `[limits]\nwhen_capped = { ${Object.entries(when_capped)
      .map(([k, v]) => `${k} = "${v}"`)
      .join(", ")} }\n`,
    null,
  ).config.limits;

function station(overrides: Partial<Station> & { id: string }): Station {
  return {
    harness: "codex",
    role: "reviewer",
    workspace: "/ws",
    ...overrides,
  };
}

/** What the default registry answers, near enough for these rules. */
const ROLES: Record<string, readonly Role[]> = {
  "claude-code": ["engineer", "reviewer", "caller"],
  codex: ["engineer", "reviewer", "caller"],
  ollama: ["worker"],
};
const rolesOf = (harness: string): readonly Role[] | undefined =>
  ROLES[harness];

describe("chooseFallback", () => {
  it("proceeds when nothing is capped", () => {
    const codex = station({ id: "codex" });
    expect(
      chooseFallback({
        station: codex,
        limits: limits({ codex: "opus" }),
        stations: [codex],
        capped: [],
        rolesOf,
      }),
    ).toEqual({ kind: "proceed" });
  });

  it("routes a capped Station to a fallback in the same seat", () => {
    // The README's own example, with the one correction the router insists on:
    // the stand-in holds the same role.
    const codex = station({ id: "codex", harness: "codex", role: "reviewer" });
    const spare = station({
      id: "spare",
      harness: "claude-code",
      role: "reviewer",
    });
    const decision = chooseFallback({
      station: codex,
      limits: limits({ codex: "spare" }),
      stations: [codex, spare],
      capped: ["codex"],
      rolesOf,
    });
    expect(decision).toMatchObject({ kind: "substitute" });
    if (decision.kind !== "substitute") throw new Error("expected substitute");
    expect(decision.station.id).toBe("spare");
    expect(decision.reason).toContain("at its cap");
  });

  it("refuses to put a worker in a reviewer's seat", () => {
    // This is the whole safety argument. Step 36 made this combination a
    // warning the daemon prints at a human; a router doing it unprompted, at
    // runtime, would be worse than the run stopping — a small local model
    // reviewing a frontier model's diff approves nearly everything.
    const codex = station({ id: "codex", role: "reviewer" });
    const qwen = station({ id: "qwen", harness: "ollama", role: "worker" });
    const decision = chooseFallback({
      station: codex,
      limits: limits({ codex: "qwen" }),
      stations: [codex, qwen],
      capped: ["codex"],
      rolesOf,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected refusal");
    expect(decision.reason).toContain("cannot stand in for");
  });

  it("refuses when the fallback's harness cannot play the seat", () => {
    // Roles match on paper and the harness still cannot do it: `ollama` ships
    // `roles: ["worker"]`, so naming it as an engineer's fallback is a config
    // error rather than an instruction.
    const opus = station({
      id: "opus",
      harness: "claude-code",
      role: "engineer",
    });
    const local = station({ id: "local", harness: "ollama", role: "engineer" });
    const decision = chooseFallback({
      station: opus,
      limits: limits({ opus: "local" }),
      stations: [opus, local],
      capped: ["claude-code"],
      rolesOf,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected refusal");
    expect(decision.reason).toContain("cannot play the engineer seat");
  });

  it("refuses when no fallback is configured at all", () => {
    const codex = station({ id: "codex" });
    const decision = chooseFallback({
      station: codex,
      limits: limits(),
      stations: [codex],
      capped: ["codex"],
      rolesOf,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected refusal");
    expect(decision.reason).toContain('no "when_capped" fallback');
    // No backticks in anything user-facing: these reasons are rendered as bare
    // text in a run log and in a 409 body, where markdown punctuation arrives
    // on screen as punctuation.
    expect(decision.reason).not.toContain("`");
  });

  it("refuses a fallback that is not a configured Station", () => {
    const codex = station({ id: "codex" });
    const decision = chooseFallback({
      station: codex,
      limits: limits({ codex: "ghost" }),
      stations: [codex],
      capped: ["codex"],
      rolesOf,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected refusal");
    expect(decision.reason).toContain("not a configured Station");
  });

  it("refuses to route into another capped harness", () => {
    const codex = station({ id: "codex", harness: "codex" });
    const spare = station({ id: "spare", harness: "claude-code" });
    const decision = chooseFallback({
      station: codex,
      limits: limits({ codex: "spare" }),
      stations: [codex, spare],
      capped: ["codex", "claude-code"],
      rolesOf,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected refusal");
    expect(decision.reason).toContain("capped too");
  });

  it("allows a substitute whose harness nobody has registered", () => {
    // A third-party harness answers `undefined` for its roles. The role match
    // above already did the work; refusing here as well would make every
    // out-of-tree harness unusable as a fallback, which is the same hostility
    // the seat warning deliberately avoids.
    const codex = station({ id: "codex", role: "engineer" });
    const other = station({ id: "other", harness: "acme", role: "engineer" });
    const decision = chooseFallback({
      station: codex,
      limits: limits({ codex: "other" }),
      stations: [codex, other],
      capped: ["codex"],
      rolesOf,
    });
    expect(decision.kind).toBe("substitute");
  });
});
