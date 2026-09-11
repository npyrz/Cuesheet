/**
 * One Station, as the README draws it: status dot, role, harness, current
 * file, elapsed, cost.
 *
 * Config and liveness are separate props because they come from separate
 * places and disagree in a way that matters — a Station can be configured
 * against a harness that is not installed, and the tile has to say so rather
 * than render an idle dot and let the user find out when a run fails.
 */
import { useEffect, useState } from "react";
import type { HarnessProbe, Station } from "@cuesheet/core";
import type { StationActivity } from "../store/reducer.js";
import { elapsed, money, shortPath, statusDot, tokens } from "../format.js";

export interface StationTileProps {
  station: Station;
  probe: HarnessProbe;
  activity?: StationActivity;
  onOpenRun?: (runId: string) => void;
}

export function StationTile({
  station,
  probe,
  activity,
  onOpenRun,
}: StationTileProps): React.JSX.Element {
  const live = activity?.status === "working" || activity?.status === "standby";
  const clock = useTicker(live);

  const state = activity?.status ?? "idle";
  const since =
    activity === undefined
      ? null
      : elapsed(activity.startedAt, activity.endedAt ?? clock);

  const body = (): React.JSX.Element => {
    if (!probe.installed) {
      return (
        <span className="probe-bad">
          {probe.error ?? `${station.harness} is not installed`}
        </span>
      );
    }
    if (!probe.authed) {
      return <span className="probe-bad">not logged in</span>;
    }
    if (activity?.currentFile) {
      return (
        <span className="tile-activity">{shortPath(activity.currentFile)}</span>
      );
    }
    if (activity?.lastText) {
      return <span className="tile-activity">{activity.lastText}</span>;
    }
    return <span className="tile-sub">idle</span>;
  };

  const content = (
    <>
      <div className="tile-head">
        <span className="tile-dot" data-state={state} aria-hidden="true">
          {statusDot(state === "working" ? "running" : (state as "idle"))}
        </span>
        <span className="tile-id">{station.id}</span>
      </div>
      <div className="tile-sub">{station.role}</div>
      <div className="tile-sub">
        {station.harness}
        {station.model ? ` · ${station.model}` : ""}
      </div>

      <div className="tile-body">{body()}</div>

      <div className="tile-foot">
        <span>{since ?? "—"}</span>
        <span>{spend(activity)}</span>
      </div>
    </>
  );

  // A tile with a run behind it is a button that opens it; one without is not
  // interactive, and making it a disabled button would still put it in the
  // tab order for no reason.
  if (activity && onOpenRun) {
    return (
      <button
        type="button"
        className={`tile${probe.installed ? "" : " offline"}`}
        data-live={live}
        onClick={() => onOpenRun(activity.runId)}
        aria-label={`Station ${station.id}, ${state}. Open its run.`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={`tile${probe.installed ? "" : " offline"}`}
      data-live={live}
    >
      {content}
    </div>
  );
}

/**
 * What a tile says about money, which is less than the run row says.
 *
 * A `cost` event carries tokens; the authoritative *price* arrives once, on
 * `done`, for the run as a whole. So a Station's own cost legitimately has
 * tokens and no `usd` — and calling that `local`, as {@link money} otherwise
 * would, labels a claude-code tile as free for the whole run. Attributing the
 * run's total to a tile would be worse: with several Stations it is simply
 * made up.
 *
 * So tiles show tokens, and the price stays on the run row where it is
 * actually known. A Station that reports its own `usd` still shows it.
 */
function spend(activity: StationActivity | undefined): string {
  if (!activity) return "";
  const total = activity.cost.tokensIn + activity.cost.tokensOut;
  const priced = activity.cost.usd !== undefined ? money(activity.cost) : "";
  if (total === 0) return priced;
  return priced === "" ? tokens(total) : `${priced} · ${tokens(total)}`;
}

/**
 * A once-a-second clock, running only while something is live.
 *
 * The elapsed time on a finished tile is fixed, so re-rendering every idle
 * tile every second would be pure waste — and on a laptop, measurable waste.
 */
function useTicker(active: boolean): string | undefined {
  const [now, setNow] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!active) {
      setNow(undefined);
      return;
    }
    setNow(new Date().toISOString());
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
