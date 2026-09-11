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
  type Station,
} from "@cuesheet/core";

export type HarnessProber = (harness: HarnessId) => Promise<HarnessProbe>;

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

export async function describeStations(
  loaded: LoadedConfig,
  probe: HarnessProber = unprobed,
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
    warnings: loaded.warnings,
    sourcePath: loaded.sourcePath,
  };
}

/** Installed first — that is the order Step 20's panel renders in. */
function byInstalledThenName(a: HarnessProbe, b: HarnessProbe): number {
  if (a.installed !== b.installed) return a.installed ? -1 : 1;
  return a.harness.localeCompare(b.harness);
}
