/**
 * What every modal in this app owes the keyboard.
 *
 * Three panels — the palette, Add-a-Station, the ledger — each wrote their own
 * half of this, and between them they had one and a half. All three listened
 * for Escape on the dialog element; only the palette ever focused anything
 * inside it, so in the other two the key had nowhere to land. None of them
 * trapped Tab, which means the third press out of Add-a-Station reached the
 * **stop** button of a live run behind the scrim: reachable, invisible, and
 * one Enter away. And none of them gave focus back, so dismissing a panel
 * dropped the caret on `<body>` and the next Tab started from the top of the
 * page.
 *
 * The index arithmetic is in `../keys.ts` where a test can reach it. What is
 * here is the DOM: which elements count, and where focus goes.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { isDismiss, trapIndex } from "../keys.js";

/**
 * Everything that can hold focus, in document order.
 *
 * `:not(:disabled)` matters more than it looks: the switcher's first row is
 * usually the project you are already on, which is disabled, and the ledger's
 * close button is the only thing in an empty ledger. A trap built on a list
 * that includes disabled elements sends focus to something that cannot take
 * it, and the browser puts it on `<body>` instead — which is the bug this
 * exists to fix, arrived at from the other direction.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalKeyboard {
  /** Put this on the dialog element. It is also given `tabIndex={-1}`. */
  ref: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent) => void;
  tabIndex: -1;
}

/**
 * Focus in on open, trapped while open, and back where it came from on close.
 *
 * `autoFocus` is deliberately not a parameter. The palette wants its input
 * focused and does that itself, because the box is the point of the palette;
 * everything else wants the first control, which is what this does when
 * nothing inside has taken focus already.
 */
export function useModal(onClose: () => void): ModalKeyboard {
  const ref = useRef<HTMLDivElement | null>(null);
  /** Where focus was before this opened. Restored on the way out. */
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const node = ref.current;
    // A tick, not immediately: a panel whose first control renders on the
    // back of a fetch — the harness list, the ledger's table — has nothing to
    // focus on the first paint, and focusing the dialog itself is the right
    // answer then rather than a worse one now.
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();

    return () => {
      // Only if focus is still ours. A panel that closes because somebody
      // clicked something else must not yank the caret back off it.
      const inside = node !== null && node.contains(document.activeElement);
      if (!inside) return;
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (isDismiss(event.key)) {
        event.stopPropagation();
        onClose();
        return;
      }
      const node = ref.current;
      if (node === null) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const next = trapIndex(event.key, event.shiftKey, {
        count: items.length,
        current: items.indexOf(document.activeElement as HTMLElement),
      });
      if (next === null) return;
      event.preventDefault();
      items[next]?.focus();
    },
    [onClose],
  );

  return { ref, onKeyDown, tabIndex: -1 };
}
