/**
 * `cuesheet.toml` — schema, validation, and loading.
 *
 * These schemas are authoritative for the config-shaped domain types
 * (`Station`, `Cue`, `Cuesheet`); see the note in `types.ts` for why they are
 * inferred rather than hand-written.
 *
 * The README ships a full config example covering Gates, the Caller, limits,
 * On-Call, the Commons, and remote devices. Some remain deferred. They are
 * still *parsed* — collected, warned about, and carried through untouched —
 * so the README's example loads on day one and a user who writes ahead of us
 * does not lose their file the first time we round-trip it.
 */
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  CONFIG_FILENAME,
  configDir,
  hostEnv,
  pathFor,
  type HostEnv,
  projectConfigFile,
} from "./paths.js";
import { ROLES } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

/** `id` becomes a directory name and a URL segment; keep it boring. */
const Identifier = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "must start alphanumeric and contain only letters, digits, dot, dash, underscore",
  );

export const DeskSchema = z.object({
  name: z.string().min(1).optional(),
});

export const StationSchema = z.object({
  id: Identifier,
  harness: z.string().min(1),
  role: z.enum(ROLES),
  model: z.string().min(1).optional(),
  /** May be `~/code/api`; expanded at use, not at parse. See `expandHome`. */
  workspace: z.string().min(1).optional(),
  /** Allow globs. Absent means "nothing" — the leash defaults to deny. */
  paths: z.array(z.string()).optional(),
  /** Deny globs. Always beat `paths`. */
  deny: z.array(z.string()).optional(),
});

/**
 * One step: a Station and an action.
 *
 * `.loose()` on purpose — the README's On-Call cuesheet carries
 * `require_failing_test = true` on a cue, and cue options are exactly the kind
 * of thing that grows per-action. Dropping unknown keys here would silently
 * discard the user's intent.
 */
export const CueSchema = z
  .object({
    station: Identifier,
    action: z.string().min(1),
    mode: z.string().min(1).optional(),
  })
  .loose();

/** `{ gate = "default" }` — a gate is a cue kind, not a separate list. */
export const GateRefSchema = z.object({
  gate: Identifier,
});

export const CueStepSchema = z.union([GateRefSchema, CueSchema]);

export const CuesheetSchema = z.object({
  cues: z.array(CueStepSchema).min(1),
});

/**
 * `[gate.default]` — the second-opinion rule.
 *
 * `require` is the README's `"N-of-M"`: N reviewers must pass, out of M asked.
 * It is a string rather than two numbers because that is what the README
 * writes and the words are the spec.
 *
 * `distinct_vendors` counts the vendors of the Stations that **acted** in the
 * run — the author and the reviewers — not the authors of the verdicts. That
 * is the only reading under which the README's own example is satisfiable:
 * `require = "1-of-1"` with `distinct_vendors = 2` has a single reviewer, so
 * the second vendor can only be the engineer whose work is being reviewed.
 * It is also the reading that matches the point: a model reviewing its own
 * work shares its own blind spots.
 */
export const GateSchema = z
  .object({
    require: z
      .string()
      .regex(/^\d+-of-\d+$/, 'Use the form "1-of-1" or "2-of-3".')
      .default("1-of-1"),
    distinct_vendors: z.number().int().min(1).default(1),
    /** Finding categories that block. Anything else is advisory. */
    blocking: z.array(z.string().min(1)).default([]),
    /** Don't burn tokens reviewing a typo. Counted in changed lines. */
    skip_if_diff_under: z.number().int().min(0).optional(),
    /** Parsed and kept for M7's hotfix gate; nothing reads it yet. */
    merges: z.boolean().optional(),
  })
  .loose();

/**
 * `[limits]` — where the pre-run check gets its thresholds.
 *
 * The defaults are the README's own numbers, and they are defaults rather than
 * required fields because the table is the *tuning*, not the feature: a config
 * with no `[limits]` block still gets warned before it is cut off.
 *
 * `.loose()` for the same reason `GateSchema` is: `when_capped` is the shape
 * most likely to grow, and dropping a key someone wrote would silently discard
 * their intent.
 */
export const LimitsSchema = z
  .object({
    /** Fraction of a window at which the strip goes amber. */
    warn_at: z.number().min(0).max(1).default(0.85),
    /** Fraction at which a run is refused rather than started. */
    block_at: z.number().min(0).max(1).default(0.97),
    /**
     * `{ codex = "qwen" }` — which Station takes over when one is capped.
     *
     * Parsed and kept for Step 39's fallback routing; **nothing reads it yet**,
     * the same standing `merges` has on a Gate. Accepting it now means a
     * config written against the README survives a round trip through the
     * Desk's own writer rather than being dropped as an unknown key.
     */
    when_capped: z.record(Identifier, Identifier).default({}),
  })
  .loose();

