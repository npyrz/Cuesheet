/**
 * What your context already costs — Step 62.
 *
 * Every always-loaded file is paid for by every Station that loads it, on
 * every run, for as long as it stays that size. Nothing in any vendor's tool
 * says so: a 40k-token `CLAUDE.md` looks like a file, not like a bill. This
 * turns the file into the bill.
 *
 * Pure arithmetic, in `core` for the same reason `ledger.ts` is: the daemon
 * reads the files and the ledger, and what they add up to is testable without
 * a disk. The daemon hands over **sizes, not text** — this module never needs
 * to see what somebody wrote in their context file to say what it costs.
 *
 * ## The numbers are estimates, and say so
 *
 * Tokens are {@link estimateTokens}' four bytes a token; dollars are those
 * tokens at the price this project has actually been paying per input token,
 * read back out of its own ledger. Neither is a vendor's figure. Both are good
 * for "this file is a fifth of every run" and for nothing finer, and every
 * surface that prints them says "estimated".
 */
import { BYTES_PER_TOKEN } from "./brief.js";
import type { Ledger } from "./ledger.js";

/**
 * One thing a Station loads before it reads its prompt.
 *
 * Almost always a file a harness declared in `contextFiles`. The exception is
 * `kind: "brief"`: a harness that declares no context file — `ollama` — has
 * the Commons assembled into its brief by the daemon instead, and those bytes
 * are always-loaded context too. Leaving them out would make the one Station
 * that cannot cache anything look like the cheapest.
 */
export interface ContextSource {
  /** `project:CLAUDE.md`, `user:.claude/CLAUDE.md`, or `brief:commons`. */
  id: string;
  kind: "file" | "brief";
  scope: "project" | "user";
  /** Relative to the scope root for a file; a label for the brief. */
  path: string;
  /** False for a declared file nobody has written yet — it costs nothing. */
  exists: boolean;
  bytes: number;
  /**
   * Of `bytes`, how many sit inside Cuesheet's own generated block.
   *
   * Split out because the two halves have different owners and different
   * remedies: a hand-written section is the operator's to trim, while the
   * generated one grows with approved facts and the repo map, and is trimmed
   * from the Commons inbox or `[repo_map]`. An audit that cannot say which
   * half grew cannot say who should act.
   */
  generatedBytes: number;
}

export interface ContextStationInput {
  id: string;
  harness: string;
  /**
   * Source ids this Station loads, or `null` when this build does not know
   * the harness — which is "we cannot say", not "it loads nothing".
   */
  loads: readonly string[] | null;
  /** From the harness, for pricing against the ledger's per-vendor rows. */
  vendor?: string;
}

export interface ContextAuditFile extends ContextSource {
  estimatedTokens: number;
  generatedTokens: number;
  /** Station ids that load this, in config order. */
  loadedBy: string[];
  /** `estimatedTokens × loadedBy.length` — this file's share of one run. */
  perRunTokens: number;
}

export interface ContextAuditStation {
  stationId: string;
  harness: string;
  vendor?: string;
  /** False when this build does not know the harness; see `loads`. */
  known: boolean;
  /** Source ids, in the order the audit lists files. */
  files: string[];
  estimatedTokens: number;
  /** Runs in the ledger this Station took part in. */
  runs: number;
  /** Absent when the ledger has no price for this Station's vendor. */
  usdPerRun?: number;
}

/** Dollars per input token this project has actually paid, by vendor. */
export interface ContextRate {
  vendor: string;
  usdPerInputToken: number;
}

export interface ContextAudit {
  /**
   * The answer the step exists for: what one run of every Station on this
   * project pays for context before anybody types a prompt.
   *
   * A run of a cuesheet that seats fewer Stations pays less; this is the
   * whole crew's figure, which is the one that grows when a file does.
   */
  perRun: {
    estimatedTokens: number;
    /** Absent when no Station could be priced. */
    usd?: number;
    /** Stations whose context could not be priced, so `usd` omits them. */
    unpriced: string[];
  };
  /**
   * The same context over the runs already in the ledger, **at today's
   * size**. It is not what those runs paid — the files were different sizes
   * then and nobody recorded them — but it is what they would have paid, and
   * it is the figure that makes a habit visible.
   */
  history: {
    runs: number;
    estimatedTokens: number;
    usd?: number;
  };
  /** Most expensive per run first; existing files before missing ones. */
  files: ContextAuditFile[];
  /** Config order. */
  stations: ContextAuditStation[];
  rates: ContextRate[];
}

export interface ContextAuditInput {
  sources: readonly ContextSource[];
  stations: readonly ContextStationInput[];
  /** The project's ledger; absent or empty means nothing can be priced. */
  ledger?: Ledger;
}

