/**
 * What the ledger table shows, decided here rather than in the component.
 *
 * Same split as `limits.ts`, for the same reason: vitest collects colocated
 * `.test.ts` files only and does not collect `.tsx`, so a rule that lives in a
 * component is a rule no test in this project can reach.
 *
 * The rule worth guarding: **a cache hit rate is `null`, never `0%`, when
 * nobody reported one.** `codex` reports a read and no write, a local model
 * reports neither, and a run from before Step 39 reports nothing at all. A
 * column of confident zeroes across those would be the same lie the limits
 * strip refuses to tell, in a place where it would change what someone
 * optimises.
 */
import { cacheHitRate, type Ledger, type LedgerTotals } from "@cuesheet/core";

export interface LedgerCell {
  label: string;
  tokensIn: string;
  tokensOut: string;
  /** `71%`, or `—` when no contributor reported a breakdown. */
  cache: string;
  /** `$0.56`, or `—` when nothing that contributed carried a price. */
  usd: string;
  runs: number;
}

export function toCell(label: string, totals: LedgerTotals): LedgerCell {
  const hit = cacheHitRate(totals);
  return {
    label,
    tokensIn: compact(totals.tokensIn),
    tokensOut: compact(totals.tokensOut),
    cache: hit === null ? "—" : `${String(Math.round(hit * 100))}%`,
    usd: totals.usd === undefined ? "—" : `$${totals.usd.toFixed(2)}`,
    runs: totals.runs,
  };
}

/**
 * The sentence under the table when some spend could not be attributed.
 *
 * Returned rather than rendered, and `null` when there is nothing to say. It
 * exists because `byStation` would otherwise not add up to `totals`, and a
 * reader who noticed that discrepancy without an explanation would be right to
 * distrust every other number on the page.
 */
export function unattributedNote(ledger: Ledger): string | null {
  const { tokensIn, tokensOut } = ledger.unattributed;
  if (tokensIn === 0 && tokensOut === 0) return null;
  const older = ledger.runs.filter((run) => !run.attributed).length;
  const spend = `${compact(tokensIn)} in / ${compact(tokensOut)} out`;
  return older > 0
    ? `${spend} is not split by Station: ${String(older)} run${older === 1 ? "" : "s"} predate per-Station accounting.`
    : `${spend} is not split by Station — a harness reported a settled total that differs from its metered stream.`;
}

/** `1.2k`, `50.3k`, `1.4M`. Tables get unreadable past four digits. */
export function compact(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
