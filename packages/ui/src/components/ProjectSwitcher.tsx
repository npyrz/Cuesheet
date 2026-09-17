/**
 * The switcher, and the only control in the shell that is always there.
 *
 * Thin, like every other component here: what a row *says* — its order, its
 * reason for being inert — is decided in `../switcher.ts`, where a test can
 * reach it. What is here is markup, a popover, and the focus handling that
 * makes it reachable without a mouse.
 *
 * It replaces Step 34's `<select>`, which was explicitly a placeholder. A
 * native select cannot show a row's *reason* — a missing folder was an option
 * reading "(missing)" with nowhere to say more — and it is not where anybody
 * looks for the project they have open, because it looks like a form field.
 *
 * The palette is the other half of this, and the more important one: `⌘K`,
 * type a name, Enter. Everything in this menu is also a command, because
 * "switching is possible from anywhere" has to survive a modal being open and
 * a hand never leaving the keyboard.
 */
import { useEffect, useRef, useState } from "react";
import type { SwitcherRow } from "../switcher.js";
import { isDismiss, rove } from "../keys.js";

export interface ProjectSwitcherProps {
  rows: SwitcherRow[];
  /** The open project, for the closed state of the button. */
  activeName: string;
  activeRoot: string;
  onSwitch: (id: string) => void;
  /** Back to the launch surface. Nothing on the daemon stops. */
  onClose: () => void;
  /** Electron only — the same picker the launch surface uses. */
  chooseDirectory?: (() => Promise<string | null>) | undefined;
  onOpen: (root: string) => void;
}

export function ProjectSwitcher({
  rows,
  activeName,
  activeRoot,
  onSwitch,
  onClose,
  chooseDirectory,
  onOpen,
}: ProjectSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Focus moves into the menu on open and back to the trigger on close.
  // Without the second half, dismissing with Escape drops focus onto the
  // document and the next Tab starts from the top of the page.
  //
  // `:not(:disabled)`, and it is not a nicety: the first row is usually the
  // project you are already on, which is disabled, and a disabled button
  // cannot take focus — so the obvious version left focus on the trigger and
  // the menu was openable by keyboard but not usable by one.
  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [open]);

  const dismiss = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  /**
   * The arrows walk the menu — the behaviour `role="menu"` promises.
   *
   * It was Tab-only, which is the gap that makes a menu technically operable
   * and practically not: the rows a menu is made of are the rows a keyboard
   * user wants to step through, and Tab steps through the whole document.
   * Disabled rows — the project you are on, a folder that has moved — are not
   * in the list, because focus cannot land on them.
   */
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isDismiss(event.key)) {
      dismiss();
      return;
    }
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    const next = rove(event.key, {
      count: items.length,
      current: items.indexOf(document.activeElement as HTMLButtonElement),
    });
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="switcher">
      <button
        ref={trigger}
        type="button"
        className="switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeRoot}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          // Down opens it, which is what a menu button does everywhere else.
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="switcher-name">{activeName}</span>
        <span className="switcher-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          {/*
            A click anywhere else closes it. `mousedown` rather than `click`,
            so pressing a button underneath does not first dismiss the menu and
            then miss the target it was aimed at.
          */}
          <div
            className="switcher-scrim"
            onMouseDown={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={menu}
            className="switcher-menu"
            role="menu"
            aria-label="Projects"
            onKeyDown={onMenuKey}
          >
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                className="switcher-item"
                data-active={row.active}
                // Two different reasons to be inert, and they are not the same
                // thing: you cannot switch to where you already are, and you
                // cannot open a folder that is not there. The row says which.
                disabled={row.active || !row.openable}
                title={row.root}
                onClick={() => {
                  setOpen(false);
                  onSwitch(row.id);
                }}
              >
                <span className="switcher-item-name">{row.name}</span>
                <span className="switcher-item-when">
                  {row.active ? "open" : row.when}
                </span>
                <span className="switcher-item-where">{row.where}</span>
                {/*
                  A line of its own, spanning the row. It was in the right-hand
                  column first, where a sentence crushed the path it was
                  explaining into three characters — a row that is hard to read
                  is a poor way to say a folder is missing.
                */}
                {row.problem !== null && (
                  <span className="switcher-item-problem">{row.problem}</span>
                )}
              </button>
            ))}

            <div className="switcher-actions">
              {chooseDirectory && (
                <button
                  type="button"
                  role="menuitem"
                  className="ghost"
                  onClick={() => {
                    setOpen(false);
                    void chooseDirectory().then((picked) => {
                      if (picked !== null) onOpen(picked);
                    });
                  }}
                >
                  Open a folder…
                </button>
              )}
              {/*
                The way back Step 40 said this step owed it. Worth its own
                entry rather than being implied by the list: a project stays
                open on the daemon when you leave it, and a menu item that says
                so is cheaper than finding out.
              */}
              <button
                type="button"
                role="menuitem"
                className="ghost"
                onClick={() => {
                  setOpen(false);
                  onClose();
                }}
                title="Nothing stops. Runs in this project keep going."
              >
                All projects…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
