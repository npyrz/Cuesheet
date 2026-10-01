import { useEffect, useState } from "react";
import { apiUrl } from "../api/base.js";
import { useModal } from "../hooks/useModal.js";

export function DiagnosticsPanel({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const modal = useModal(onClose);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [path, setPath] = useState("");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setReport("");
    setCopied(false);
    setCopyError("");
    void (async () => {
      const info = await fetch(apiUrl("/diagnostics"), {
        signal: controller.signal,
      });
      if (!info.ok) throw new Error("Could not locate local diagnostics.");
      const metadata = (await info.json()) as { path: string };
      const response = await fetch(apiUrl("/diagnostics/report"), {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          "Local diagnostics unavailable. Check disk space and permissions.",
        );
      const text = await response.text();
      if (!controller.signal.aborted) {
        setPath(metadata.path);
        setReport(text);
      }
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read diagnostics.",
        );
    });
    return () => controller.abort();
  }, [attempt]);
  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError(
        "Clipboard unavailable. Download the report or select and copy the text.",
      );
    }
  }
  function download(): void {
    const url = URL.createObjectURL(
      new Blob([report], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cuesheet-diagnostics.txt";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Let the browser consume the URL before releasing its backing bytes.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        {...modal}
        className="modal diagnostics"
        role="dialog"
        aria-modal="true"
        aria-label="Local diagnostics"
      >
        <header>Local diagnostics</header>
        <div className="body">
          <p>
            Review this report before attaching it to an issue. Cuesheet uploads
            nothing.
          </p>
          <p>
            Prompts, source, diffs, credentials and error messages are omitted.
            Project and Station identifiers are hashed.
          </p>
          {path && (
            <p>
              Local log: <code className="diagnostics-path">{path}</code>
            </p>
          )}
          {error ? (
            <p role="alert">
              {error}{" "}
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                retry
              </button>
            </p>
          ) : report ? (
            <textarea
              aria-label="Diagnostic report"
              readOnly
              value={report}
              rows={10}
              className="diagnostics-report"
            />
          ) : (
            <p role="status">Reading local diagnostics…</p>
          )}
        </div>
        {copyError && (
          <p className="diagnostics-copy-error" role="alert">
            {copyError}
          </p>
        )}
        <footer>
          <button type="button" disabled={!report} onClick={() => void copy()}>
            {copied ? "copied" : "copy report"}
          </button>
          <button type="button" disabled={!report} onClick={download}>
            download report
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
