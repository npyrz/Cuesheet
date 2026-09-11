/**
 * `⌘K` / `Ctrl+K`.
 *
 * Step 19 asks only that it can start a run. It is a prompt box with a short
 * list of commands under it: typing text and pressing Enter starts a run,
 * which is the path that has to be fast.
 */
import { useEffect, useRef, useState } from "react";
import { modifierKey } from "../format.js";

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

export function CommandPalette({
  open,
  onClose,
  onStart,
  commands,
  canStart,
}: CommandPaletteProps): React.JSX.Element | null {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      input.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const matches = visibleCommands(commands, text);

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
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <input
          ref={input}
          className="palette-input"
          placeholder={
            canStart
              ? "Type a prompt and press Enter, or pick a command…"
              : "Add a Station first — there is nothing to run against."
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          aria-label="Prompt or command"
        />
        <div className="body">
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
          {matches.map((command) => {
            const blocked =
              command.needsPrompt === true && (text.trim() === "" || !canStart);
            return (
              <button
                key={command.id}
                type="button"
                disabled={blocked}
                title={
                  blocked ? "Type a prompt first — a cuesheet needs one." : ""
                }
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
            {modifierKey()}K to open · Esc to close · Enter to run
          </span>
        </footer>
      </div>
    </div>
  );
}
