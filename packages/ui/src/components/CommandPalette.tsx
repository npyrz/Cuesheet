/**
 * `⌘K` / `Ctrl+K`.
 *
 * Step 19 asks only that it can start a run. It is a prompt box with a short
 * list of commands under it: typing text and pressing Enter starts a run,
 * which is the path that has to be fast.
 */
import { useEffect, useRef, useState } from "react";
import { shortcutHint } from "../format.js";
import { useModal } from "../hooks/useModal.js";
import { isActivate, rove } from "../keys.js";

export interface Command {
  id: string;
  label: string;
  /**
   * Given whatever is typed in the box.
   *
   * Most commands ignore it. "Run the ship cuesheet" does not: it is the same
   * prompt the Enter key would have sent, aimed at a named cuesheet instead of
   * the default Station — which is how a Gate becomes reachable from the Desk
   * rather than only from `curl`.
   */
  run: (prompt: string) => void;
  /** Greyed out, with the reason, when there is nothing to run it on. */
  needsPrompt?: boolean;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onStart: (prompt: string) => void;
  commands: Command[];
  /** Disabled with a reason when there is no Station to run against. */
  canStart: boolean;
}

/**
 * Which commands the typed text leaves on screen.
 *
 * Typed text filters the commands — except the ones that *act on* the typed
 * text, which stay. Filtering those out was a catch-22 the moment cuesheets
 * became commands: running one needs a prompt, and typing the prompt hid the
 * cuesheet. The box has two jobs, and which one you are doing is decided by
 * what you press, not by what you have typed so far.
 *
 * Exported and pure because it is the only thing standing between the Desk
 * and "Gates exist but you can only reach them with curl".
 */
export function visibleCommands(
  commands: readonly Command[],
  text: string,
): Command[] {
  const query = text.trim().toLowerCase();
  return commands.filter(
    (command) =>
      query === "" ||
      command.needsPrompt === true ||
      command.label.toLowerCase().includes(query),
  );
}

export function CommandPalette(
  props: CommandPaletteProps,
): React.JSX.Element | null {
  // Unmounted while closed, so the trap below mounts and unmounts with the
  // panel rather than having to be told about `open` — which is what makes
  // "focus goes back where it came from" a lifecycle rather than an effect
  // somebody has to remember to write.
  if (!props.open) return null;
  return <Palette {...props} />;
}

function Palette({
  onClose,
  onStart,
  commands,
  canStart,
}: CommandPaletteProps): React.JSX.Element {
  const [text, setText] = useState("");
  /** Which command the arrows are on. -1 is the prompt box itself. */
  const [cursor, setCursor] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const modal = useModal(onClose);

  useEffect(() => {
    // The box, not the first command: typing is what this panel is for, and
    // `useModal` would otherwise have focused whatever renders first.
    input.current?.focus();
  }, []);

  const matches = visibleCommands(commands, text);
  // A filter that shortens the list must not leave the highlight past its end.
  const at = cursor >= matches.length ? -1 : cursor;

  const submit = (): void => {
    const prompt = text.trim();
    if (prompt === "" || !canStart) return;
    onStart(prompt);
    onClose();
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        {...modal}
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/*
          The arrows are handled here rather than on the input, because they
          have to work whether focus is in the box or on a command — and the
          box is where they start. `rove` returns null for every other key, so
          typing is untouched.
        */}
        <input
          ref={input}
          className="palette-input"
          placeholder={
            canStart
              ? "Type a prompt and press Enter, or pick a command…"
              : "Add a Station first — there is nothing to run against."
          }
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(-1);
          }}
          onKeyDown={(event) => {
            const next = rove(event.key, {
              count: matches.length,
              current: at,
            });
            if (next !== null) {
              event.preventDefault();
              setCursor(next);
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            // Enter on a highlighted command runs it; Enter with nothing
            // highlighted starts a run. Same key, and which one it is is
            // visible on screen rather than implied.
            const picked = at >= 0 ? matches[at] : undefined;
            if (picked === undefined) {
              submit();
              return;
            }
            if (
              picked.needsPrompt === true &&
              (text.trim() === "" || !canStart)
            )
              return;
            picked.run(text.trim());
            onClose();
          }}
          aria-label="Prompt or command"
          aria-controls="palette-commands"
          aria-activedescendant={at >= 0 ? `palette-${String(at)}` : undefined}
        />
        <div className="body" id="palette-commands">
          {text.trim() !== "" && (
            <button
              type="button"
              className="primary"
              disabled={!canStart}
              onClick={submit}
            >
              Start a run — “{text.trim()}”
            </button>
          )}
          {matches.map((command, index) => {
            const blocked =
              command.needsPrompt === true && (text.trim() === "" || !canStart);
            return (
              <button
                key={command.id}
                id={`palette-${String(index)}`}
                type="button"
                className="palette-command"
                data-at={index === at}
                disabled={blocked}
                title={
                  blocked ? "Type a prompt first — a cuesheet needs one." : ""
                }
                onKeyDown={(event) => {
                  // Tabbed to rather than arrowed to: the highlight follows,
                  // so the panel never shows two places the keyboard might be.
                  if (isActivate(event.key)) setCursor(index);
                }}
                onFocus={() => setCursor(index)}
                onClick={() => {
                  command.run(text.trim());
                  onClose();
                }}
              >
                {command.label}
              </button>
            );
          })}
          {matches.length === 0 && text.trim() === "" && (
            <p className="hint">No commands.</p>
          )}
        </div>
        <footer>
          <span className="hint">
            {shortcutHint("K")} to open · ↑↓ to choose · Esc to close · Enter to
            run
          </span>
        </footer>
      </div>
    </div>
  );
}
