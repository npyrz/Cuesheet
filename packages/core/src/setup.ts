/**
 * What each harness needs before it can do anything, and where to get it.
 *
 * Step 45. A probe answers *whether* a CLI is there — `installed`, `authed`,
 * and an `error` reading ``` `claude` is not on your PATH ```. That is a
 * diagnosis, and the step's own wording asks for more: "say what is missing
 * **and how to get it**." A stranger reading that a binary is not on their
 * PATH has been told they have a problem and not told they can fix it in one
 * line.
 *
 * So the remedy lives here, beside the diagnosis rather than inside it.
 *
 * ## Why this is a table and not a field on `HarnessProbe`
 *
 * A probe describes *this machine right now*: it shells out, it can hang, it
 * goes stale the moment somebody runs an installer. Where Claude Code is
 * downloaded from is none of those things — it is the same sentence on a
 * machine that has it and a machine that never will, and it is knowable
 * without a daemon. Putting it on the probe would mean a UI that cannot say
 * how to install a harness until it has finished failing to find it, and a
 * launch surface with no project open could not say it at all.
 *
 * ## Why these strings and not others
 *
 * Every one of them is already in the README under **Requirements**, which is
 * the closest thing this repo has to a source of truth for facts about other
 * people's products. They are copied rather than recalled, and they are the
 * three the README lists. If one of them changes, both places change — a
 * duplication worth naming, and the alternative is a harness interface that
 * asks a third-party author for marketing copy.
 *
 * **This file imports nothing that touches disk.** It is published at
 * `@cuesheet/core/setup` so the Desk can import its *values* — types from the
 * barrel, values from a subpath, the rule Step 40 paid for.
 */
import type { HarnessId, HarnessProbe } from "./types.js";

/** How to get one harness, and what to do once you have it. */
export interface HarnessSetup {
  id: HarnessId;
  /** The product's name, spelled the way its makers spell it. */
  name: string;
  /** One line for somebody who has not heard of it. */
  what: string;
  /** Where to get it. */
  url: string;
  /**
   * What to run once it is installed, when installing is not enough.
   *
   * Absent for `ollama`, which has no account: its second step is pulling a
   * model, which is {@link HarnessSetup.then} rather than a sign-in. Two
   * different second steps, and calling the model pull a login would put a
   * sentence about credentials on the one harness that has none.
   */
  signIn?: string;
  /** A second step that is not signing in. */
  then?: string;
}

/**
 * The harnesses this build ships, in the order a first run should consider
 * them.
 *
 * Not `BUILTIN_HARNESS_IDS` order, and the difference is the point: that
 * constant exists for probe ordering, and this is a recommendation. A harness
 * with no id here is not an error — third-party harnesses are the reason
 * `HarnessId` is an open string — it simply has no advice to offer, and
 * {@link harnessSetup} says so by returning `null` rather than inventing a
 * URL.
 */
const SETUP: readonly HarnessSetup[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    what: "Anthropic’s CLI. Writes code, reviews code.",
    url: "https://claude.com/claude-code",
    signIn: "claude login",
  },
  {
    id: "codex",
    name: "Codex CLI",
    what: "OpenAI’s CLI. A second opinion from a different vendor.",
    url: "https://developers.openai.com/codex",
    signIn: "codex login",
  },
  {
    id: "ollama",
    name: "Ollama",
    what: "Models on your own machine. Free, private, and worker-only.",
    url: "https://ollama.com",
    then: "ollama pull qwen3-coder",
  },
];

export function harnessSetup(id: HarnessId): HarnessSetup | null {
  return SETUP.find((entry) => entry.id === id) ?? null;
}

/** Every harness with advice to offer, in recommendation order. */
export function allHarnessSetup(): readonly HarnessSetup[] {
  return SETUP;
}

/**
 * The remedy for one probe, in one sentence, or `null` when nothing is wrong.
 *
 * Reads the probe rather than taking a boolean, because the two failures want
 * different sentences and the difference is easy to collapse: a CLI that is
 * not installed and a CLI that is installed and not signed in are one step
 * apart, and telling somebody to download something they already have is how
 * a setup screen loses their trust in one line.
 *
 * `mock` has no entry and needs none — it is code in this process — so it
 * returns `null` and is correctly never advised about.
 */
export function setupAdvice(probe: HarnessProbe): string | null {
  const setup = harnessSetup(probe.harness);
  if (setup === null) return null;
  if (!probe.installed) return `Get it at ${setup.url}`;
  if (!probe.authed) {
    if (setup.signIn !== undefined) return `Run \`${setup.signIn}\``;
    if (setup.then !== undefined) return `Run \`${setup.then}\``;
    return null;
  }
  return null;
}
