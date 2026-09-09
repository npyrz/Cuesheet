/**
 * `cuesheet.toml` — schema, validation, and loading.
 *
 * These schemas are authoritative for the config-shaped domain types
 * (`Station`, `Cue`, `Cuesheet`); see the note in `types.ts` for why they are
 * inferred rather than hand-written.
 *
 * The README ships a full config example covering Gates, the Caller, limits,
 * On-Call, the Commons, and remote devices. None of those are implemented yet.
 * They are still *parsed* — collected, warned about, and carried through
 * untouched — so the README's example loads on day one and a user who writes
 * ahead of us does not lose their file the first time we round-trip it.
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

export const ConfigSchema = z.object({
  desk: DeskSchema.default({}),
  station: z.array(StationSchema).default([]),
  cuesheet: z.record(Identifier, CuesheetSchema).default({}),
});

// ── Types ───────────────────────────────────────────────────────────────────

export type Desk = z.infer<typeof DeskSchema>;
export type Station = z.infer<typeof StationSchema>;
export type Cue = z.infer<typeof CueSchema>;
export type GateRef = z.infer<typeof GateRefSchema>;
export type CueStep = z.infer<typeof CueStepSchema>;
export type Cuesheet = z.infer<typeof CuesheetSchema>;
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
  gate: "Gates are M5. The cues array already accepts `{ gate = ... }`, so this becomes live without a config change.",
  caller: "The Caller is M6, post-1.0.",
  limits: "Usage limits and fallback routing are M2.",
  oncall: "On-Call is M7, post-1.0.",
  trigger: "Triggers arrive with On-Call (M7).",
  commons: "The Commons is M4.",
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
 * Parse config text.
 *
 * Warnings are collected by diffing the TOML's top-level table names against
 * what the schema implements — *not* by asking zod. Zod drops unknown keys
 * silently, so a schema-only implementation reports nothing and the user
 * quietly loses half their file.
 */
export function parseConfig(
  text: string,
  sourcePath: string | null = null,
): LoadedConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
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
  const warnings: ConfigWarning[] = [];
  const deferred: Record<string, unknown> = {};
  const implemented = new Set(["desk", "station", "cuesheet"]);

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

  for (const [name, sheet] of Object.entries(config.cuesheet)) {
    for (const step of sheet.cues) {
      if (isGateRef(step)) {
        warnings.push({
          table: "cuesheet",
          message: `Cuesheet "${name}" references gate "${step.gate}"; Gates are not implemented yet and this cue will be skipped.`,
        });
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
  for (const candidate of configSearchPaths(cwd, env)) {
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
