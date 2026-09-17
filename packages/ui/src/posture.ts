/**
 * A project's posture: who is on it, what each one may do, what it has spent,
 * and how close it is to a cap.
 *
 * Pure, and in a `.ts` for the reason `limits.ts`, `ledger.ts`, `launch.ts` and
 * `switcher.ts` are: vitest collects colocated `.test.ts` only and does not
 * collect `.tsx`, so a rule written in a component is a rule no test can reach.
 * That matters more here than anywhere else in the Desk, because this screen
 * makes *claims about what is enforced*, and a wrong one is worse than a blank
 * panel — somebody will seat a reviewer on the strength of it.
 *
 * ## The rule this file exists to keep
 *
 * **Never say a Station cannot do something unless somebody actually stops
 * it.** The daemon refuses a worker's writes; Codex's own sandbox runs a
 * reviewer read-only; Claude Code does neither and is bounded only by the
 * leash. Those are three different promises kept by two different processes,
 * and `StationEnforcement` on the wire carries which — so this file never
 * infers a refusal from a role. It reports the one the daemon computed, and
 * attributes it.
 *
 * Values come from `@cuesheet/core/roles` and `@cuesheet/core/ledger`, both
 * subpaths: the barrel reaches `node:fs` and a browser bundle that touches it
 * renders an empty body. Types from the barrel, values from a subpath.
 */
import {
  confinementNote,
  rolePurpose,
  roleRefusals,
} from "@cuesheet/core/roles";
import type {
  HarnessUsage,
  Ledger,
  LedgerRow,
  Limits,
  Role,
  Station,
} from "@cuesheet/core";
import type { StationView } from "./api/client.js";
import { describeWindow, type UsageTone, type WindowRow } from "./limits.js";
import type { Load } from "./surface.js";
import { money, shortPath, tokens } from "./format.js";

/**
 * One thing that is true about what a Station may do.
 *
 * `tone` is the meaning, not the colour — and the four are genuinely
 * different. `refused` is somebody stopping it; `bounded` is somebody limiting
 * where; `allowed` is a permission it really has; `unknown` is nobody having
 * said, which a surface must never round down to either of the others.
 */
export interface PermissionLine {
  text: string;
  tone: "refused" | "bounded" | "allowed" | "unknown";
  /** Which process keeps this promise, when one does. */
  keptBy?: "daemon" | "harness" | "leash";
}

export interface StationPosture {
  id: string;
  harness: string;
  model: string | null;
  role: Role;
  /** What the seat is for, from core so one sentence has one home. */
  purpose: string;
  /** Installed and logged in, or the probe's own reason. */
  available: boolean;
  availability: string;
  /** Everything it may and may not do, refusals first. */
  permissions: PermissionLine[];
  /** `null` when the Station has no workspace — it can reach nothing. */
  workspace: string | null;
  /** What this Station has spent, or `null` when it has never run. */
  spend: SpendSummary | null;
  /** Its harness's nearest cap, or `null` when that harness reported nothing. */
  cap: WindowRow | null;
}

/**
 * What a Station's spend column says when there is no figure in it.
 *
 * Three different reasons a row has no money on it, and the screen was
 * spelling all three `never run` — Step 44. Two of those are false and one of
 * them is expensively false: a ledger fetch that failed left every Station on
 * the project reading "never run", on a screen whose whole purpose is being
 * believed. The ledger is deliberately allowed to fail without taking the
 * permissions down with it (see `ProjectView`), and the price of that is
 * saying so in the column it emptied.
 */
export function spendLabel(spend: SpendSummary | null, ledger: Load): string {
  if (spend !== null) return `${spend.usd} · ${spend.tokens} · ${spend.runs}`;
  if (ledger.status === "failed") return "spend unknown";
  if (ledger.status === "loading") return "…";
  return "never run";
}

export interface SpendSummary {
  /** `$1.24`, or `—` when nothing that contributed reported a price. */
  usd: string;
  tokens: string;
  /** `1 run`, `4 runs`. A string, so the plural is decided where it is tested. */
  runs: string;
}

