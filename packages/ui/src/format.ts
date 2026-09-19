/**
 * Display helpers. Pure, so they are testable without a DOM.
 *
 * Small, but two of these are places the UI can lie: a cost of `$0.00` for a
 * local model that costs nothing is a different statement from no cost at
 * all, and a `⌘` shown on Windows is simply wrong.
 */
import type { Cost, RunStatus } from "@cuesheet/core";

/**
 * Ended without the harness getting to report a settled price. `held` is not
 * here: a Hold is a decision at the end of a run that ran, so its cost is as
 * final as a `done` run's.
 */
const ENDED_EARLY: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "stopped",
  "interrupted",
  "failed",
]);

/** `4m12s`, matching the README's tile. */
export function elapsed(fromIso: string, toIso?: string): string {
  const from = Date.parse(fromIso);
  const to = toIso === undefined ? Date.now() : Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "—";
  return duration(Math.max(0, to - from));
}

export function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * `$0.84`, `local`, or `—`.
 *
 * Three cases, and collapsing any two of them tells a lie:
 *
 * - **A price** is a measurement. Render it.
 * - **Tokens but no price** is an ollama Station: it really did work and it
 *   really did cost nothing. `$0.00` would make an unknown look measured, so
 *   this says `local`.
 * - **Nothing reported yet** is a run that started two seconds ago. Saying
 *   `local` there labels a cloud model as free until its first usage event
 *   lands — which is exactly backwards, and visible on every tile for the
 *   first seconds of every run.
 *
 * `status` is what separates the second case from a fourth one that looks
 * identical on the record and is its opposite. The settled price arrives once,
 * at the end, so a run killed before that end has tokens and no `usd` exactly
 * like an ollama run does — and a stopped `claude-code` run rendered `local`,
 * calling a run that spent real money free. Absent a normal ending, the price
 * is unknown rather than nothing, and `—` is the thing that says so.
 */
export function money(cost: Cost | undefined, status?: RunStatus): string {
  if (!cost) return "—";
  if (cost.usd === undefined) {
    if (status !== undefined && ENDED_EARLY.has(status)) return "—";
    return cost.tokensIn + cost.tokensOut > 0 ? "local" : "—";
  }
  if (cost.usd === 0) return "$0.00";
  if (cost.usd < 0.01) return "<$0.01";
  return `$${cost.usd.toFixed(2)}`;
}

/** `12.3k` — tile space is tight and exact token counts are not the point. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Just the tail of a path, which is what fits on a tile. */
export function shortPath(path: string, segments = 2): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= segments) return parts.join("/");
  return `…/${parts.slice(-segments).join("/")}`;
}

/** One character per status — the tile's dot. */
export function statusDot(status: RunStatus | "idle" | "working"): string {
  switch (status) {
    case "running":
    case "working":
      return "●";
    case "standby":
    case "held":
      return "✋";
    case "done":
      return "✓";
    case "failed":
      return "✕";
    case "stopped":
    case "interrupted":
      return "◼";
    default:
      return "○";
  }
}

export function isMac(platform: string | undefined): boolean {
  if (platform === undefined) return false;
  return /^darwin$/i.test(platform) || /mac/i.test(platform);
}

/**
 * A shortcut, spelled the way this platform spells shortcuts.
 *
 * The cross-platform checklist puts `⌘` vs `Ctrl` in Step 24's Windows pass.
 * Phase 4 settled it early anyway, because branching on the platform is one
 * line now and a scavenger hunt through finished components later.
 *
 * Step 44 re-opened the row and replaced what Phase 4 wrote, which was a
 * `modifierKey()` returning `⌘` or `Ctrl`. It was correct and the thing built
 * out of it was not: every call site wrote `{modifierKey()}K`, which is `⌘K`
 * on a Mac — right, because macOS sets its shortcuts solid — and `CtrlK`
 * everywhere else, which is not a shortcut anybody writes. Windows and Linux
 * join with a `+`.
 *
 * So this returns the whole shortcut rather than the modifier, because a
 * convention is what produced `CtrlK` in two files independently. It takes the
 * key's display name, so `Esc` and `Enter` read as themselves.
 */
export function shortcutHint(
  key: string,
  platform: string | undefined = detectPlatform(),
): string {
  return isMac(platform) ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * What this machine calls itself.
 *
 * The shell's `process.platform` first: the preload has exposed it since Step
 * 21 for exactly this, and it is the only answer here that is not an
 * inference. `navigator.platform` is deprecated and under Electron describes
 * the Chromium build rather than the OS, so it stays as the browser fallback
 * — a browser has no bridge to ask.
 *
 * Read off `globalThis` rather than by importing the bridge: this module is
 * pure and node tests import it with no DOM, and a display helper that drags
 * the daemon's URL module in behind it stops being cheap.
 */
function detectPlatform(): string | undefined {
  const shell = (globalThis as { cuesheet?: { platform?: string } }).cuesheet
    ?.platform;
  if (shell !== undefined && shell !== "") return shell;
  if (typeof navigator === "undefined") return undefined;
  return navigator.platform || navigator.userAgent;
}

/** Whether a keyboard event is the command-palette chord on this platform. */
export function isPaletteChord(
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
  platform: string | undefined = detectPlatform(),
): boolean {
  if (event.key.toLowerCase() !== "k") return false;
  return isMac(platform) ? event.metaKey : event.ctrlKey;
}
