import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PocketInvitation, PocketStatus } from "@cuesheet/core";
import { apiUrl } from "../api/base.js";
import { useModal } from "../hooks/useModal.js";

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(apiUrl(`/pocket${path}`), {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method !== "GET" && { body: JSON.stringify(body ?? {}) }),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Could not update Pocket.");
  return value;
}

export function PocketPanel({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const modal = useModal(onClose);
  const [status, setStatus] = useState<PocketStatus | null>(null);
  const [origin, setOrigin] = useState("");
  const [invite, setInvite] = useState<PocketInvitation | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let stopped = false;
    const read = () =>
      void request<PocketStatus>("/settings")
        .then((next) => {
          if (!stopped) {
            setStatus(next);
            setOrigin((current) => current || next.origin || "");
          }
        })
        .catch((cause: unknown) => {
          if (!stopped)
            setError(
              cause instanceof Error
                ? cause.message
                : "Pocket could not be read.",
            );
        });
    read();
    const timer = setInterval(read, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearInterval(tick);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    setQr("");
    if (invite)
      void QRCode.toDataURL(invite.url, {
        width: 280,
        margin: 4,
        errorCorrectionLevel: "M",
      })
        .then((url) => {
          if (!stopped) setQr(url);
        })
        .catch(() => {
          if (!stopped)
            setError("Could not draw the pairing QR. Generate a new one.");
        });
    return () => {
      stopped = true;
    };
  }, [invite]);
  const act = (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void work()
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : "Could not update Pocket.",
        ),
      )
      .finally(() => setBusy(false));
  };
  const liveInvite = invite !== null && Date.parse(invite.expiresAt) > now;
  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        {...modal}
        className="modal pocket-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Pocket phone pairing"
      >
        <header>Pocket · phone pairing</header>
        <div className="body">
          <p>
            Connect your computer and phone to the same Tailscale network.
            Tailscale Serve provides Pocket’s private HTTPS address.
          </p>
          {!status?.enabled && (
            <>
              <p>On this computer, run:</p>
              <pre>tailscale serve --bg --https=443 http://127.0.0.1:7374</pre>
              <p>Copy the HTTPS address it prints below, then enable Pocket.</p>
            </>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              act(async () => {
                const next = await request<PocketStatus>("/settings", "POST", {
                  origin,
                });
                setStatus(next);
                setInvite(null);
              });
            }}
          >
            <label>
              Tailscale HTTPS address
              <input
                type="url"
                placeholder="https://computer.tail123.ts.net"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              disabled={
                busy ||
                status === null ||
                (status.enabled && status.origin === origin)
              }
            >
              {status?.enabled
                ? "Change address and revoke devices"
                : "Enable Pocket"}
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          {status?.error && <p role="alert">{status.error}</p>}
          {status?.enabled && (
            <>
              <p>On this computer, run:</p>
              <pre>
                tailscale serve --bg --https=
                {new URL(status.origin ?? "https://computer.tail123.ts.net")
                  .port || "443"}{" "}
                http://127.0.0.1:{status.port}
              </pre>
              <p>
                Use the HTTPS address that command prints above. Pocket exposes
                pending questions and GO/NO answers. Sessions expire after 24
                hours.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    setInvite(
                      await request<PocketInvitation>("/invitation", "POST"),
                    );
                    setNow(Date.now());
                  })
                }
              >
                Generate pairing QR
              </button>
              {invite && (
                <div className="pocket-qr">
                  {liveInvite && qr ? (
                    <img
                      src={qr}
                      width="280"
                      height="280"
                      alt="Scan to pair this phone with Pocket"
                    />
                  ) : (
                    <p>Pairing QR expired. Generate a new one.</p>
                  )}
                  {liveInvite && (
                    <p>
                      Scan with your phone’s camera. Expires in{" "}
                      {Math.max(
                        0,
                        Math.ceil((Date.parse(invite.expiresAt) - now) / 1000),
                      )}{" "}
                      seconds; usable once.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await request("/invitation", "DELETE");
                        setInvite(null);
                      })
                    }
                  >
                    Cancel pairing link
                  </button>
                </div>
              )}
              <h2>Connected devices</h2>
              {status.devices.length === 0 ? (
                <p>No paired devices.</p>
              ) : (
                <ul className="pocket-devices">
                  {status.devices.map((device) => (
                    <li key={device.id}>
                      <span>
                        {device.name} · expires{" "}
                        {new Date(device.expiresAt).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          act(async () =>
                            setStatus(
                              await request<PocketStatus>(
                                `/devices/${device.id}`,
                                "DELETE",
                              ),
                            ),
                          )
                        }
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    setStatus(
                      await request<PocketStatus>("/settings", "DELETE"),
                    );
                    setInvite(null);
                  })
                }
              >
                Disable Pocket and revoke all devices
              </button>
            </>
          )}
        </div>
        <footer>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