/**
 * The whole screen, in one pass over the three sources.
 *
 * All three are separately absent in ordinary use — the ledger is a second
 * fetch, usage is polled on its own clock and may never land for a vendor that
 * reports nothing — so every one of them is optional here rather than awaited
 * into place. A posture that renders only when everything has arrived is a
 * screen that is blank whenever any vendor is slow.
 */
export function describePosture(
  stations: readonly StationView[],
  options: {
    usage?: readonly HarnessUsage[] | null | undefined;
    limits: Limits;
    ledger?: Ledger | null | undefined;
    now?: () => number;
  },
): StationPosture[] {
  const now = options.now ?? Date.now;
  const spendByStation = new Map<string, LedgerRow>(
    (options.ledger?.byStation ?? []).map((row) => [row.key, row]),
  );

  return stations.map((view) => {
    const { station, probe } = view;
    const spend = spendByStation.get(station.id);

    return {
      id: station.id,
      harness: station.harness,
      model: station.model ?? null,
      role: station.role,
      purpose: rolePurpose(station.role),
      available: probe.installed && probe.authed,
      availability: availability(view),
      permissions: permissionsOf(view),
      workspace: station.workspace ?? null,
      spend: spend === undefined ? null : summariseSpend(spend),
      cap: nearestCap(
        station.harness,
        options.usage ?? [],
        options.limits,
        now,
      ),
    };
  });
}

/** What the probe says, in the words a tile already uses. */
function availability(view: StationView): string {
  const { probe, station } = view;
  if (!probe.installed) {
    return probe.error ?? `${station.harness} is not installed.`;
  }
  if (!probe.authed) return `Installed, but not logged in.`;
  return probe.version === undefined
    ? "Installed and logged in."
    : `Installed and logged in — ${probe.version}.`;
}

/**
 * What this Station may and may not do, with the refusals at the top.
 *
 * Order is the message: an operator scanning this wants the things that will
 * stop a run before the things that will not. Within that, the daemon's own
 * refusal comes before the harness's, because it is the one that holds when
 * the harness is swapped.
 */
function permissionsOf(view: StationView): PermissionLine[] {
  const { station, enforcement } = view;
  const blocking: PermissionLine[] = [];
  const lines: PermissionLine[] = [];

  // 1. Seat. A Station whose harness cannot play its role will fail when it is
  //    reached, and that is worth saying above anything about paths.
  if (enforcement.canPlaySeat === false) {
    blocking.push({
      text: `The ${station.harness} harness cannot play the ${station.role} seat. This Station will fail when a run reaches it.`,
      tone: "refused",
      keptBy: "daemon",
    });
  }

  // 2. A Station with nowhere to work. Blocking, and above the sandbox note,
  //     which would otherwise describe what a CLI does with a seat this
  //     Station will never reach.
  const unbounded = station.workspace === undefined || station.workspace === "";
  if (unbounded) {
    blocking.push({
      text: "No workspace, so nothing is in reach. This Station cannot run.",
      tone: "refused",
      keptBy: "leash",
    });
  }

  // 3. Writes, refused outright — by whoever is refusing them.
  for (const refusal of roleRefusals(station.role)) {
    blocking.push({ text: refusal, tone: "refused", keptBy: "daemon" });
  }
  if (enforcement.refusedBy.includes("harness")) {
    blocking.push({
      text: confinementNote(
        station.harness,
        station.role,
        enforcement.confinement,
      ),
      tone: "refused",
      keptBy: "harness",
    });
  } else {
    // Not a refusal, so it is not dressed as one — but it is still the thing
    // that decides how much the leash has to carry on its own.
    lines.push({
      text: confinementNote(
        station.harness,
        station.role,
        enforcement.confinement,
      ),
      tone: enforcement.confinement === undefined ? "unknown" : "bounded",
      keptBy: "harness",
    });
  }

  // 4. The leash: where, not whether. Written as what it *can* reach, because
  //    a list of denials with no statement of the default reads as though
  //    everything else is permitted — and the default is deny.
  // `station.workspace` is narrowed by `unbounded` above, and passed in rather
  // than re-checked: a second optional-chain inside would silently render a
  // Station with no workspace as merely having an odd-looking one.
  if (!unbounded) {
    lines.push(
      ...leashLines(station, station.workspace ?? "", enforcement.writes),
    );
  }

  // What stops this Station at all, first; then the leash's own story in the
  // order it has to be told — bounded by the workspace, may write these, and
  // never those. The `blocking` group keeps its insertion order too: the
  // daemon's refusal before the harness's, because the daemon's is the one
  // that survives swapping the harness.
  return [...blocking, ...lines];
}

