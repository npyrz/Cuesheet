/**
 * Step 20's five-choice panel: harness, model, role, workspace, leash.
 *
 * Two decisions worth stating, because both are the plan's and not this
 * component's to relitigate:
 *
 * - **Installed harnesses come first, uninstalled ones are greyed but
 *   present.** `GET /stations` already sorts them that way. Hiding the ones
 *   you do not have would make the panel lie about what Cuesheet supports.
 * - **The leash's deny list is seeded with `.git/**`.** The allow defaults to
 *   `**`, the matcher runs with `dot: true`, and nothing else in the system
 *   stops an agent from rewriting `.git/hooks/`. The field is editable, but
 *   it does not start empty.
 *
 * Workspace is a typed path with server-side validation — the browser cannot
 * open a native directory picker, and `chooseDirectory` on the Electron
 * bridge is wired opportunistically so Step 21 only has to implement it.
 */
import { useMemo, useState } from "react";
import type { HarnessProbe, Role } from "@cuesheet/core";
import { ROLES } from "@cuesheet/core/types";
import { bridge } from "../api/base.js";
import type { NewStation, StationsResponse } from "../api/client.js";

export interface AddStationPanelProps {
  stations: StationsResponse | null;
  onCancel: () => void;
  onAdd: (draft: NewStation) => Promise<void>;
}

export function AddStationPanel({
  stations,
  onCancel,
  onAdd,
}: AddStationPanelProps): React.JSX.Element {
  const harnesses = stations?.harnesses ?? [];
  const firstInstalled = harnesses.find((probe) => probe.installed);

  const [harness, setHarness] = useState(
    firstInstalled?.harness ?? harnesses[0]?.harness ?? "claude-code",
  );
  const [id, setId] = useState("");
  const [model, setModel] = useState("");
  const [role, setRole] = useState<Role>("engineer");
  const [workspace, setWorkspace] = useState("");
  const [paths, setPaths] = useState("**");
  const [deny, setDeny] = useState(".git/**");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taken = useMemo(
    () =>
      new Set(
        (stations?.stations ?? []).map((s) => s.station.id.toLowerCase()),
      ),
    [stations],
  );

  // A suggested id, so the common case is four choices rather than five.
  const suggested = id.trim() === "" ? suggestId(harness, taken) : id.trim();
  const duplicate = taken.has(suggested.toLowerCase());
  const chooseDirectory = bridge()?.chooseDirectory;

  const submit = async (): Promise<void> => {
    setError(null);
    if (workspace.trim() === "") {
      setError("A Station needs a workspace before it can run.");
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        id: suggested,
        harness,
        role,
        workspace: workspace.trim(),
        ...(model.trim() !== "" && { model: model.trim() }),
        paths: splitList(paths),
        deny: splitList(deny),
      });
    } catch (cause) {
      // The daemon's own message: "a station named opus is already
      // configured", "workspace /x does not exist". Replacing it with a
      // generic failure is how someone re-types a path that was never wrong.
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add a Station"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <header>Add a Station</header>
        <div className="body">
          <div className="field">
            <label id="harness-label">1 · Harness</label>
            <div
              className="harness-list"
              role="group"
              aria-labelledby="harness-label"
            >
              {harnesses.length === 0 && (
                <p className="note">Probing harnesses…</p>
              )}
              {harnesses.map((probe) => (
                <button
                  key={probe.harness}
                  type="button"
                  className="harness"
                  data-installed={probe.installed}
                  aria-pressed={harness === probe.harness}
                  onClick={() => setHarness(probe.harness)}
                >
                  <span className="mark">{probe.installed ? "●" : "○"}</span>
                  <span>{probe.harness}</span>
                  <span className="detail">{probeSummary(probe)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="station-id">Station name</label>
            <input
              id="station-id"
              value={id}
              placeholder={suggested}
              onChange={(event) => setId(event.target.value)}
            />
            {duplicate && (
              <span className="field-error">
                “{suggested}” is already a Station.
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="station-model">2 · Model</label>
            <input
              id="station-model"
              value={model}
              placeholder="the harness default"
              onChange={(event) => setModel(event.target.value)}
            />
          </div>

          <div className="field">
            <label id="role-label">3 · Role</label>
            <div className="roles" role="group" aria-labelledby="role-label">
              {ROLES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={role === candidate}
                  className={role === candidate ? "primary" : ""}
                  onClick={() => setRole(candidate)}
                >
                  {candidate}
                </button>
              ))}
            </div>
            <span className="note">
              The same install is a different Station depending on the seat.
            </span>
          </div>

          <div className="field">
            <label htmlFor="station-workspace">4 · Workspace</label>
            <input
              id="station-workspace"
              value={workspace}
              placeholder="~/code/api"
              onChange={(event) => setWorkspace(event.target.value)}
            />
            {chooseDirectory && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  void chooseDirectory().then((picked) => {
                    if (picked !== null) setWorkspace(picked);
                  });
                }}
              >
                browse…
              </button>
            )}
            <span className="note">
              Checked on the daemon, which is what will actually open it.
            </span>
          </div>

          <div className="field">
            <label htmlFor="station-paths">5 · Leash</label>
            <input
              id="station-paths"
              value={paths}
              onChange={(event) => setPaths(event.target.value)}
              aria-label="May touch"
            />
            <span className="note">may touch · space separated</span>
            <input
              value={deny}
              onChange={(event) => setDeny(event.target.value)}
              aria-label="Never touch"
            />
            <span className="note">
              never · deny always beats allow. `.git/**` is seeded because an
              allow of `**` otherwise reaches `.git/hooks/`.
            </span>
          </div>

          {error && <p className="field-error">{error}</p>}
        </div>

        <footer>
          <button type="button" className="ghost" onClick={onCancel}>
            cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || duplicate}
            onClick={() => void submit()}
          >
            {busy ? "adding…" : "add"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function probeSummary(probe: HarnessProbe): string {
  if (!probe.installed) return "not installed";
  const version = probe.version ? `v${probe.version.replace(/^v/, "")}` : "";
  return [version, probe.authed ? "✓ logged in" : "not logged in"]
    .filter(Boolean)
    .join("  ");
}

/** `claude-code` → `claude-code`, then `claude-code-2` if that is taken. */
function suggestId(harness: string, taken: Set<string>): string {
  const base = harness.toLowerCase();
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** Whitespace-separated globs. Empty means "no rules", not "one empty rule". */
function splitList(raw: string): string[] {
  return raw.split(/\s+/).filter((entry) => entry !== "");
}