/**
 * `[commons]` — only the approval policy is live in Step 48.
 *
 * `.loose()` keeps the already-documented store, sync, projection and MCP
 * settings intact while their later steps remain unimplemented. The default
 * is the safety boundary: an agent capture waits for a person unless somebody
 * has explicitly chosen `auto` in this project.
 */
export const CommonsSchema = z
  .object({
    approval: z.enum(["inbox", "auto"]).default("inbox"),
  })
  .loose();

export const ConfigSchema = z.object({
  desk: DeskSchema.default({}),
  station: z.array(StationSchema).default([]),
  gate: z.record(Identifier, GateSchema).default({}),
  cuesheet: z.record(Identifier, CuesheetSchema).default({}),
  // `prefault` rather than `default`: an absent `[limits]` table has to be run
  // *through* the schema so the field defaults inside it apply. `.default({})`
  // hands back the literal empty object, which on a `.loose()` schema does not
  // typecheck and would not carry `warn_at` even if it did.
  limits: LimitsSchema.prefault({}),
  commons: CommonsSchema.prefault({}),
});

// ── Types ───────────────────────────────────────────────────────────────────

export type Desk = z.infer<typeof DeskSchema>;
export type Station = z.infer<typeof StationSchema>;
export type Cue = z.infer<typeof CueSchema>;
export type GateRef = z.infer<typeof GateRefSchema>;
export type CueStep = z.infer<typeof CueStepSchema>;
export type Cuesheet = z.infer<typeof CuesheetSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type CommonsConfig = z.infer<typeof CommonsSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function isGateRef(step: CueStep): step is GateRef {
  return "gate" in step;
}

// ── Deferred tables ─────────────────────────────────────────────────────────

/**
 * Top-level tables the README documents that this build does not implement.
 * Each maps to a milestone; see PLAN-STEP.MD's "Deferred on purpose" table.
 */
export const DEFERRED_TABLES: Readonly<Record<string, string>> = {
  caller: "The Caller is M6, post-1.0.",
  oncall: "On-Call is M7, post-1.0.",
  trigger: "Triggers arrive with On-Call (M7).",
  remote: "Phone pairing and tailnet serving are M3.",
};

export interface ConfigWarning {
  /** The top-level table the warning is about, when it is about one. */
  table?: string;
  message: string;
}

export interface LoadedConfig {
  config: Config;
  warnings: ConfigWarning[];
  /**
   * The file this came from, or `null` when nothing was found and the
   * built-in defaults were used. Step 20 writes new Stations back here.
   */
  sourcePath: string | null;
  /**
   * Tables that parsed but are not implemented, kept verbatim. Preserving
   * these is what makes a UI-driven rewrite of the file non-destructive.
   */
  deferred: Record<string, unknown>;
}

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

// ── Versioning ──────────────────────────────────────────────────────────────

/**
 * The config format this build reads — the top-level `version = N` key.
 *
 * **Absent means 1, and 1 is the format `v0.1.0-alpha` shipped.** Every table
 * added since (`[gate.*]`, `[limits]`, `[commons]`) was additive, so every
 * released build's config parses here unchanged; the profiles under
 * `daemon/src/fixtures/profiles` are what prove that rather than assert it.
 * So no file needs the key today, and no writer adds it: stamping a
 * `version = 1` into a repository's committed `cuesheet.toml` would be a diff
 * in somebody's code that changes nothing.
 *
 * **The key exists for the build that comes after a breaking change.** That
 * build writes `version = 2`, and this one — the older build a teammate still
 * runs against the same committed file — refuses it rather than reading a
 * format it half-understands and then writing a Station into it.
 *
 * **A config is upgraded where it is read, never rewritten on disk,** and that
 * is a deliberate difference from the run store. `cuesheet.toml` is usually
 * committed and shared, often by people on different builds; rewriting it on
 * load would hand every teammate on an older build a file their build refuses.
 * When version 2 exists, its upgrade from 1 goes in {@link parseConfig},
 * between the version check and the schema, and runs on every read. Nothing
 * is built for that yet, because a migration list with nothing in it is a
 * mechanism nobody has exercised.
 */
export const CONFIG_VERSION = 1;