/**
 * The leash, in sentences.
 *
 * `paths` absent or empty is the case worth being loud about: `checkPath`
 * defaults to deny, so such a Station can write nothing at all, and a screen
 * that rendered an empty list would read as "no restrictions" — the exact
 * inversion of what it means.
 */
function leashLines(
  station: Station,
  workspace: string,
  writes: boolean,
): PermissionLine[] {
  const lines: PermissionLine[] = [];

  lines.push({
    text: `Reaches nothing outside ${shortPath(workspace)} — the leash resolves symlinks before it compares.`,
    tone: "bounded",
    keptBy: "leash",
  });

  const allow = station.paths ?? [];
  if (!writes) {
    // A read-only seat still has a leash, but saying "may write src/**" about a
    // Station whose writes are refused would be the screen contradicting
    // itself two lines apart.
    lines.push({
      text:
        allow.length === 0
          ? "No allowed paths are configured. Reads are bounded by the workspace; writes are refused before paths are consulted."
          : `Allowed paths (${allow.join(", ")}) apply to reads. Its writes are refused before they are consulted.`,
      tone: "bounded",
      keptBy: "leash",
    });
  } else if (allow.length === 0) {
    lines.push({
      text: "No allowed paths are configured, and the leash defaults to deny — so this Station can write nothing.",
      tone: "refused",
      keptBy: "leash",
    });
  } else {
    lines.push({
      text: `May write ${allow.join(", ")}, and nothing else.`,
      tone: "allowed",
      keptBy: "leash",
    });
  }

  const deny = station.deny ?? [];
  if (deny.length > 0) {
    lines.push({
      text: `Denied ${deny.join(", ")}. A deny rule beats an allow rule every time.`,
      tone: "refused",
      keptBy: "leash",
    });
  }

  return lines;
}

function summariseSpend(row: LedgerRow): SpendSummary {
  return {
    // `money` says `local` when nothing reported a price, which is right on a
    // tile and wrong here: a Station can have unpriced runs without being
    // local. The dash is the same answer the limits strip gives for a number
    // nobody reported.
    usd:
      row.usd === undefined
        ? "—"
        : money({ tokensIn: 0, tokensOut: 0, usd: row.usd }),
    tokens: tokens(row.tokensIn + row.tokensOut),
    runs: `${String(row.runs)} run${row.runs === 1 ? "" : "s"}`,
  };
}

/**
 * The window this Station is nearest to running out of.
 *
 * Per harness rather than per vendor, which is the opposite of the strip's
 * grouping and deliberately so: the strip answers "can I work right now", and
 * this answers "what stops *this* Station". A Station does not run on a
 * vendor, it runs on a harness, and it is the harness that was asked.
 *
 * "Nearest" prefers a measured window over a reported status, because a
 * fraction is the only thing that can be compared. A harness with nothing but
 * statuses shows the first one it reported rather than nothing at all.
 */
function nearestCap(
  harness: string,
  usage: readonly HarnessUsage[],
  limits: Limits,
  now: () => number,
): WindowRow | null {
  const entry = usage.find((candidate) => candidate.harness === harness);
  if (entry === undefined || entry.windows.length === 0) return null;

  const rows = entry.windows.map((window) =>
    describeWindow(window, limits, now),
  );
  let nearest: WindowRow | null = null;
  for (const row of rows) {
    if (nearest === null) {
      nearest = row;
      continue;
    }
    if (row.bar !== null && (nearest.bar === null || row.bar > nearest.bar)) {
      nearest = row;
    }
  }
  return nearest;
}

/** Whether a cap row is the kind that should be shown as a warning. */
export function capIsPressing(tone: UsageTone): boolean {
  return tone === "warn" || tone === "over";
}
