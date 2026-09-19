/**
 * The one thing to do next, for somebody who has never edited a TOML.
 *
 * Step 45. The path from a fresh install to a first run is four moves —
 * install a CLI, sign into it, put it in a seat, give it something to do —
 * and before this the app only ever drew the *state* each of those leaves
 * behind. "No Stations yet" is an accurate description of a project and not
 * an instruction to anybody; "not installed", on a row in a panel a stranger
 * has not found yet, is a diagnosis with no remedy attached.
 *
 * So this decides which of the four moves is the current one, and the surface
 * draws that and nothing else. One instruction at a time, because a screen
 * that lists four is a screen where somebody starts on the wrong one.
 *
 * Pure, and in a `.ts` for the reason `posture.ts` and `surface.ts` are:
 * vitest collects colocated `.test.ts` and not `.tsx`, so a rule written in a
 * component is a rule no test can reach. That matters here because the rules
 * are about *ordering*, and the ordering is the whole design.
 */
import type { HarnessProbe, HarnessId } from "@cuesheet/core";
import {
  allHarnessSetup,
  setupAdvice,
  type HarnessSetup,
} from "@cuesheet/core/setup";

export interface FirstRunInput {
  /** Every harness the daemon probed. */
  harnesses: readonly HarnessProbe[];
  /** How many Stations this project has. */
  stations: number;
  /** How many runs this project has ever had. */
  runs: number;
  /** For the sentence that says where the work will happen. */
  projectName: string;
}

/** A harness you could get, with how to get it. */
export interface SetupOption {
  setup: HarnessSetup;
  /** `Get it at …`, `Run \`claude login\``, or null when it is ready. */
  advice: string | null;
  installed: boolean;
  authed: boolean;
}

export type FirstStep =
  /** Nothing real is installed. Name what to get, and offer the demo. */
  | {
      kind: "install";
      title: string;
      detail: string;
      options: SetupOption[];
      /** A harness that works with nothing installed, when there is one. */
      demo: HarnessId | null;
    }
  /** Something is installed and not signed in. One command away. */
  | {
      kind: "sign-in";
      title: string;
      detail: string;
      options: SetupOption[];
      demo: HarnessId | null;
    }
  /** Ready, and nobody is seated. One press away. */
  | {
      kind: "add";
      title: string;
      detail: string;
      harness: HarnessId;
      /** The button's words, which say what will happen rather than "OK". */
      action: string;
    }
  /** Seated, and nothing has been asked of it yet. */
  | {
      kind: "run";
      title: string;
      detail: string;
      placeholder: string;
    };

/**
 * Which move is the current one, or `null` when there is no advice to give.
 *
 * The order is the design and each step of it was a decision:
 *
 * - **A project with no Stations is guided whether or not it has runs.** The
 *   guide is about what is *missing*, not about how new somebody is. Keying it
 *   on "has this project ever run" would leave a project whose last Station
 *   was deleted with an empty screen and no way forward, having decided the
 *   person was too experienced to be told anything.
 * - **A project with Stations and no runs gets a prompt box**, because the
 *   last move is the one with no state behind it to discover. Everything else
 *   in this app leaves a visible mark; asking for work leaves nothing until
 *   you have asked, so it is the move most likely to be the one somebody
 *   cannot find.
 * - **And once a run exists, the guide goes.** A surface that keeps offering
 *   the first step after the first step is done reads as an app that has not
 *   noticed.
 */
export function firstStep(input: FirstRunInput): FirstStep | null {
  if (input.stations > 0) {
    if (input.runs > 0) return null;
    return {
      kind: "run",
      title: "Ask for something.",
      detail:
        "Type what you want done. It runs on your machine, in this " +
        "project’s folder, and you can stop it at any point.",
      placeholder: "Add a health check endpoint and a test for it",
    };
  }

  const options = describeOptions(input.harnesses);
  const ready = readyHarness(input.harnesses);

  if (ready !== null) {
    const setup = harnessName(ready);
    return {
      kind: "add",
      title: `${setup} is ready. Put it to work on ${input.projectName}.`,
      detail:
        "A Station is one AI in one seat, with one folder it may touch. " +
        "This one writes code, works in this project’s folder, and is kept " +
        "out of `.git`. You can change any of that afterwards.",
      harness: ready,
      action: `Add ${setup} to ${input.projectName}`,
    };
  }

  const demo = demoHarness(input.harnesses);
  /*
    Installed-but-not-signed-in is one command away and deserves to be told
    apart from having nothing at all. Telling somebody to download a thing
    they already have is how a setup screen loses their trust in a line — the
    same argument `setupAdvice` makes per row, made once for the whole screen.
  */
  if (options.some((option) => option.installed)) {
    return {
      kind: "sign-in",
      title: "Almost. Sign in to the CLI you have.",
      detail:
        "Cuesheet never sees your credentials — it runs the CLI you are " +
        "already logged into. Run this in a terminal, then come back.",
      options,
      demo,
    };
  }

  return {
    kind: "install",
    title: "Cuesheet drives an AI coding CLI. You will need one.",
    detail:
      "Install whichever you already pay for. Cuesheet shells out to it, " +
      "so there is no key to paste and no account to create here.",
    options,
    demo,
  };
}

