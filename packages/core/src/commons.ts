/**
 * The Commons — one fact, as a file.
 *
 * The README's promise is the design constraint: *"It is plain markdown in a
 * repo you own — you can read it, grep it, diff it, and leave."* A database
 * would make that a lie, so a fact is a markdown file with frontmatter and the
 * store is a git repository. This file owns the *format* and the *rules*; the
 * disk and the git calls live in the daemon, which is where subprocesses are
 * allowed to happen.
 *
 * ## Why TOML frontmatter, delimited by `+++`
 *
 * The convention is YAML between `---` fences, and this is deliberately not
 * that. The README says "markdown with frontmatter" and never names a dialect,
 * `smol-toml` is already a dependency of this package — it parses every
 * `cuesheet.toml` — and it exports `stringify` as well as `parse`. Adding a
 * YAML parser to write a format core already reads and writes would be a new
 * dependency bought with nothing. `+++` is Hugo's TOML fence, so the choice is
 * at least a convention somebody else already made.
 *
 * The operator's side of the bargain still holds: it is text, it diffs, and
 * every key in it is one they could have typed.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/**
 * Where a fact came from. Every entry carries it, and the README says why:
 * *"Provenance is attached to every entry: which Station, which Run, when."*
 *
 * All three are optional because a fact typed by a human has no Station and no
 * Run, and inventing one would make the store's most useful filter — *what did
 * an agent write while I was not looking* — impossible to trust.
 */
export interface FactProvenance {
  /** The Station that wrote it, when an agent did. */
  station?: string;
  /** The Run it was written during. */
  run?: string;
  /** ISO 8601, UTC. When it was written. */
  at: string;
}

export interface Fact {
  /** Filename without `.md`. Also a URL segment — see {@link isFactId}. */
  id: string;
  /** One line. What the fact is about, for a projection's heading. */
  title: string;
  /** Free-form labels. The projection groups on these later. */
  tags: string[];
  /**
   * Which projects this fact belongs to. Empty means every project.
   *
   * Step 47 projects on this. It is stored here rather than derived, because
   * "true everywhere" and "true of the one project open when it was written"
   * are different claims and only the writer knows which was meant.
   */
  projects: string[];
  provenance: FactProvenance;
  /** The markdown body, below the frontmatter. */
  body: string;
}

/**
 * A fact id is a filename **and** a URL segment.
 *
 * Same discipline as `RUN_ID_PATTERN` in the daemon, and for the same reason
 * stated there: anything that reaches the filesystem is matched against this
 * first, so `DELETE /commons/..%2f..%2fprojects.json` is a 400 rather than a
 * deleted project registry. Lowercase, digits and single hyphens only — which
 * also rules out a Windows drive letter, a leading dot, and a name that
 * differs from another only by case on a case-insensitive filesystem.
 */
export const FACT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Long enough to be a sentence fragment, short enough for `MAX_PATH`. */
export const FACT_ID_MAX = 80;

export function isFactId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= FACT_ID_MAX &&
    FACT_ID_PATTERN.test(value)
  );
}

/**
 * A title to an id. Lossy on purpose: the id is a filename people will see in
 * `git log`, not a key that has to round-trip.
 *
 * Returns `null` when nothing survives — a title of only punctuation, or of a
 * script this transliterates nothing of. The caller asks for an explicit id in
 * that case rather than being handed `untitled-4` and a collision later.
 */
export function slugify(title: string): string | null {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks, so `café` becomes `cafe` rather than `caf`.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FACT_ID_MAX)
    .replace(/-+$/, "");
  return isFactId(slug) ? slug : null;
}

// ── The file format ─────────────────────────────────────────────────────────

const FENCE = "+++";

/**
 * A fact as the bytes that land on disk.
 *
 * Always ends in exactly one newline, and the body is trimmed before it is
 * written. Step 47 requires that re-running a projection twice produces no
 * diff, and that promise starts here: a store whose files gain a blank line
 * each time they are rewritten makes every downstream comparison noisy.
 */
export function serializeFact(fact: Fact): string {
  const frontmatter = stringifyToml({
    title: fact.title,
    tags: fact.tags,
    projects: fact.projects,
    // Nested under its own table so the top level stays the fact and the
    // provenance stays plainly machine-written. An operator editing a file by
    // hand should be able to see which half is theirs.
    provenance: {
      ...(fact.provenance.station !== undefined && {
        station: fact.provenance.station,
      }),
      ...(fact.provenance.run !== undefined && { run: fact.provenance.run }),
      at: fact.provenance.at,
    },
  });
  return `${FENCE}\n${frontmatter}\n${FENCE}\n\n${fact.body.trim()}\n`;
}

export class FactFormatError extends Error {
  constructor(
    message: string,
    readonly id: string,
  ) {
    super(message);
    this.name = "FactFormatError";
  }
}

/**
 * Bytes back to a fact.
 *
 * Throws rather than returning a partial one. A fact that cannot be parsed is
 * a file the operator hand-edited into something else, and the honest response
 * is to name it — Step 48's inbox and Step 47's projection both need to skip
 * it loudly rather than project half of it.
 */
export function parseFact(id: string, text: string): Fact {
  if (!isFactId(id)) {
    throw new FactFormatError(`"${id}" is not a usable fact id.`, id);
  }

  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) {
    throw new FactFormatError(
      `${id}.md does not open with a ${FENCE} frontmatter fence.`,
      id,
    );
  }
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) {
    throw new FactFormatError(
      `${id}.md opens a ${FENCE} fence and never closes it.`,
      id,
    );
  }

  const head = normalized.slice(FENCE.length + 1, end);
  const body = normalized.slice(end + FENCE.length + 2).trim();

  let table: unknown;
  try {
    table = parseToml(head);
  } catch (cause) {
    throw new FactFormatError(
      `${id}.md has frontmatter that is not valid TOML: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      id,
    );
  }

  const record = asRecord(table);
  if (!record) {
    throw new FactFormatError(`${id}.md has no frontmatter table.`, id);
  }

  const provenance = asRecord(record["provenance"]) ?? {};
  const at = provenance["at"];

  return {
    id,
    title: typeof record["title"] === "string" ? record["title"] : id,
    tags: stringsAt(record["tags"]),
    projects: stringsAt(record["projects"]),
    provenance: {
      ...(typeof provenance["station"] === "string" && {
        station: provenance["station"],
      }),
      ...(typeof provenance["run"] === "string" && { run: provenance["run"] }),
      // A file with no timestamp is readable rather than fatal: the operator
      // may have written it by hand, and refusing to read what somebody typed
      // into their own repository would be the opposite of the promise.
      at: typeof at === "string" ? at : (asDate(at) ?? ""),
    },
    body,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringsAt(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** `smol-toml` hands back a `TomlDate` for an unquoted datetime. */
function asDate(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