// ── Parsing ─────────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string | null,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * A config written by a newer Cuesheet. A `ConfigError`, so every caller that
 * already refuses a broken file refuses this one too — `addStation` included,
 * which is the one that would otherwise write into it.
 */
export class ConfigTooNewError extends ConfigError {
  constructor(
    readonly found: number,
    sourcePath: string | null,
  ) {
    super(
      `${sourcePath ?? "config"} was written by a newer version of Cuesheet ` +
        `(config v${String(found)}; this build reads v${String(CONFIG_VERSION)}). ` +
        `Upgrade Cuesheet rather than editing the version down; nothing has been changed.`,
      sourcePath,
    );
    this.name = "ConfigTooNewError";
  }
}

/**
 * Read the `version` key, refusing one this build does not understand.
 *
 * Checked before the schema, so a newer file is refused for being newer
 * rather than for whichever of its new fields zod happens to trip on first —
 * "invalid" and "from the future" need different remedies.
 */
function configVersion(
  table: Record<string, unknown>,
  sourcePath: string | null,
): number {
  const raw = table["version"];
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ConfigError(
      `${sourcePath ?? "config"}: \`version\` must be a whole number of 1 or more.`,
      sourcePath,
    );
  }
  if (raw > CONFIG_VERSION) throw new ConfigTooNewError(raw, sourcePath);
  return raw;
}

/**
 * Parse config text.
 *
 * Warnings are collected by diffing the TOML's top-level table names against
 * what the schema implements — *not* by asking zod. Zod drops unknown keys
 * silently, so a schema-only implementation reports nothing and the user
 * quietly loses half their file.
 */
/**
 * Drop a leading UTF-8 byte order mark.
 *
 * Windows is where this matters and it is not an edge case: Notepad writes a
 * BOM when it saves UTF-8, and so does PowerShell's `Set-Content -Encoding
 * utf8` on Windows PowerShell 5.1 — the two most likely ways a person hand-
 * edits `cuesheet.toml` on that platform. `smol-toml` then reads U+FEFF as the
 * first character of the first key and rejects the file with *"only letter,
 * numbers, dashes and underscores are allowed in keys"*, pointing at a
 * `[[station]]` line that is plainly correct. The daemon refuses to boot, and
 * the message names neither the BOM nor the real problem, so there is nothing
 * in it to act on.
 *
 * `readFile(…, "utf8")` does not strip it — Node only does that for UTF-16.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseConfig(
  text: string,
  sourcePath: string | null = null,
): LoadedConfig {
  let raw: unknown;
  try {
    raw = parseToml(stripBom(text));
  } catch (cause) {
    throw new ConfigError(
      `${sourcePath ?? "config"} is not valid TOML: ${errorText(cause)}`,
      sourcePath,
      cause,
    );
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `${sourcePath ?? "config"} must be a TOML table`,
      sourcePath,
    );
  }

  const table = raw as Record<string, unknown>;
  configVersion(table, sourcePath);
  const warnings: ConfigWarning[] = [];
  const deferred: Record<string, unknown> = {};
  const implemented = new Set([
    // A key rather than a table, and not part of `Config`: it describes the
    // file, not the workflow, and `configVersion` has already dealt with it.
    "version",
    "desk",
    "station",
    "gate",
    "cuesheet",
    "limits",
    "commons",
  ]);

  for (const key of Object.keys(table)) {
    if (implemented.has(key)) continue;
    deferred[key] = table[key];
    const why = DEFERRED_TABLES[key];
    warnings.push({
      table: key,
      message: why
        ? `[${key}] parsed but not implemented yet — ${why}`
        : `[${key}] is not a Cuesheet config table and was ignored.`,
    });
  }

  const parsed = ConfigSchema.safeParse(table);
  if (!parsed.success) {
    throw new ConfigError(
      `${sourcePath ?? "config"} is invalid:\n${formatIssues(parsed.error)}`,
      sourcePath,
      parsed.error,
    );
  }

  warnings.push(...lint(parsed.data));

  return { config: parsed.data, warnings, sourcePath, deferred };
}

/**
 * Cross-field checks zod cannot express cheaply, and which are worth a warning
 * rather than a hard failure — a half-written config should still open the app.
 */
