import { useEffect, useRef, useState } from "react";
import type { PocketStandby } from "@cuesheet/core";
import {
  newStandbys,
  POCKET_SESSION,
  readPocketSession,
  type PocketSession,
} from "../pocket.js";

class PocketError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  session: PocketSession | null,
  body?: unknown,
  method = "GET",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/pocket${path}`, {
    method,
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(session && { Authorization: `Bearer ${session.token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(signal && { signal }),
    cache: "no-store",
    redirect: "error",
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new PocketError(
      data.error ?? "Pocket could not reach the daemon.",
      response.status,
    );
  return data;
}

export function Pocket({
  invitation,
}: {
  invitation: string | null;
}): React.JSX.Element {
  const [session, setSession] = useState(() => {
    try {
      return readPocketSession(sessionStorage.getItem(POCKET_SESSION));
    } catch {
      return null;
    }
  });
  const [name, setName] = useState("My phone");
  const [pair, setPair] = useState(invitation);
  const [standbys, setStandbys] = useState<PocketStandby[]>([]);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(false);
  const seen = useRef<string[]>([]);
  const alertsOn = useRef(false);
  const [refresh, setRefresh] = useState(0);

  const remember = (next: PocketSession | null) => {
    try {
      if (next) sessionStorage.setItem(POCKET_SESSION, JSON.stringify(next));
      else sessionStorage.removeItem(POCKET_SESSION);
    } catch {
      /* An ephemeral session still works when browser storage is disabled. */
    }
    setSession(next);
    setStandbys([]);
    setConnected(false);
    seen.current = [];
  };

  useEffect(() => {
    if (!session || pair) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const data = await call<{ standbys: PocketStandby[] }>(
          "/standbys",
          session,
          undefined,
          "GET",
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const arrived = newStandbys(seen.current, data.standbys);
        seen.current = data.standbys.map((s) => s.id);
        setStandbys(data.standbys);
        setConnected(true);
        setError("");
        if (alertsOn.current && arrived.length > 0) {
          navigator.vibrate?.([160, 80, 160]);
          // Generic notification text keeps a lock screen from displaying project material.
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          )
            try {
              new Notification("Cuesheet is waiting", {
                body: "Open Pocket to review a standby.",
                tag: "cuesheet-standby",
              });
            } catch {
              /* Some mobile browsers permit notifications only from a service worker. */
            }
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setConnected(false);
        setError(
          cause instanceof Error ? cause.message : "Could not read standbys.",
        );
        if (cause instanceof PocketError && cause.status === 401) {
          remember(null);
          return;
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void read(), 3000);
    };
    void read();
    const visible = () => {
      if (document.visibilityState === "visible") setRefresh((n) => n + 1);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [session, pair, refresh]);

  const answer = async (standby: PocketStandby, value: "go" | "no") => {
    setBusy(standby.id);
    setError("");
    try {
      await call(
        `/standbys/${encodeURIComponent(standby.id)}`,
        session,
        { answer: value },
        "POST",
      );
      setStandbys((current) => current.filter((s) => s.id !== standby.id));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The answer could not be sent.",
      );
    } finally {
      setBusy(null);
      setRefresh((n) => n + 1);
    }
  };

  return (
    <main className="pocket-page">
      <header className="pocket-head">
        <span className="brand">CUESHEET</span>
        <span>Pocket</span>
      </header>
      {error && (
        <p role="alert" className="pocket-error">
          {error}
        </p>
      )}
      {pair ? (
        <form
          className="pocket-card"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy("pair");
            setError("");
            void call<PocketSession>(
              "/pair",
              null,
              { token: pair, name },
              "POST",
            )
              .then((next) => {
                remember(next);
                setPair(null);
              })
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : "Could not pair.",
                ),
              )
              .finally(() => setBusy(null));
          }}
        >
          <h1>Pair this phone</h1>
          <p>
            Review pending questions across your projects and answer GO or NO.
            Access expires after 24 hours.
          </p>
          <label>
            Phone name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoComplete="off"
            />
          </label>
          <button className="primary" disabled={busy !== null} type="submit">
            {busy ? "Pairing…" : "Pair phone"}
          </button>
        </form>
      ) : session ? (
        <>
          <div className="pocket-status" role="status">
            {connected
              ? "Connected · refreshes every 3 seconds"
              : "Connecting · keep this page open"}
          </div>
          <h1>
            Waiting on you <span className="hint">{standbys.length}</span>
          </h1>
          {!connected && <p>Answers are available after Pocket reconnects.</p>}
          {connected && standbys.length === 0 && (
            <div className="pocket-card">
              <h2>No pending questions</h2>
              <p>New questions will appear here.</p>
            </div>
          )}
          {standbys.map((s) => (
            <article className="pocket-card" key={s.id}>
              <p className="hint">
                {s.project}
                {s.station && ` · ${s.station}`} ·{" "}
                {new Date(s.at).toLocaleTimeString()}
              </p>
              <h2>
                {s.kind === "hold" ? "Gate held this run" : "Permission needed"}
              </h2>
              <p className="pocket-ask">{s.ask}</p>
              <p className="hint">
                Run {s.runId}. Open the Desk for the full findings and diff.
              </p>
              <div className="pocket-actions">
                <button
                  type="button"
                  disabled={!connected || busy !== null}
                  onClick={() => void answer(s, "no")}
                >
                  NO · {s.kind === "hold" ? "keep held" : "deny"}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!connected || busy !== null}
                  onClick={() => void answer(s, "go")}
                >
                  GO · {s.kind === "hold" ? "override" : "allow"}
                </button>
              </div>
            </article>
          ))}
          <div className="pocket-tools">
            <button type="button" onClick={() => setRefresh((n) => n + 1)}>
              Refresh
            </button>
            <button
              type="button"
              aria-pressed={alerts}
              onClick={() => {
                alertsOn.current = !alerts;
                setAlerts(!alerts);
                if (
                  !alerts &&
                  typeof Notification !== "undefined" &&
                  Notification.permission === "default"
                )
                  void Notification.requestPermission();
              }}
            >
              {alerts ? "Alerts on" : "Enable alerts"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setBusy("forget");
                void call("/session", session, undefined, "DELETE")
                  .then(() => remember(null))
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not disconnect.",
                    ),
                  )
                  .finally(() => setBusy(null));
              }}
            >
              Disconnect phone
            </button>
          </div>
          <p className="hint">
            {session.name} · access expires{" "}
            {new Date(session.expiresAt).toLocaleString()}. Alerts require this
            page to stay open; browsers may pause it in the background.
          </p>
        </>
      ) : (
        <div className="pocket-card">
          <h1>Connect your phone</h1>
          <p>
            In the local Desk, open Pocket and scan its pairing QR. Connect this
            phone to the same Tailscale network first.
          </p>
        </div>
      )}
    </main>
  );
}
