/**
 * What the limits strip draws, decided here rather than in the component.
 *
 * Pure, and in a `.ts` rather than the `.tsx` beside it, for a reason that is
 * about this repo specifically: vitest collects colocated `.test.ts` files
 * only and **does not collect `.tsx`**. A decision living in a component is a
 * decision no test in this project can reach — so the component maps over
 * these and holds no rules of its own.
 *
 * The rule the whole file exists to enforce: **`bar` is `null` unless somebody
 * measured something.** `UsageWindow` is a union precisely so three of its
 * four variants have no `used` field, and this is the layer where that
 * guarantee would otherwise be quietly thrown away by a `?? 0` written to make
 * a progress element happy. A bar drawn at 0% for a plan that has not reported
 * a fraction is the authoritative-looking lie the whole phase is about.
 */
// Values from the subpath, types from the barrel. A value import from
// `@cuesheet/core` drags `node:fs` into the browser bundle — see the note in
// `ledger.ts`, which is where that was found the hard way.
import { measuredFraction, percent } from "@cuesheet/core/limits";
import type { HarnessUsage, Limits, UsageWindow } from "@cuesheet/core";

/** How a row reads. Colour is the component's business; this is the meaning. */
export type UsageTone = "ok" | "warn" | "over" | "free" | "silent";

export interface WindowRow {
  /** `five_hour`, `weekly`, `local`. Whatever the vendor called it. */
  window: string;
  /** `0`–`1`, or `null` when nothing was measured. Never a stand-in zero. */
  bar: number | null;
  /** `71%`, `∞`, or `—`. What goes where a number would. */
  value: string;
  tone: UsageTone;
  /** The honest sentence under the row. Always present; never reassuring. */
  note: string;
}

export interface VendorRow {
  vendor: string;
  /** Every harness of this vendor, so a row can say who reported it. */
  harnesses: string[];
  windows: WindowRow[];
}

/**
 * Group by vendor, because a plan belongs to one.
 *
 * Two Stations on `claude-code` share a single five-hour window; drawing it
 * once per harness would read as twice the budget. `GET /usage` answers per
 * harness because that is who it asked, and this is where that becomes what
 * an operator actually has.
 */
export function describeUsage(
  usage: readonly HarnessUsage[],
  limits: Limits,
  now: () => number = Date.now,
): VendorRow[] {
  const byVendor = new Map<string, VendorRow>();

  for (const entry of usage) {
    const row = byVendor.get(entry.vendor) ?? {
      vendor: entry.vendor,
      harnesses: [],
      windows: [],
    };
    row.harnesses.push(entry.harness);
    for (const window of entry.windows) {
      row.windows.push(describeWindow(window, limits, now));
    }
    byVendor.set(entry.vendor, row);
  }

  // Vendors with something measured first: the strip is glanced at, and the
  // row that can stop you working has to be the one nearest the top.
  return [...byVendor.values()].sort(
    (a, b) => worst(b.windows) - worst(a.windows),
  );
}

export function describeWindow(
  window: UsageWindow,
  limits: Limits,
  now: () => number = Date.now,
): WindowRow {
  // Switched on `state` rather than on "did `measuredFraction` return a
  // number", so the compiler checks this is total. An early return for the
  // measured case reads more naturally and narrows nothing — `window.reason`
  // in the last branch then fails to typecheck, which is the union doing its
  // job and is worth keeping.
  switch (window.state) {
    case "measured": {
      const used = measuredFraction(window) ?? 0;
      const over = used >= limits.block_at;
      const near = used >= limits.warn_at;
      return {
        window: window.window,
        bar: used,
        value: percent(used),
        tone: over ? "over" : near ? "warn" : "ok",
        note: join([
          over
            ? "At the cap — new runs are refused."
            : near
              ? "Close to the cap."
              : "",
          resetNote(window, now),
          freshness(window, now),
        ]),
      };
    }

    case "not-blocked":
      return {
        window: window.window,
        bar: null,
        value: "—",
        tone: "silent",
        // The sentence this whole phase turns on. The vendor reported a
        // status, not a fraction, and "not blocked yet" is not "0% used".
        note: join([
          "Not blocked yet — this vendor reports a status, not a number.",
          resetNote(window, now),
          freshness(window, now),
        ]),
      };

    case "unmetered":
      return {
        window: window.window,
        bar: null,
        value: "∞",
        tone: "free",
        note: "No cap. This one cannot run out.",
      };

    case "unknown":
      return {
        window: window.window,
        bar: null,
        value: "—",
        tone: "silent",
        note: window.reason ?? "Nothing reported.",
      };
  }
}

function join(parts: readonly string[]): string {
  return parts.filter(Boolean).join(" ");
}

/** `resets in 1h 48m`, or nothing when the vendor did not say. */
function resetNote(window: UsageWindow, now: () => number): string {
  const resetsAt = "resetsAt" in window ? window.resetsAt : undefined;
  if (resetsAt === undefined) return "";
  const remaining = Date.parse(resetsAt) - now();
  if (!Number.isFinite(remaining)) return "";
  if (remaining <= 0) return "Resets any moment.";
  return `Resets in ${humanize(remaining)}.`;
}

/**
 * How old the reading is — and it is never omitted once it stops being new.
 *
 * `claude-code` can only report what a run overheard, so every number it gives
 * is historical. A strip that renders a five-hour window from this morning
 * without saying when it was taken is the exact screen this phase exists to
 * avoid, and it is worse than a blank row because it looks current.
 */
function freshness(window: UsageWindow, now: () => number): string {
  const seenAt = "seenAt" in window ? window.seenAt : undefined;
  if (seenAt === undefined) return "";
  const age = now() - Date.parse(seenAt);
  if (!Number.isFinite(age)) return "";
  if (age < 60_000) return "";
  return `Last seen ${humanize(age)} ago.`;
}

function humanize(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(rest)}m`;
}

/** The highest measured fraction in a set of rows, or `-1` when none measured. */
function worst(windows: readonly WindowRow[]): number {
  let highest = -1;
  for (const window of windows) {
    if (window.bar !== null && window.bar > highest) highest = window.bar;
  }
  return highest;
}
