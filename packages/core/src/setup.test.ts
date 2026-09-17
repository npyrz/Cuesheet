import { describe, expect, it } from "vitest";
import type { HarnessProbe } from "./types.js";
import { BUILTIN_HARNESS_IDS } from "./types.js";
import { allHarnessSetup, harnessSetup, setupAdvice } from "./setup.js";

function probe(over: Partial<HarnessProbe> = {}): HarnessProbe {
  return { harness: "claude-code", installed: true, authed: true, ...over };
}

describe("harnessSetup", () => {
  it("has advice for every harness this build ships", () => {
    // `BUILTIN_HARNESS_IDS` is the list a Desk offers. One of them with no
    // way to get it is a row that says "not installed" and stops there.
    for (const id of BUILTIN_HARNESS_IDS) {
      expect(harnessSetup(id), id).not.toBeNull();
    }
  });

  it("says nothing about a harness it has never heard of", () => {
    // `HarnessId` is an open string so third-party harnesses can exist. An
    // invented URL would be worse than silence.
    expect(harnessSetup("some-third-party-thing")).toBeNull();
  });

  it("says nothing about `mock`, which is code in this process", () => {
    expect(harnessSetup("mock")).toBeNull();
  });

  it("gives every entry somewhere to go and something to read", () => {
    for (const entry of allHarnessSetup()) {
      expect(entry.url, entry.id).toMatch(/^https:\/\//);
      expect(entry.what, entry.id).not.toBe("");
      expect(entry.name, entry.id).not.toBe("");
    }
  });

  it("does not call Ollama's second step a sign-in", () => {
    // It has no account. A sentence about credentials on the one harness that
    // has none is the kind of wrong that makes somebody go looking for a
    // login page that does not exist.
    const ollama = harnessSetup("ollama");
    expect(ollama?.signIn).toBeUndefined();
    expect(ollama?.then).toBe("ollama pull qwen3-coder");
  });
});

describe("setupAdvice", () => {
  it("sends you to the download when there is no binary", () => {
    expect(setupAdvice(probe({ installed: false, authed: false }))).toBe(
      "Get it at https://claude.com/claude-code",
    );
  });

  it("does not tell you to download something you already have", () => {
    // One step apart, and collapsing them is how a setup screen loses
    // somebody's trust in a single line.
    expect(setupAdvice(probe({ authed: false }))).toBe("Run `claude login`");
  });

  it("asks for a model rather than a login where there is no account", () => {
    expect(
      setupAdvice({ harness: "ollama", installed: true, authed: false }),
    ).toBe("Run `ollama pull qwen3-coder`");
  });

  it("has nothing to say about a harness that is ready", () => {
    expect(setupAdvice(probe())).toBeNull();
  });

  it("has nothing to say about a harness it does not know", () => {
    expect(
      setupAdvice({ harness: "mock", installed: true, authed: true }),
    ).toBeNull();
    expect(
      setupAdvice({ harness: "mine", installed: false, authed: false }),
    ).toBeNull();
  });
});
