/**
 * One instruction, for somebody who has not read the README.
 *
 * Step 45. The four moves between a fresh install and a first run are decided
 * in `../firstrun.ts`, where a test can reach the ordering; this draws the
 * current one. Deliberately one at a time — a card listing all four is a card
 * where somebody starts on the wrong one, and three of the four are not yet
 * possible when the first one is.
 *
 * **Every external link is `target="_blank"`, and that is load-bearing rather
 * than habitual.** The shell denies window-opens and hands the URL to the
 * platform browser; a same-window navigation would replace the Desk with
 * claude.com and leave somebody with no visible way back. Step 45 also put a
 * `will-navigate` guard behind this in `main.ts`, because relying on every
 * future author remembering an attribute is not a guard.
 */
import { useState } from "react";
import type { HarnessId } from "@cuesheet/core";
import type { FirstStep, SetupOption } from "../firstrun.js";

export interface FirstRunProps {
  step: FirstStep;
  /** Create the starter Station on this harness. */
  onAdd: (harness: HarnessId) => void;
  /** Start the first run. */
  onRun: (prompt: string) => void;
  /** True while the add is in flight — the button says so rather than lying. */
  busy?: boolean;
  /** The daemon's own words when the add failed. */
  error?: string | null;
}

export function FirstRun({
  step,
  onAdd,
  onRun,
  busy = false,
  error = null,
}: FirstRunProps): React.JSX.Element {
  return (
    <section
      className="firstrun"
      data-step={step.kind}
      aria-label="Getting started"
    >
      <h2 className="firstrun-title">{step.title}</h2>
      <p className="firstrun-detail">{step.detail}</p>

      {(step.kind === "install" || step.kind === "sign-in") && (
        <>
          <ul className="setup-list">
            {step.options.map((option) => (
              <SetupRow key={option.setup.id} option={option} />
            ))}
          </ul>
          {step.demo !== null && (
            <p className="firstrun-demo">
              {/*
                Offered, and never as the answer. `mock` ships so that a
                machine with no CLI can still watch the app move — but a
                button reading "Add a Station" next to three you cannot use
                would read as the setup being finished, which it is not.
              */}
              Nothing to install yet?{" "}
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => onAdd(step.demo as HarnessId)}
              >
                Watch it work with the built-in demo
              </button>{" "}
              — it writes nothing and costs nothing.
            </p>
          )}
        </>
      )}

      {step.kind === "add" && (
        <button
          type="button"
          className="primary firstrun-go"
          disabled={busy}
          onClick={() => onAdd(step.harness)}
        >
          {busy ? "adding…" : step.action}
        </button>
      )}

      {step.kind === "run" && (
        <FirstPrompt placeholder={step.placeholder} onRun={onRun} />
      )}

      {error !== null && error !== "" && (
        <p className="firstrun-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SetupRow({ option }: { option: SetupOption }): React.JSX.Element {
  const { setup } = option;
  return (
    <li
      className="setup-row"
      data-installed={option.installed}
      data-ready={option.installed && option.authed}
    >
      <span className="setup-mark" aria-hidden="true">
        {option.installed && option.authed ? "●" : option.installed ? "◐" : "○"}
      </span>
      <span className="setup-name">{setup.name}</span>
      <span className="setup-what">{setup.what}</span>
      {/*
        The remedy, not the diagnosis. "not installed" is what the row already
        looks like; this is the line that does something about it.
      */}
      <span className="setup-advice">
        {option.advice === null ? (
          "ready"
        ) : option.installed ? (
          <code>{option.advice.replace(/^Run `|`$/g, "")}</code>
        ) : (
          <a href={setup.url} target="_blank" rel="noreferrer">
            {hostOf(setup.url)}
          </a>
        )}
      </span>
    </li>
  );
}

/**
 * The prompt box, on the screen where the first run has to start.
 *
 * The palette is the fast path and stays the fast path; it is also a chord,
 * and a chord is not discoverable by somebody who has not been told about it.
 * This is the same action with a box around it, on the one screen where not
 * finding it means never running anything.
 */
function FirstPrompt({
  placeholder,
  onRun,
}: {
  placeholder: string;
  onRun: (prompt: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const ready = text.trim() !== "";

  return (
    <form
      className="firstrun-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onRun(text.trim());
      }}
    >
      <label className="firstrun-label" htmlFor="first-prompt">
        What should it do?
      </label>
      <input
        id="first-prompt"
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="primary" disabled={!ready}>
        run it
      </button>
    </form>
  );
}

/** `claude.com`, which is what a reader needs off a URL in a sentence. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