export function buildContextAudit(input: ContextAuditInput): ContextAudit {
  const rates = observedRates(input.ledger);
  const rateFor = new Map(
    rates.map((rate) => [rate.vendor, rate.usdPerInputToken]),
  );
  const runsFor = new Map(
    (input.ledger?.byStation ?? []).map((row) => [row.key, row.runs]),
  );
  const sources = new Map(input.sources.map((source) => [source.id, source]));

  const loadedBy = new Map<string, string[]>();
  const stations: ContextAuditStation[] = input.stations.map((station) => {
    // A Station that names a source the daemon did not read is dropped from
    // that source rather than counted at zero: the sources list is the
    // daemon's to build, and a mismatch is its bug, not a free file.
    const files = (station.loads ?? []).filter((id) => sources.has(id));
    for (const id of files) {
      const list = loadedBy.get(id) ?? [];
      list.push(station.id);
      loadedBy.set(id, list);
    }
    const estimatedTokens = files.reduce(
      (sum, id) => sum + tokens(sources.get(id)?.bytes ?? 0),
      0,
    );
    const rate =
      station.vendor === undefined ? undefined : rateFor.get(station.vendor);
    return {
      stationId: station.id,
      harness: station.harness,
      ...(station.vendor !== undefined && { vendor: station.vendor }),
      known: station.loads !== null,
      files,
      estimatedTokens,
      runs: runsFor.get(station.id) ?? 0,
      ...(rate !== undefined && { usdPerRun: estimatedTokens * rate }),
    };
  });

  const files: ContextAuditFile[] = input.sources
    .map((source) => {
      const by = loadedBy.get(source.id) ?? [];
      const estimatedTokens = tokens(source.bytes);
      return {
        ...source,
        estimatedTokens,
        generatedTokens: tokens(source.generatedBytes),
        loadedBy: by,
        perRunTokens: estimatedTokens * by.length,
      };
    })
    .sort(
      (a, b) =>
        b.perRunTokens - a.perRunTokens ||
        Number(b.exists) - Number(a.exists) ||
        // Code-unit order, never `localeCompare` — the CLI prints this list
        // and a diff of two audits should move only when a number does.
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const order = new Map(files.map((file, index) => [file.id, index]));
  for (const station of stations) {
    station.files.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  const perRunTokens = sum(stations.map((station) => station.estimatedTokens));
  const priced = stations.filter((station) => station.usdPerRun !== undefined);
  // A Station with no context costs nothing and needs no price: leaving it in
  // `unpriced` would tell somebody their total is missing a term that is zero.
  const unpriced = stations
    .filter(
      (station) =>
        station.usdPerRun === undefined && station.estimatedTokens > 0,
    )
    .map((station) => station.stationId);

  const history = {
    runs: input.ledger?.totals.runs ?? 0,
    estimatedTokens: sum(
      stations.map((station) => station.estimatedTokens * station.runs),
    ),
  };
  const historyUsd = sum(
    priced.map((station) => (station.usdPerRun ?? 0) * station.runs),
  );

  return {
    perRun: {
      estimatedTokens: perRunTokens,
      ...(priced.length > 0 && {
        usd: sum(priced.map((station) => station.usdPerRun ?? 0)),
      }),
      unpriced,
    },
    history: {
      ...history,
      ...(priced.some((station) => station.runs > 0) && { usd: historyUsd }),
    },
    files,
    stations,
    rates,
  };
}

/**
 * Dollars per input token, by vendor, from what this project has paid.
 *
 * `usd / tokensIn` over each vendor's ledger row. Two biases, in opposite
 * directions, and stated rather than corrected because correcting either one
 * needs a price list Cuesheet does not keep:
 *
 * - **It overstates**, because a run's `usd` pays for output tokens too, and
 *   those cost several times an input token.
 * - **It is cache-weighted**, because `tokensIn` includes cache reads billed
 *   at a fraction of the fresh price. That is the *right* weighting for
 *   always-loaded context, which is exactly the part a warm cache serves —
 *   and it is why the figure is read from this project rather than a table.
 *
 * A vendor with no priced spend — `ollama` at `usd: 0` has a price, zero; a
 * runtime that reports none has no row — is simply absent.
 */
export function observedRates(ledger: Ledger | undefined): ContextRate[] {
  if (ledger === undefined) return [];
  return ledger.byVendor
    .filter((row) => row.usd !== undefined && row.tokensIn > 0)
    .map((row) => ({
      vendor: row.key,
      usdPerInputToken: (row.usd ?? 0) / row.tokensIn,
    }))
    .sort((a, b) => (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0));
}

/**
 * Per source, not per byte total: rounding up once per file is what
 * `estimateTokens` does to a whole text, and summing those is how a person
 * adding up the rows would get the same total the audit printed.
 */
function tokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