/**
 * The harness to seat, or `null` when none can work yet.
 *
 * In recommendation order rather than probe order, and that is not a
 * cosmetic preference. `ollama` probes `authed` whenever its server answers
 * — it has no account to be signed out of — so on a machine with Ollama
 * running and nothing else it is the first harness that looks ready. It is
 * also the one harness that may only play `worker`, and a worker never
 * writes, so a first run seated there would stream text, cost nothing,
 * change no files, and leave somebody concluding the app does not work.
 *
 * Nothing on `GET /stations` says that: `canPlaySeat` is computed per
 * configured Station, and at this point there are none. So the order is the
 * carrier of the fact, and this comment is why it must not be re-sorted.
 *
 * `mock` is deliberately never chosen here. It is offered by name as a demo,
 * which is a different sentence from "you are set up".
 */
function readyHarness(probes: readonly HarnessProbe[]): HarnessId | null {
  for (const setup of allHarnessSetup()) {
    const probe = probes.find((candidate) => candidate.harness === setup.id);
    if (probe?.installed === true && probe.authed) return setup.id;
  }
  return null;
}

/**
 * Something that will move with nothing installed, if this build ships one.
 *
 * `mock` stays shipped for exactly this — see `defaultHarnesses()`, which
 * argues that a first run showing nothing because nothing is installed is a
 * worse introduction than a fake one that moves. Found by probe rather than
 * by name, so a build that drops it offers nothing rather than a broken
 * button.
 */
function demoHarness(probes: readonly HarnessProbe[]): HarnessId | null {
  const mock = probes.find(
    (probe) =>
      probe.harness === "mock" && probe.installed && harnessSetupless(probe),
  );
  return mock?.harness ?? null;
}

/** A harness with no setup entry needs no setting up. See `core/setup.ts`. */
function harnessSetupless(probe: HarnessProbe): boolean {
  return setupAdvice(probe) === null;
}

function harnessName(id: HarnessId): string {
  return allHarnessSetup().find((entry) => entry.id === id)?.name ?? id;
}

/**
 * Every harness worth naming, with how to get it and where it stands.
 *
 * Built from the setup table rather than from the probes, so a harness the
 * daemon failed to probe at all still appears with its URL. The probe adds
 * what is known about *this machine*; its absence is not a reason to stop
 * telling somebody the CLI exists.
 */
export function describeOptions(
  probes: readonly HarnessProbe[],
): SetupOption[] {
  return allHarnessSetup().map((setup) => {
    const probe = probes.find((candidate) => candidate.harness === setup.id);
    const installed = probe?.installed ?? false;
    const authed = probe?.authed ?? false;
    return {
      setup,
      installed,
      authed,
      advice: setupAdvice(
        probe ?? { harness: setup.id, installed: false, authed: false },
      ),
    };
  });
}

/**
 * The Station a first run should create, with nothing left to type.
 *
 * The README's promise about the Add-a-Station panel is that "Cuesheet has
 * already made four of [the five choices] by the time you open the panel" and
 * that "nothing here requires you to type a path". This is the fifth choice
 * made as well, for the one case where every answer is obvious: the project
 * you are standing in, the seat that writes, and the leash the panel already
 * seeds.
 *
 * `.git/**` is denied for the reason the panel says: the allow defaults to
 * `**`, the matcher runs with `dot: true`, and nothing else in the system
 * stops an agent rewriting `.git/hooks/`.
 */
export function starterStation(
  harness: HarnessId,
  projectRoot: string,
  taken: readonly string[],
): {
  id: string;
  harness: HarnessId;
  role: "engineer";
  workspace: string;
  paths: string[];
  deny: string[];
} {
  const used = new Set(taken.map((id) => id.toLowerCase()));
  let id = harness.toLowerCase();
  for (let n = 2; used.has(id) && n < 100; n += 1) id = `${harness}-${n}`;
  return {
    id,
    harness,
    role: "engineer",
    workspace: projectRoot,
    paths: ["**"],
    deny: [".git/**"],
  };
}
