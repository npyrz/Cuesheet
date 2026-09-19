/**
 * What a seat means, and — more importantly — who enforces it.
 *
 * The README's claim is that roles are *enforced, not requested*: "A Station
 * denied `infra/**` cannot write there even if the model decides it should."
 * Step 42 is the first surface that has to show that, and showing it honestly
 * means being precise about a thing this repo has so far only known in three
 * separate places:
 *
 * 1. **Cuesheet's own refusal.** `writeDeniedByRole` — a `worker` never
 *    writes, whatever its leash says. Enforced in-process, and the write
 *    becomes a `denial` event on the run.
 * 2. **The leash.** `checkPath` in `leash.ts` — which paths, not whether at
 *    all. Also in-process.
 * 3. **The CLI's own sandbox.** `sandboxFor` in `codex.ts` runs a reviewer,
 *    caller *or* worker `read-only`; `claude-code` has no role-based sandbox
 *    flag at all and is bounded only by (1) and (2).
 *
 * Those three do not agree, and the disagreement is real rather than a defect
 * to paper over — `leash.ts` has carried a note for two phases saying that
 * widening its facade to match Codex's would change the Phase 7 gate path with
 * no test covering it in either direction. So this module does **not** unify
 * them. It states each layer separately and lets a surface say which one is
 * making a promise, because "a reviewer cannot write" is true on `codex` and
 * false on `claude-code`, and a screen that says it for both is lying about
 * one of them.
 *
 * **This file imports nothing that touches disk.** It is published at
 * `@cuesheet/core/roles` so the Desk can import its *values* — the rule Step
 * 40 paid for: types from the barrel, values from a subpath. `writeDeniedByRole`
 * lives here rather than in `leash.ts` for exactly that reason; `leash.ts`
 * imports `node:fs/promises`, and a browser bundle that reaches it renders a
 * blank page.
 */
import type { Station } from "./config.js";
import type { Role } from "./types.js";

/**
 * Whether this Station's *role* forbids writing, whatever its leash allows.
 *
 * A leash answers "which paths?"; this answers "at all?". They are separate
 * questions and they are enforced in separate places, which is why this is a
 * function of its own rather than another branch inside `checkPath` — that one
 * has no notion of an operation, and a `worker` must still be able to read.
 * Classifying a diff, writing a commit message and deduping a memory are all
 * reads.
 *
 * Only `worker` is listed, and the omission is deliberate rather than an
 * oversight. `codex.ts`'s `sandboxFor` already runs a `reviewer` and a
 * `caller` `read-only`, so the CLI-flag layer encodes a wider rule than this
 * one does — but extending the *facade* to match would change the Phase 7 gate
 * path, and no test covers it in either direction. The README's claim that is
 * overdue is this one: a `worker` "cannot review; cannot write code."
 *
 * Returns the reason, so the caller can put it in a denial the operator reads,
 * and `undefined` when the role may write.
 */
export function writeDeniedByRole(station: Station): string | undefined {
  if (station.role !== "worker") return undefined;
  return (
    `Station "${station.id}" is a worker, and a worker never writes. ` +
    `Give it the \`engineer\` role if it is meant to change code.`
  );
}

/**
 * What a harness's *own* sandbox does with a role, as the harness declares it.
 *
 * `undefined` — the harness does not say — is a fourth answer and is not the
 * same as `"none"`. A third-party harness that declares nothing is unknown,
 * and a surface must report it as unknown rather than as unconfined: writing
 * a harness is the contribution this project most wants, and guessing on its
 * behalf would make the guess load-bearing.
 */
export type Confinement = "read-only" | "workspace-write" | "none";

/** What a seat is for, in the one sentence a surface has room for. */
export function rolePurpose(role: Role): string {
  switch (role) {
    case "engineer":
      return "Writes code, inside its leash.";
    case "reviewer":
      return "Reads the diff and files a verdict. Its pass is what a Gate counts.";
    case "worker":
      return "Classifies, summarises, drafts. Every one of those is a read.";
    case "caller":
      return "Answers on the phone. Reads, and never changes the repository.";
  }
}

/**
 * What Cuesheet itself refuses for this seat, in its own voice.
 *
 * Deliberately narrow: this is the list of things that hold whatever harness
 * the Station is on, because it is this process that refuses them. Anything a
 * *particular* CLI adds on top belongs in {@link confinementNote}, attributed
 * to that CLI.
 */
export function roleRefusals(role: Role): string[] {
  if (role !== "worker") return [];
  return ["Writes are refused by the daemon — a worker never writes."];
}

/**
 * What the harness's sandbox adds, named as the harness's doing rather than
 * Cuesheet's.
 *
 * The attribution is the point. An operator reading "cannot write" needs to
 * know whether that is a promise this daemon keeps or one the vendor's CLI
 * keeps, because the answer changes what happens when they swap the harness.
 */
export function confinementNote(
  harness: string,
  role: Role,
  confinement: Confinement | undefined,
): string {
  const seat = `${article(role)} ${role}`;
  switch (confinement) {
    case "read-only":
      return `${harness} runs ${seat} read-only — the CLI itself refuses writes.`;
    case "workspace-write":
      return `${harness} confines ${seat} to the workspace; inside it, the leash decides.`;
    case "none":
      return `${harness} applies no sandbox of its own to ${seat}. The leash is the whole boundary.`;
    case undefined:
      return `${harness} does not say what it does with ${seat}. Treat the leash as the only boundary.`;
  }
}

/**
 * `an engineer`, `a reviewer`.
 *
 * A vowel check rather than a table, because `ROLES` is a list somebody will
 * add to — and "a engineer" on a screen about enforcement makes the rest of
 * the sentence easier to disbelieve.
 */
function article(role: Role): string {
  return /^[aeiou]/.test(role) ? "an" : "a";
}

/**
 * Whether *anything* in the stack refuses this Station's writes outright.
 *
 * Both halves are named because they are kept by different processes, and a
 * surface that collapses them into one badge cannot answer "who promised
 * this?" — which is the question that matters when the harness changes.
 */
export interface WritePosture {
  /** `false` only when something refuses writes outright — not merely bounds them. */
  writes: boolean;
  /** Who refuses, when somebody does: the daemon, the CLI, or both. */
  refusedBy: ("daemon" | "harness")[];
}

export function writePosture(
  station: Station,
  confinement: Confinement | undefined,
): WritePosture {
  const refusedBy: ("daemon" | "harness")[] = [];
  if (writeDeniedByRole(station) !== undefined) refusedBy.push("daemon");
  if (confinement === "read-only") refusedBy.push("harness");
  return { writes: refusedBy.length === 0, refusedBy };
}
