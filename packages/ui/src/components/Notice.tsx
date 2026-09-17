/**
 * The one way this app says "nothing yet", "nothing here", or "nothing
 * worked".
 *
 * One component rather than a paragraph per surface, because the three states
 * are the places a UI drifts fastest — nobody screenshots an empty ledger, so
 * nobody notices that it whispers where the run list shouts. What each of
 * them *says* is in `../surface.ts`, where a test can read all of it at once;
 * what is here is how it looks and what it announces.
 *
 * **`role` is chosen by kind, and it is the only reason this is not a `<p>`.**
 * These states replace each other while somebody is looking elsewhere — a
 * fetch lands, a daemon drops — and a screen reader that is told nothing
 * leaves them on a screen that has changed under them. An error is an
 * `alert`, which interrupts; the other two are a polite `status`, which does
 * not. Getting that the wrong way round is how a UI becomes unusable with
 * assistive tech switched on while looking perfectly fine.
 */
import type { SurfaceState } from "../surface.js";

export interface NoticeProps {
  state: SurfaceState;
  /** Runs the state's own action — "Add a Station", and nothing else so far. */
  onAction?: (() => void) | undefined;
  /** Offered on an error, and only when the caller can actually retry. */
  onRetry?: (() => void) | undefined;
}

export function Notice({
  state,
  onAction,
  onRetry,
}: NoticeProps): React.JSX.Element {
  return (
    <div
      className="notice"
      data-kind={state.kind}
      role={state.kind === "error" ? "alert" : "status"}
    >
      {/* The spinner is a glyph and a class, not an element: it is decorative,
          and a screen reader reading "hourglass" before the sentence that says
          what is loading is worse than silence. */}
      <p className="notice-title">
        {state.kind === "loading" && (
          <span className="notice-spin" aria-hidden="true" />
        )}
        {state.title}
      </p>
      {state.detail !== null && <p className="notice-detail">{state.detail}</p>}
      {state.action !== null && onAction && (
        <button type="button" className="primary" onClick={onAction}>
          {state.action}
        </button>
      )}
      {state.retry && onRetry && (
        <button type="button" onClick={onRetry}>
          try again
        </button>
      )}
    </div>
  );
}
