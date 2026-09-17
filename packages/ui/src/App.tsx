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
import { LaunchSurface } from "./components/LaunchSurface.js";
import { LedgerPanel } from "./components/LedgerPanel.js";
import { LimitsStrip } from "./components/LimitsStrip.js";
import { ProjectSwitcher } from "./components/ProjectSwitcher.js";
import { RunLog } from "./components/RunLog.js";
import { StationTile } from "./components/StationTile.js";
import { bridge } from "./api/base.js";
import { isPaletteChord, modifierKey } from "./format.js";
import { isShowing, selectedEvents, selectedRun } from "./store/reducer.js";
import { describeSwitcher, switchCommands } from "./switcher.js";
import { useDesk } from "./store/useDesk.js";

export function App(): React.JSX.Element {
  const desk = useDesk();
  // The native picker the Electron preload exposes. Absent in a browser, which
  // is why the placeholder below has a second branch rather than a dead button.
  const chooseDirectory = bridge()?.chooseDirectory;
  const { state } = desk;
  const [palette, setPalette] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ledger, setLedger] = useState(false);

  const run = selectedRun(state);
  const events = selectedEvents(state);
  const stations = state.stations?.stations ?? [];
  const warnings = state.stations?.warnings ?? [];
  const activeId =
    desk.project.status === "open" ? desk.project.project.id : null;
  /**
   * Whether what the reducer holds belongs to the project the shell is naming.
   *
   * False for the moment between choosing a project and its resync landing —
   * the switch happens on the client, so there is a paint in between. Step
   * 41's third done-when is that nothing of the old project is drawn under the
   * new one's name in that paint, and this is where the question gets asked.
   */
  const showing = isShowing(state, activeId);
  const rows = useMemo(
    () => describeSwitcher(desk.projects, activeId),
    [desk.projects, activeId],
  );

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
      {
        id: "ledger",
        label: "Open the ledger — what this project has spent",
        run: () => setLedger(true),
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
      // Switching, from inside the palette. The menu in the topbar is the
      // discoverable half; this is the half that works with a modal open, one
      // hand, and no idea where the mouse is.
      ...switchCommands(rows).map((command) => ({
        id: command.id,
        label: command.label,
        run: () => void desk.switchTo(command.projectId),
      })),
      {
        id: "all-projects",
        label: "All projects — leave this one running and go back to the list",
        run: () => desk.closeProject(),
      },
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
    [desk, run, rows, state.stations],
  );

  // No project, no Desk. A first-run install has nothing to show tiles *of*,
  // and the daemon deliberately does not invent a project to fill the gap.
  //
  // Step 40's launch surface — reachable again as of Step 41, which is what
  // "All projects…" in the switcher and in the palette does. It is what there
  // is when no project is open, and leaving a project open is a client action:
  // nothing on the daemon stops.
  if (desk.project.status !== "open") {
    return (
      <LaunchSurface
        projects={desk.project.status === "loading" ? null : desk.projects}
        chooseDirectory={chooseDirectory}
        onOpen={(root) => void desk.openFolder(root)}
        onForget={(id) => void desk.forget(id)}
        error={state.error}
      />
    );
  }

  return (
    <div className="desk">
      <header className="topbar">
        <span className="brand">CUESHEET</span>
        {/*
          Always rendered, and rendered *before* anything that depends on the
          resync having landed. A shell that blanked during a switch would be a
          shell you could not switch out of again — which is the same mistake
          as a launch surface you cannot get back to.
        */}
        <ProjectSwitcher
          rows={rows}
          activeName={desk.project.project.name}
          activeRoot={desk.project.project.root}
          onSwitch={(id) => void desk.switchTo(id)}
          onClose={desk.closeProject}
          chooseDirectory={chooseDirectory}
          onOpen={(root) => void desk.openFolder(root)}
        />
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

      {/*
        Everything below belongs to a project, and is drawn only while the
        state actually holds *this* project's work. Between choosing a project
        and its resync landing there is a paint where the reducer still has the
        last one's runs, tiles and standbys — Step 41's third done-when is that
        none of it appears under the new project's name.
      */}
      {showing ? (
        <>
          {warnings.map((warning, index) => (
            <div
              className="banner warn"
              key={`${warning.table ?? ""}-${index}`}
            >
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
                  No Stations yet. Add one — nothing here requires you to open
                  the TOML.
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
        </>
      ) : (
        <main>
          {/*
            Not a spinner and not an empty Desk: naming the project says which
            of the two things that could be happening is happening. The
            switcher above is still live, so a mistaken switch costs one click.
          */}
          <p className="hint switching">Opening {desk.project.project.name}…</p>
        </main>
      )}

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onStart={(prompt) => void desk.start(prompt)}
        commands={commands}
        // Not while the Desk is between projects: the Stations on screen
        // belong to the one being left, and starting a run against them is the
        // one thing here that would be more than a misleading render.
        canStart={showing && stations.length > 0}
      />

      {ledger && (
        <LedgerPanel
          projectId={desk.project.project.id}
          onClose={() => setLedger(false)}
        />
      )}

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
