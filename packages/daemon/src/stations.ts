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
  /** Which file the config came from; `null` when defaults were used. */
  sourcePath: string | null;
}

/**
 * The default prober: everything is uninstalled.
 *
 * Honest rather than optimistic. Real probing needs process spawning, which is
 * Step 15, and the registry that answers it is Step 13 — this keeps the route
 * and its response shape settled so neither the UI nor this file changes when
 * harnesses arrive.
 */
export const unprobed: HarnessProber = async (harness) => ({
  harness,
  installed: false,
  authed: false,
  error: "Harness probing is not implemented yet (Step 13).",
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
    warnings: loaded.warnings,
    sourcePath: loaded.sourcePath,
  };
}

/** Installed first — that is the order Step 20's panel renders in. */
function byInstalledThenName(a: HarnessProbe, b: HarnessProbe): number {
  if (a.installed !== b.installed) return a.installed ? -1 : 1;
  return a.harness.localeCompare(b.harness);
}
