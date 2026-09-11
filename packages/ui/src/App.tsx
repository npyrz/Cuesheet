/**
 * The Desk.
 *
 * Layout only — every piece of state comes from `useDesk`, and every piece of
 * logic worth testing lives in the reducer or in `format.ts`. If something
 * here starts deciding things, it belongs in one of those two files.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AddStationPanel } from "./components/AddStationPanel.js";
import { CommandPalette, type Command } from "./components/CommandPalette.js";
import { RunLog } from "./components/RunLog.js";
import { StationTile } from "./components/StationTile.js";
import { isPaletteChord, modifierKey } from "./format.js";
import { selectedEvents, selectedRun } from "./store/reducer.js";
import { useDesk } from "./store/useDesk.js";

export function App(): React.JSX.Element {
  const desk = useDesk();
  const { state } = desk;
  const [palette, setPalette] = useState(false);
  const [adding, setAdding] = useState(false);

  const run = selectedRun(state);
  const events = selectedEvents(state);
  const stations = state.stations?.stations ?? [];
  const warnings = state.stations?.warnings ?? [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isPaletteChord(event)) {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const select = useCallback(
    (runId: string) => {
      void desk.select(runId);
    },
    [desk],
  );

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "add-station",
        label: "Add a Station…",
        run: () => setAdding(true),
      },
      ...(run && run.status === "running"
        ? [
            {
              id: "stop",
              label: `Stop the current run`,
              run: () => void desk.stop(run.id),
            },
          ]
        : []),
    ],
    [desk, run],
  );

  return (
    <div className="desk">
      <header className="topbar">
        <span className="brand">CUESHEET</span>
        <span className="conn" data-status={state.connection}>
          <span className="dot" aria-hidden="true" />
          {state.connection === "open"
            ? "daemon connected"
            : state.connection === "closed"
              ? "daemon unreachable — retrying"
              : "connecting…"}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => setAdding(true)}>
          add a station
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setPalette(true)}
        >
          <span className="hint">{modifierKey()}K</span>
        </button>
      </header>

      {state.error && (
        <div className="banner">
          <span>{state.error}</span>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={desk.dismissError}>
            dismiss
          </button>
        </div>
      )}

      {warnings.map((warning, index) => (
        <div className="banner warn" key={`${warning.table ?? ""}-${index}`}>
          <span>{warning.message}</span>
        </div>
      ))}

      <main>
        {state.standbys.length > 0 && (
          <section>
            <h2 className="section-title">Standby</h2>
            {state.standbys.map((standby) => (
              <div className="standby" key={standby.id}>
                <span>{standby.ask}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="primary"
                  onClick={() => void desk.answer(standby.id, "go")}
                >
                  go
                </button>
                <button
                  type="button"
                  onClick={() => void desk.answer(standby.id, "no")}
                >
                  no
                </button>
              </div>
            ))}
          </section>
        )}

        <section>
          <h2 className="section-title">Stations</h2>
          <div className="tiles">
            {stations.map(({ station, probe }) => (
              <StationTile
                key={station.id}
                station={station}
                probe={probe}
                {...(state.stationActivity[station.id] && {
                  activity: state.stationActivity[station.id],
                })}
                onOpenRun={select}
              />
            ))}
            <button
              type="button"
              className="tile add"
              onClick={() => setAdding(true)}
            >
              + add a station
            </button>
          </div>
          {state.stations && stations.length === 0 && (
            <p className="hint">
              No Stations yet. Add one — nothing here requires you to open the
              TOML.
            </p>
          )}
        </section>

        <section>
          <h2 className="section-title">Runs</h2>
          <RunLog
            runs={state.runs}
            selected={run}
            events={events}
            onSelect={select}
            onStop={(runId) => void desk.stop(runId)}
            loadDiff={desk.diff}
          />
        </section>
      </main>

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onStart={(prompt) => void desk.start(prompt)}
        commands={commands}
        canStart={stations.length > 0}
      />

      {adding && (
        <AddStationPanel
          stations={state.stations}
          onCancel={() => setAdding(false)}
          onAdd={async (draft) => {
            await desk.create(draft);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
