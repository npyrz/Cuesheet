/**
 * Writing `cuesheet.toml` back to disk.
 *
 * Step 20 of the build plan adds Stations from the UI, which means the config
 * file stops being something only a human edits. That is the moment a naive
 * implementation eats somebody's work, so two rules shape this file:
 *
 * - **Append, never round-trip.** The obvious implementation is
 *   `stringify(loaded.config)` over the whole file. It loses every comment,
 *   reorders tables, and — worse — re-emits `deferred` from parsed JS values,
 *   so a user's `[gate]` block comes back subtly different from what they
 *   wrote. Appending one `[[station]]` block to the existing *text* leaves
 *   every byte they typed exactly where it was.
 * - **Validate before replacing.** The candidate text is parsed with the same
 *   {@link parseConfig} the loader uses, and the new Station must be present
 *   in the result, before anything touches the target file. A config the
 *   daemon cannot read is a Desk that will not open.
 *
 * The write itself is temp-file-then-rename, mirroring `run.json` in the
 * daemon's store: a same-directory rename is atomic on both platforms, so a
 * crash mid-write leaves the previous config rather than half of a new one.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { stringify as stringifyToml } from "smol-toml";
import { configFile, hostEnv, pathFor, type HostEnv } from "./paths.js";
import {
  ConfigError,
  parseConfig,
  StationSchema,
  type LoadedConfig,
  type Station,
} from "./config.js";

/**
 * What a Station gets when the user does not say otherwise.
 *
 * `paths` defaults to everything and `deny` to `.git/**`, which is the pairing
 * the plan calls for. Either half alone is wrong: an empty `paths` means the
 * leash denies by default and the Station adds cleanly and then silently
 * cannot touch a single file, while an allow of `**` without the deny reaches
 * `.git/hooks/` — the leash matches with `dot: true`, and nothing else in the
 * system protects the repository's own machinery.
 */
export const DEFAULT_STATION_PATHS: readonly string[] = ["**"];
export const DEFAULT_STATION_DENY: readonly string[] = [".git/**"];

/** A Station id already in the file. Callers map this to a 409. */
export class DuplicateStationError extends Error {
  constructor(readonly stationId: string) {
    super(`A station named "${stationId}" is already configured.`);
    this.name = "DuplicateStationError";
  }
}

export interface AddStationOptions {
  env?: HostEnv;
  /**
   * The file the running config came from — `LoadedConfig.sourcePath`.
   *
   * `null` means no config exists yet and one is created at
   * `~/.cuesheet/cuesheet.toml`. Deliberately not the working directory: under
   * the desktop shell the daemon's cwd is somewhere inside the app bundle, and
   * writing a config there puts the user's Stations somewhere they will never
   * find them and an upgrade will delete.
   */
  sourcePath: string | null;
}

export interface AddStationResult {
  station: Station;
  /** Where it landed. */
  sourcePath: string;
  /** Whether the file had to be created. */
  created: boolean;
  /** The config as it now reads on disk. */
  loaded: LoadedConfig;
}

/**
 * Fill in the defaults a Station needs to actually work, then validate.
 *
 * Separate from {@link addStation} so the shape is testable without a
 * filesystem, and so a caller can show the user what will be written.
 */
export function normalizeStation(input: unknown): Station {
  const draft =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : input;

  if (draft !== null && typeof draft === "object") {
    const record = draft as Record<string, unknown>;
    if (record["paths"] === undefined) {
      record["paths"] = [...DEFAULT_STATION_PATHS];
    }
    if (record["deny"] === undefined) {
      record["deny"] = [...DEFAULT_STATION_DENY];
    }
  }

  const parsed = StationSchema.safeParse(draft);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Station is invalid: ${detail}`, null, parsed.error);
  }
  return parsed.data;
}

/**
 * Render one `[[station]]` block.
 *
 * `smol-toml`'s `stringify` is used rather than string concatenation so that
 * quoting and escaping are its problem, not ours — a workspace path on Windows
 * is full of backslashes and a hand-rolled template would emit an invalid
 * escape sequence the loader then refuses to read.
 */
export function stationBlock(station: Station): string {
  return stringifyToml({ station: [station] });
}

/**
 * Splice a Station block onto existing config text.
 *
 * Pure, so the newline handling is directly testable. A file whose last line
 * has no terminator would otherwise get `[[station]]` appended to the middle
 * of it, turning the user's last setting and our new table header into one
 * corrupt line.
 */
export function appendStationText(existing: string, station: Station): string {
  const block = stationBlock(station);
  if (existing.trim() === "") return block;
  const separator = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}\n${block}`;
}

/**
 * Add a Station to the config file and return the reloaded config.
 *
 * Serialized against other calls to this function: two adds racing would both
 * read the pre-write text and the second would silently drop the first.
 */
export async function addStation(
  input: unknown,
  options: AddStationOptions,
): Promise<AddStationResult> {
  const station = normalizeStation(input);
  const env = options.env ?? hostEnv();
  const p = pathFor(env);
  const target = options.sourcePath ?? configFile(env);

  return enqueueWrite(target, async () => {
    const existing = await readIfPresent(target);
    const created = existing === null;
    const candidate = appendStationText(existing ?? "", station);

    // Parse the candidate before it can replace anything. This catches both a
    // pre-existing problem in the user's file and anything wrong with what we
    // are about to add, and it is the same parser the daemon boots with — so
    // "it validated" and "it will load" are the same statement.
    const loaded = parseConfig(candidate, target);
    const landed = loaded.config.station.find(
      (candidate_) => candidate_.id === station.id,
    );
    if (!landed) {
      throw new ConfigError(
        `Station "${station.id}" did not survive a write-then-parse round trip; the config was left unchanged.`,
        target,
      );
    }

    await mkdir(p.dirname(target), { recursive: true });
    await writeAtomic(target, candidate);

    return { station: landed, sourcePath: target, created, loaded };
  });
}

/**
 * Whether a Station id is already taken.
 *
 * Exposed separately because the route wants to answer 409 *before* it starts
 * writing, and because `lint()` in the loader only warns about duplicates —
 * "the last one wins" is an acceptable reading of a file a human hand-edited,
 * and an unacceptable outcome for a button in a UI.
 */
export function stationIdTaken(loaded: LoadedConfig, id: string): boolean {
  const wanted = id.toLowerCase();
  return loaded.config.station.some(
    (station) => station.id.toLowerCase() === wanted,
  );
}

// ── Disk mechanics ──────────────────────────────────────────────────────────

/**
 * One write chain per target path.
 *
 * `.then(run, run)` so a failed write does not wedge every write after it —
 * the same discipline, and the same reasoning, as the run store's append
 * queue.
 */
const writeChains = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(target: string, run: () => Promise<T>): Promise<T> {
  const prior = writeChains.get(target) ?? Promise.resolve();
  const result = prior.then(run, run);
  writeChains.set(
    target,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw new ConfigError(
      `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      file,
      cause,
    );
  }
}

async function writeAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.tmp`;
  await writeFile(temp, text, "utf8");

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      // On Windows a search indexer or antivirus holding the target for a
      // moment surfaces as EPERM/EBUSY rather than a real failure.
      if (attempt >= 3 || !isTransientRename(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return codeOf(cause) === "ENOENT";
}

function isTransientRename(error: unknown): boolean {
  const code = codeOf(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return (error as { code?: string }).code;
}
