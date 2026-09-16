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
import { LimitsStrip } from "./components/LimitsStrip.js";
import { RunLog } from "./components/RunLog.js";
import { StationTile } from "./components/StationTile.js";
import { bridge } from "./api/base.js";
import { isPaletteChord, modifierKey } from "./format.js";
import { selectedEvents, selectedRun } from "./store/reducer.js";
import { useDesk } from "./store/useDesk.js";

export function App(): React.JSX.Element {
  const desk = useDesk();
  // The native picker the Electron preload exposes. Absent in a browser, which
  // is why the placeholder below has a second branch rather than a dead button.
  const chooseDirectory = bridge()?.chooseDirectory;
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
      // One per configured cuesheet. The gate names are in the label because
      // "this run will be reviewed and can be held" is the thing you want to
      // know *before* pressing it, not after.
      ...(state.stations?.cuesheets ?? []).map((sheet) => ({
        id: `cuesheet-${sheet.id}`,
        label:
          sheet.gates.length === 0
            ? `Run the “${sheet.id}” cuesheet`
            : `Run the “${sheet.id}” cuesheet — gate: ${sheet.gates.join(", ")}`,
        run: (prompt: string) => {
          if (prompt !== "") void desk.start(prompt, sheet.id);
        },
        needsPrompt: true,
      })),
    ],
    [desk, run, state.stations],
  );

  // No project, no Desk. A first-run install has nothing to show tiles *of*,
  // and the daemon deliberately does not invent a project to fill the gap.
  //
  // This is the smallest honest placeholder, not the launch surface: Step 40
  // builds recents, a folder picker and a missing-folder state, and Step 41
  // puts a switcher above all of it. Anything more here would be thrown away.
  if (desk.project.status !== "open") {
    return (
      <div className="desk">
        <header className="topbar">
          <span className="brand">CUESHEET</span>
          <span className="spacer" />
        </header>
        <main className="empty">
          {desk.project.status === "loading" ? (
            <p>Looking for your projects…</p>
          ) : (
            <>
              <p>No project yet.</p>
              {chooseDirectory ? (
                <button
                  type="button"
                  onClick={() => {
                    void chooseDirectory().then((picked) => {
                      if (picked !== null) void desk.openFolder(picked);
                    });
                  }}
                >
                  open a folder…
                </button>
              ) : (
                <p className="hint">
                  Start the daemon in a directory that has a{" "}
                  <code>cuesheet.toml</code>, or open a folder from the desktop
                  app.
                </p>
              )}
              {state.error !== null && <p className="hint">{state.error}</p>}
            </>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="desk">
      <header className="topbar">
        <span className="brand">CUESHEET</span>
        {/*
          The smallest thing that exercises switching, not the switcher.
          Step 41 makes it one keyboard-reachable action and puts the active
          project in the window title and the tray; Step 40 gives recents and
          the missing-folder state a designed surface. A `select` is here
          because Step 34 is about what a switch must not disturb, and that
          needs a way to perform one — anything more would be thrown away.

          Projects whose folder has gone are rendered and disabled rather than
          hidden: a list that silently drops one is how someone concludes
          their project was deleted.
        */}
        {desk.projects.length > 1 ? (
          <select
            className="project"
            aria-label="project"
            title={desk.project.project.root}
            value={desk.project.project.id}
            onChange={(changed) => {
              void desk.switchTo(changed.target.value);
            }}
          >
            {desk.projects.map((candidate) => (
              <option
                key={candidate.id}
                value={candidate.id}
                disabled={candidate.status !== "ok"}
              >
                {candidate.name}
                {candidate.status === "ok" ? "" : " (missing)"}
              </option>
            ))}
          </select>
        ) : (
          <span className="project" title={desk.project.project.root}>
            {desk.project.project.name}
          </span>
        )}
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

      {/*
        Above the tiles, because it is what an operator checks *before*
        starting work rather than after. Renders nothing at all until the
        first `/usage` fetch lands — an empty frame tells them less than the
        space it takes.
      */}
      {state.stations && (
        <LimitsStrip usage={state.usage} limits={state.stations.limits} />
      )}

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
