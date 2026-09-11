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
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onStart: (prompt: string) => void;
  commands: Command[];
  /** Disabled with a reason when there is no Station to run against. */
  canStart: boolean;
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

  const matches = commands.filter((command) =>
    command.label.toLowerCase().includes(text.trim().toLowerCase()),
  );

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
          {matches.map((command) => (
            <button
              key={command.id}
              type="button"
              onClick={() => {
                command.run();
                onClose();
              }}
            >
              {command.label}
            </button>
          ))}
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
