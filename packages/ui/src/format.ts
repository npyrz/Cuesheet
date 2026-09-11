/**
 * Display helpers. Pure, so they are testable without a DOM.
 *
 * Small, but two of these are places the UI can lie: a cost of `$0.00` for a
 * local model that costs nothing is a different statement from no cost at
 * all, and a `⌘` shown on Windows is simply wrong.
 */
import type { Cost, RunStatus } from "@cuesheet/core";

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
 */
export function money(cost: Cost | undefined): string {
  if (!cost) return "—";
  if (cost.usd === undefined) {
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

/**
 * The modifier key, spelled the way this machine spells it.
 *
 * The cross-platform checklist puts `⌘` vs `Ctrl` in Step 24's Windows pass,
 * but the palette hint is the only place it appears in Phase 4 and branching
 * on the platform is one line today. Left until packaging, it becomes a
 * scavenger hunt through finished components.
 *
 * `navigator.platform` is deprecated but is the only signal available in both
 * a browser and an Electron renderer without a preload round trip; the
 * bridge's `platform` is preferred when it is there.
 */
export function modifierKey(
  platform: string | undefined = detectPlatform(),
): string {
  return isMac(platform) ? "⌘" : "Ctrl";
}

export function isMac(platform: string | undefined): boolean {
  if (platform === undefined) return false;
  return /^darwin$/i.test(platform) || /mac/i.test(platform);
}

function detectPlatform(): string | undefined {
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
