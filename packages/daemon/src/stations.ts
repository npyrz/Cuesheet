/**
 * What `GET /stations` answers with.
 *
 * Config is what you wrote; a probe is what is true right now. The Desk needs
 * both — Step 20's panel lists installed harnesses first and greys out the
 * rest — so the endpoint returns the configured Stations, the probe result for
 * every harness it knows about, *and* the loader's warnings.
 *
 * The warnings are not an afterthought: Step 6 collects them precisely because
 * this route is where a user finds out that the `[gate]` table they wrote is
 * parsed but not yet live.
 */
import {
  isGateRef,
  BUILTIN_HARNESS_IDS,
  type ConfigWarning,
  type HarnessId,
  type HarnessProbe,
  type LoadedConfig,
  type Role,
  type Station,
} from "@cuesheet/core";

export type HarnessProber = (harness: HarnessId) => Promise<HarnessProbe>;

/**
 * Which seats a harness can play, or `undefined` when nobody knows.
 *
 * Separate from {@link HarnessProber} rather than another field on
 * `HarnessProbe`, because the two answer different questions: a probe is
 * liveness — installed, logged in, right now — and this is a static capability
 * that is the same whether the CLI is running or uninstalled. Folding it into
 * the probe would mean a harness's roles becoming unknown when its binary is
 * missing, and the warning below is at its most useful exactly then: before
 * you install anything, while you are still writing the config.
 */
export type HarnessRoles = (harness: HarnessId) => readonly Role[] | undefined;

export interface StationView {
  station: Station;
  probe: HarnessProbe;
}

export interface StationsResponse {
  stations: StationView[];
  /** Every harness we know of, probed — including ones no Station uses. */
  harnesses: HarnessProbe[];
  warnings: ConfigWarning[];
  /**
   * The named cuesheets, and whether each one runs a Gate.
   *
   * Here rather than on a route of its own because the Desk already polls
   * this one for everything else it needs to draw the command palette, and a
   * cuesheet the UI cannot see is a Gate nobody can reach without curl.
   */
  cuesheets: CuesheetView[];
  /** Which file the config came from; `null` when defaults were used. */
  sourcePath: string | null;
}

export interface CuesheetView {
  id: string;
  /** Station ids in cue order, gates omitted. */
  stationIds: string[];
  /** The gates this cuesheet runs, in order. */
  gates: string[];
}

/**
 * The inert default prober: everything is uninstalled.
 *
 * Real probing exists — `harnessRuntime()` supplies a prober backed by the
 * harness registry, and that is what the app and the standalone daemon use.
 * This stays the *default* so `startDaemon`'s own tests never shell out to
 * somebody's binary: a probe that spawns is slow, and a test suite whose
 * results depend on what is installed on the machine is not a test suite.
 */
export const unprobed: HarnessProber = async (harness) => ({
  harness,
  installed: false,
  authed: false,
  error: "No prober is wired up; pass one via `harnessRuntime()`.",
});

/**
 * The inert default: nothing is known about any harness's roles.
 *
 * `undefined` rather than `[]`, and the distinction is the whole design.
 * An empty array would mean "this harness plays no seat", which would warn
 * about every Station in every config the moment no registry was wired up —
 * including `startDaemon`'s own tests, and including the `ollama` entry that
 * {@link BUILTIN_HARNESS_IDS} lists but no build registers yet.
 */
export const unknownRoles: HarnessRoles = () => undefined;

export async function describeStations(
  loaded: LoadedConfig,
  probe: HarnessProber = unprobed,
  rolesOf: HarnessRoles = unknownRoles,
): Promise<StationsResponse> {
  const configured = loaded.config.station;

  // Probe each distinct harness once, not once per Station that uses it — a
  // probe shells out to a binary and three Stations on `claude-code` should
  // not mean three `--version` calls.
  const ids = new Set<HarnessId>([
    ...configured.map((station) => station.harness),
    ...BUILTIN_HARNESS_IDS,
  ]);

  const entries = await Promise.all(
    [...ids].map(async (id) => [id, await probe(id)] as const),
  );
  const probes = new Map<HarnessId, HarnessProbe>(entries);

  return {
    stations: configured.map((station) => ({
      station,
      probe: probes.get(station.harness) ?? {
        harness: station.harness,
        installed: false,
        authed: false,
        error: "Unknown harness.",
      },
    })),
    harnesses: [...probes.values()].sort(byInstalledThenName),
    cuesheets: Object.entries(loaded.config.cuesheet).map(([id, sheet]) => ({
      id,
      // `flatMap` rather than filter-then-cast: `isGateRef` is a type guard,
      // and casting past it would survive a change to `CueStep` in silence.
      stationIds: sheet.cues.flatMap((cue) =>
        isGateRef(cue) ? [] : [cue.station],
      ),
      gates: sheet.cues.filter(isGateRef).map((cue) => cue.gate),
    })),
    warnings: [...loaded.warnings, ...seatWarnings(configured, rolesOf)],
    sourcePath: loaded.sourcePath,
  };
}

/**
 * A Station sitting in a seat its harness cannot play.
 *
 * This is where the README's promise stops being advisory: *"It will warn you
 * when a `worker`-class model is placed in a `reviewer` seat, because that
 * combination produces false confidence rather than safety."* A small local
 * model asked to review a frontier model's diff approves nearly everything,
 * and an approval nobody can distinguish from a real one is worse than no
 * review at all — so the failure has to be visible while the config is being
 * written, not three steps into a run.
 *
 * It lives here rather than in `config.ts`'s `lint()`, which is where every
 * other cross-field warning lives, and the reason is the dependency direction:
 * roles are a *harness* fact, `core` sits below `harness`, and importing
 * upward to reach one would invert the arrow the whole package layout exists
 * to keep pointing one way. The loader knows what you wrote; only the daemon
 * knows what the harnesses can do.
 *
 * A harness nobody recognizes warns nothing. Third-party harnesses are a
 * supported case — the README calls writing one "the single most valuable
 * contribution" — and a config that cannot be opened without the plugin that
 * declares its roles would make that contribution hostile.
 */
function seatWarnings(
  stations: readonly Station[],
  rolesOf: HarnessRoles,
): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  for (const station of stations) {
    const roles = rolesOf(station.harness);
    if (roles === undefined || roles.includes(station.role)) continue;

    // Plain prose, no backticks: `App.tsx` renders a warning as bare text in a
    // banner, so markdown punctuation arrives on screen as punctuation. Every
    // warning the loader emits quotes its identifiers, and this matches them.
    warnings.push({
      table: "station",
      message:
        `Station "${station.id}" is a ${station.role}, but the ` +
        `"${station.harness}" harness can only play ${listRoles(roles)}. ` +
        (station.role === "reviewer"
          ? "A model that cannot review will still answer as if it had, and " +
            "an approval you cannot tell from a real one is worse than none."
          : "The run will fail when it reaches this Station."),
    });
  }

  return warnings;
}

/** `the worker seat`, or `the engineer, reviewer or caller seats`. */
function listRoles(roles: readonly Role[]): string {
  if (roles.length === 0) return "no seat at all";
  if (roles.length === 1) return `the ${roles[0] as string} seat`;
  const listed = `${roles.slice(0, -1).join(", ")} or ${roles.at(-1) as string}`;
  return `the ${listed} seats`;
}

/** Installed first — that is the order Step 20's panel renders in. */
function byInstalledThenName(a: HarnessProbe, b: HarnessProbe): number {
  if (a.installed !== b.installed) return a.installed ? -1 : 1;
  return a.harness.localeCompare(b.harness);
}
