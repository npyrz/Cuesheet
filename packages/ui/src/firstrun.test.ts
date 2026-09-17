import { describe, expect, it } from "vitest";
import type { HarnessProbe } from "@cuesheet/core";
import { describeOptions, firstStep, starterStation } from "./firstrun.js";

function probe(
  harness: string,
  installed: boolean,
  authed: boolean,
): HarnessProbe {
  return { harness, installed, authed };
}

const MOCK = probe("mock", true, true);

function input(over: Partial<Parameters<typeof firstStep>[0]> = {}) {
  return {
    harnesses: [MOCK],
    stations: 0,
    runs: 0,
    projectName: "api",
    ...over,
  };
}

describe("the first move", () => {
  it("asks you to install something when nothing real is there", () => {
    const step = firstStep(input());
    expect(step?.kind).toBe("install");
  });

  it("does not count `mock` as being set up", () => {
    // It is always installed and always authed — it is code in this process.
    // Treating it as ready would mean a fresh machine is told it is finished.
    const step = firstStep(input());
    expect(step?.kind).not.toBe("add");
  });

  it("offers the demo anyway, by name", () => {
    // `defaultHarnesses()` keeps `mock` shipped on the argument that a first
    // run showing nothing because nothing is installed is a worse
    // introduction than a fake one that moves. This is that argument, on
    // screen.
    const step = firstStep(input());
    expect(step?.kind === "install" && step.demo).toBe("mock");
  });

  it("offers no demo in a build that ships none", () => {
    const step = firstStep(input({ harnesses: [] }));
    expect(step?.kind === "install" && step.demo).toBeNull();
  });

  it("names every harness with somewhere to go, probe or no probe", () => {
    // A harness the daemon failed to probe still exists and can still be
    // downloaded. Its absence is not a reason to stop saying so.
    const options = describeOptions([]);
    expect(options.map((option) => option.setup.id)).toEqual([
      "claude-code",
      "codex",
      "ollama",
    ]);
    for (const option of options) {
      expect(option.advice).toMatch(/^Get it at https:\/\//);
    }
  });
});

describe("installed, not signed in", () => {
  const halfway = input({
    harnesses: [MOCK, probe("claude-code", true, false)],
  });

  it("is its own step rather than being folded into install", () => {
    expect(firstStep(halfway)?.kind).toBe("sign-in");
  });

  it("does not tell you to download what you already have", () => {
    const step = firstStep(halfway);
    const claude =
      step?.kind === "sign-in"
        ? step.options.find((option) => option.setup.id === "claude-code")
        : undefined;
    expect(claude?.advice).toBe("Run `claude login`");
  });
});

describe("ready, and nobody seated", () => {
  it("names the harness and the project in the button", () => {
    const step = firstStep(
      input({ harnesses: [MOCK, probe("claude-code", true, true)] }),
    );
    expect(step?.kind).toBe("add");
    expect(step?.kind === "add" && step.harness).toBe("claude-code");
    // The button says what will happen. "OK" on a screen that is about to
    // write to somebody's cuesheet.toml is not a description of anything.
    expect(step?.kind === "add" && step.action).toBe("Add Claude Code to api");
  });

  it("prefers a harness that can write over one that answers first", () => {
    // `ollama` probes authed whenever its server answers — it has no account
    // to be signed out of — so on a machine running Ollama and nothing else
    // it is the first harness that *looks* ready. It is also worker-only, and
    // a worker never writes: a first run seated there would stream text, cost
    // nothing, change no files, and leave somebody concluding the app does
    // not work. Nothing on the wire says that before a Station exists, so the
    // recommendation order carries it.
    const step = firstStep(
      input({
        harnesses: [
          MOCK,
          probe("ollama", true, true),
          probe("claude-code", true, true),
        ],
      }),
    );
    expect(step?.kind === "add" && step.harness).toBe("claude-code");
  });

  it("still offers Ollama when it is genuinely all there is", () => {
    const step = firstStep(
      input({ harnesses: [MOCK, probe("ollama", true, true)] }),
    );
    expect(step?.kind === "add" && step.harness).toBe("ollama");
  });

  it("does not nag about a second CLI once one of them works", () => {
    // Claude Code ready, Codex installed and signed out. There is nothing
    // blocking this person, and a sign-in prompt would be an interruption
    // rather than an instruction.
    const step = firstStep(
      input({
        harnesses: [
          MOCK,
          probe("claude-code", true, true),
          probe("codex", true, false),
        ],
      }),
    );
    expect(step?.kind).toBe("add");
  });
});

describe("seated, and nothing asked of it", () => {
  it("offers a prompt box, which is the move with no state behind it", () => {
    const step = firstStep(input({ stations: 1 }));
    expect(step?.kind).toBe("run");
  });

  it("stops once a run exists", () => {
    // A surface still offering the first step after the first step is done
    // reads as an app that has not noticed.
    expect(firstStep(input({ stations: 1, runs: 1 }))).toBeNull();
  });

  it("guides an emptied project again, however many runs it has had", () => {
    // The guide is about what is missing, not about how new somebody is.
    // Keyed on run count, a project whose last Station was deleted would get
    // a blank screen and no way forward.
    const step = firstStep(
      input({
        stations: 0,
        runs: 40,
        harnesses: [MOCK, probe("claude-code", true, true)],
      }),
    );
    expect(step?.kind).toBe("add");
  });
});

describe("starterStation", () => {
  it("answers all five questions, so there is nothing to type", () => {
    const draft = starterStation("claude-code", "/code/api", []);
    expect(draft).toEqual({
      id: "claude-code",
      harness: "claude-code",
      role: "engineer",
      // The project you are standing in. The README's promise about this
      // panel is that nothing in it requires you to type a path.
      workspace: "/code/api",
      paths: ["**"],
      // Seeded, because the allow is `**`, the matcher runs with `dot: true`,
      // and nothing else in the system stops a rewrite of `.git/hooks/`.
      deny: [".git/**"],
    });
  });

  it("does not collide with a Station that is already there", () => {
    expect(starterStation("claude-code", "/code/api", ["claude-code"]).id).toBe(
      "claude-code-2",
    );
  });

  it("compares names case-insensitively, as the daemon does", () => {
    expect(starterStation("claude-code", "/code/api", ["Claude-Code"]).id).toBe(
      "claude-code-2",
    );
  });
});