function lint(config: Config): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const seen = new Set<string>();

  const deferredCommons = Object.keys(config.commons).filter(
    (key) => key !== "approval",
  );
  if (deferredCommons.length > 0) {
    warnings.push({
      table: "commons",
      message:
        `[commons].approval is active; ${deferredCommons.join(", ")} ` +
        `${deferredCommons.length === 1 ? "is" : "are"} preserved but not implemented yet.`,
    });
  }

  for (const station of config.station) {
    if (seen.has(station.id)) {
      warnings.push({
        table: "station",
        message: `Duplicate station id "${station.id}" — the last one wins.`,
      });
    }
    seen.add(station.id);

    if (!station.workspace) {
      warnings.push({
        table: "station",
        message: `Station "${station.id}" has no workspace; it cannot run until one is set.`,
      });
    }
  }

  // A threshold pair that cannot fire in the order it describes. Warned rather
  // than rejected, because `lint` exists precisely so a half-written config
  // still opens the app — refusing to start the Desk over a transposed pair of
  // numbers is a worse outcome than saying so on screen.
  if (config.limits.warn_at > config.limits.block_at) {
    warnings.push({
      table: "limits",
      message:
        `warn_at (${String(config.limits.warn_at)}) is above block_at ` +
        `(${String(config.limits.block_at)}), so a run is refused before it ` +
        `is ever warned about. Swap them.`,
    });
  }

  for (const [name, sheet] of Object.entries(config.cuesheet)) {
    for (const step of sheet.cues) {
      if (isGateRef(step)) {
        // A gate cue naming a gate that does not exist is the one case worth
        // warning about now that Gates run: the cue would otherwise pass
        // silently, which is the worst possible failure for a safety check.
        if (config.gate[step.gate] === undefined) {
          warnings.push({
            table: "cuesheet",
            message: `Cuesheet "${name}" references unknown gate "${step.gate}"; add a [gate.${step.gate}] table or the run will stop there.`,
          });
        }
        continue;
      }
      if (!seen.has(step.station)) {
        warnings.push({
          table: "cuesheet",
          message: `Cuesheet "${name}" references unknown station "${step.station}".`,
        });
      }
    }
  }

  return warnings;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Where a config may live, nearest first: the project you are standing in,
 * then your user-level file, then built-in defaults.
 */
export function configSearchPaths(
  cwd: string,
  env: HostEnv = hostEnv(),
): string[] {
  const p = pathFor(env);
  return [
    p.join(cwd, CONFIG_FILENAME),
    p.join(configDir(env), CONFIG_FILENAME),
  ];
}

/**
 * Where a project's config may live, nearest-to-the-work first.
 *
 * The same ordering {@link configSearchPaths} applies, for the same reason and
 * with a different second candidate: a `cuesheet.toml` at the project root
 * commits with the code and is what a team sharing Stations wants, so it wins
 * whenever it exists; `~/.cuesheet/projects/<id>/cuesheet.toml` is the private
 * fallback that keeps using Cuesheet on someone else's repository from leaving
 * a file in it.
 *
 * Step 31 settled that ordering and built the paths; this is where the loader
 * finally uses them.
 */
export function projectConfigSearchPaths(
  root: string,
  id: string,
  env: HostEnv = hostEnv(),
): string[] {
  return [pathFor(env).join(root, CONFIG_FILENAME), projectConfigFile(id, env)];
}

/**
 * Load the first config found, or the built-in defaults if there is none.
 *
 * Never throws for a missing file — a fresh install has no config and must
 * still boot. It *does* throw for a file that exists and is broken: silently
 * falling back would hide a typo behind an empty Desk.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  env: HostEnv = hostEnv(),
): Promise<LoadedConfig> {
  return loadConfigFrom(configSearchPaths(cwd, env));
}

/**
 * The loader, given its candidates explicitly.
 *
 * Extracted in Step 32 because a project's config is not found by walking from
 * a working directory any more — the daemon serves several projects at once
 * and has no single `cwd` that could mean the right thing. `loadConfig` is now
 * this function plus one fixed candidate list, so both paths through it stay
 * the same code rather than two implementations that agree until they do not.
 */
export async function loadConfigFrom(
  candidates: readonly string[],
): Promise<LoadedConfig> {
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) continue;
      throw new ConfigError(
        `Could not read ${candidate}: ${errorText(cause)}`,
        candidate,
        cause,
      );
    }
    return parseConfig(text, candidate);
  }

  return {
    config: DEFAULT_CONFIG,
    warnings: [
      {
        message: `No ${CONFIG_FILENAME} found; using defaults. Add a Station to create one.`,
      },
    ],
    sourcePath: null,
    deferred: {},
  };
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: string }).code === "ENOENT"
  );
}
