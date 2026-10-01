import { useEffect, useState } from "react";
import { apiUrl } from "../api/base.js";
import { useModal } from "../hooks/useModal.js";

interface Status {
  phase: string;
  message?: string;
  version?: string;
  checkout?: string;
  command?: string;
}

export function UpdatesPanel({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const modal = useModal(onClose);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const response = await fetch(apiUrl("/updates"), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Could not read update status.");
      const next = (await response.json()) as Status;
      if (controller.signal.aborted) return;
      setStatus(next);
      if (next.phase === "checking" || next.phase === "downloading")
        timer = setTimeout(() => void read().catch(fail), 1000);
    };
    const fail = (cause: unknown) => {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not check for updates.",
        );
    };
    setError("");
    void (async () => {
      const response = await fetch(apiUrl("/updates/check"), {
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 409)
        throw new Error("Could not start the release check.");
      await read();
    })().catch(fail);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt]);
  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        {...modal}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Cuesheet updates"
      >
        <header>Cuesheet updates</header>
        <div className="body">
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            <p role="status">
              {status?.message ?? "Checking GitHub releases…"}
            </p>
          )}
          {status?.phase === "available" && (
            <>
              <p>
                Release: <code>{status.version}</code>
              </p>
              <p>
                In <code>{status.checkout}</code>, after stopping Cuesheet:
              </p>
              <pre>{status.command}</pre>
              <p>
                Restart the app or daemon when the build finishes. Your projects
                and run history remain in their existing location.
              </p>
            </>
          )}
          {status?.phase === "ready" && (
            <p>
              Use the desktop app’s Check for updates menu to confirm restart
              and installation.
            </p>
          )}
        </div>
        <footer>
          <button
            type="button"
            disabled={status?.phase === "checking"}
            onClick={() => setAttempt((n) => n + 1)}
          >
            check again
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            close
          </button>
        </footer>
      </div>
    </div>
  );
}
