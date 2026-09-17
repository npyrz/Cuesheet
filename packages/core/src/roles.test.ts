import { describe, expect, it } from "vitest";
import type { Station } from "./config.js";
import { ROLES } from "./types.js";
import {
  confinementNote,
  rolePurpose,
  roleRefusals,
  writeDeniedByRole,
  writePosture,
} from "./roles.js";

function station(over: Partial<Station> & { id: string }): Station {
  return {
    harness: "claude-code",
    role: "engineer",
    workspace: "/tmp/ws",
    ...over,
  };
}

describe("writeDeniedByRole", () => {
  it("refuses a worker's writes and says which role to use instead", () => {
    const reason = writeDeniedByRole(station({ id: "tagger", role: "worker" }));
    expect(reason).toContain("a worker never writes");
    expect(reason).toContain("engineer");
  });

  it("does not refuse the other three", () => {
    // The asymmetry `leash.ts` has carried a note about for two phases: Codex
    // runs a reviewer and a caller read-only, and this facade deliberately
    // does not, because widening it would change the Phase 7 gate path with no
    // test covering it either way. Asserted so the narrowness is a decision
    // somebody has to un-take on purpose.
    for (const role of ROLES) {
      if (role === "worker") continue;
      expect(writeDeniedByRole(station({ id: "s", role }))).toBeUndefined();
    }
  });
});

describe("rolePurpose", () => {
  it("has a sentence for every role", () => {
    for (const role of ROLES) {
      expect(rolePurpose(role).length).toBeGreaterThan(0);
    }
  });

  it("never prints markdown punctuation", () => {
    // The defect corrected in Step 36 and again in Step 40: these render as
    // bare text in the Desk, so a backtick arrives on screen as a backtick.
    for (const role of ROLES) {
      expect(rolePurpose(role)).not.toContain("`");
    }
  });
});

describe("roleRefusals", () => {
  it("attributes the refusal to the daemon, because that is who keeps it", () => {
    expect(roleRefusals("worker")[0]).toContain("daemon");
  });

  it("claims nothing for a role the daemon does not stop", () => {
    expect(roleRefusals("reviewer")).toEqual([]);
    expect(roleRefusals("caller")).toEqual([]);
    expect(roleRefusals("engineer")).toEqual([]);
  });
});

describe("confinementNote", () => {
  it("names the harness as the one keeping a read-only promise", () => {
    const note = confinementNote("codex", "reviewer", "read-only");
    expect(note).toContain("codex");
    expect(note).toContain("read-only");
  });

  it("says the leash is the whole boundary when a harness confines nothing", () => {
    const note = confinementNote("claude-code", "reviewer", "none");
    expect(note).toContain("leash");
    expect(note).not.toMatch(/cannot write|refuses writes/);
  });

  it("gets the article right, on a screen that has to be believed", () => {
    expect(confinementNote("codex", "engineer", "none")).toContain(
      "an engineer",
    );
    expect(confinementNote("codex", "reviewer", "none")).toContain(
      "a reviewer",
    );
  });

  it("reports an undeclared harness as unknown rather than unconfined", () => {
    // A third-party harness that says nothing has not said "none". Writing a
    // harness is the contribution this project most wants, and guessing on its
    // behalf would make the guess load-bearing.
    const note = confinementNote("someone-elses", "reviewer", undefined);
    expect(note).toContain("does not say");
  });

  it("never prints markdown punctuation", () => {
    for (const role of ROLES) {
      for (const c of [
        "read-only",
        "workspace-write",
        "none",
        undefined,
      ] as const) {
        expect(confinementNote("codex", role, c)).not.toContain("`");
      }
    }
  });
});

describe("writePosture", () => {
  it("reports both keepers when the daemon and the CLI both refuse", () => {
    // A worker on Codex. Two processes refuse this independently, and a badge
    // that collapsed them could not answer "who promised it?" — the question
    // that matters the moment somebody swaps the harness.
    const posture = writePosture(
      station({ id: "tagger", harness: "codex", role: "worker" }),
      "read-only",
    );
    expect(posture).toEqual({
      writes: false,
      refusedBy: ["daemon", "harness"],
    });
  });

  it("reports a codex reviewer as refused by the harness alone", () => {
    expect(
      writePosture(
        station({ id: "rev", harness: "codex", role: "reviewer" }),
        "read-only",
      ),
    ).toEqual({ writes: false, refusedBy: ["harness"] });
  });

  it("does not claim a claude-code reviewer cannot write", () => {
    // The claim that would be false. Nothing refuses this Station's writes
    // outright: the leash bounds *where*, and that is a different sentence.
    expect(
      writePosture(station({ id: "rev", role: "reviewer" }), "none"),
    ).toEqual({ writes: true, refusedBy: [] });
  });

  it("does not treat a workspace-write sandbox as a refusal", () => {
    // It bounds where writes may land, which is what the leash also does. Only
    // `read-only` is somebody refusing them outright.
    expect(
      writePosture(
        station({ id: "s", harness: "someone-elses", role: "reviewer" }),
        "workspace-write",
      ),
    ).toEqual({ writes: true, refusedBy: [] });
  });

  it("treats an undeclared harness as not refusing", () => {
    expect(
      writePosture(station({ id: "rev", role: "reviewer" }), undefined).writes,
    ).toBe(true);
  });
});
