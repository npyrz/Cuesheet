/**
 * Moving around without a mouse.
 *
 * The index arithmetic only, because that is the half that is wrong in
 * practice and the half a DOM-less test can reach. Which element is focused
 * is the hook's problem; *which one should be* is decided here.
 *
 * Step 44's done-when is that the whole app is operable from the keyboard,
 * and the surfaces this app is made of are lists: runs, projects, commands,
 * harnesses, findings. A list you can only reach by tabbing through every row
 * is technically operable and practically not — thirty runs between the run
 * list and the pane beside it is thirty presses to get past something you were
 * not reading.
 */

/** A list that answers to the arrow keys. */
export interface Roving {
  /** How many rows there are. */
  count: number;
  /** Which row is current, or -1 for none. */
  current: number;
}

/**
 * Where an arrow key moves within a list, or `null` if it is not one of ours.
 *
 * `null` rather than "stay put" so the caller knows whether to swallow the
 * event: a component that preventDefaults every keystroke breaks typing in
 * the box above the list, and one that preventDefaults none of them lets
 * ArrowDown scroll the page out from under the selection.
 *
 * **Wrapping, not clamping.** These lists are short and closed, and a wrap is
 * how every command palette anybody has used behaves. Clamping at the ends
 * reads as the key having stopped working.
 *
 * **Home and End**, because a run list holds fifty rows and the newest and the
 * oldest are the two anybody actually wants.
 */
export function rove(key: string, list: Roving): number | null {
  if (list.count <= 0) return null;
  const { count, current } = list;
  switch (key) {
    case "ArrowDown":
      // From nothing, down goes to the first row rather than the second —
      // which is what `current + 1` gives when `current` is -1, and is the
      // reason this is not one line.
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Where Tab goes inside a modal, as an index into its focusable elements.
 *
 * A trap rather than the browser's own order, because `role="dialog"` with
 * `aria-modal` tells a screen reader the rest of the page is inert and does
 * nothing whatever to the tab order. Without this, the third Tab out of the
 * Add-a-Station panel lands on the Stop button of a live run behind the scrim
 * — reachable, invisible, and one Enter away.
 *
 * `current` of -1 means focus is somewhere outside the trap, which is what a
 * click on the scrim leaves behind: Tab from there enters at the top, and
 * Shift+Tab at the bottom.
 */
export function trapIndex(
  key: string,
  shift: boolean,
  list: Roving,
): number | null {
  if (key !== "Tab" || list.count <= 0) return null;
  const { count, current } = list;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * Whether a keystroke means "put this away".
 *
 * One spelling, in one place. Escape is the only dismissal this app has and
 * every modal was writing its own check for it — which is how `LedgerPanel`
 * ended up with an `onKeyDown` on an element nothing ever focused, listening
 * for a key that could therefore never reach it.
 */
export function isDismiss(key: string): boolean {
  return key === "Escape" || key === "Esc";
}

/**
 * Whether a keystroke should act on the highlighted row.
 *
 * Space as well as Enter, because these lists are made of buttons and a
 * button answers to both — a roving list that answered only to Enter would
 * behave differently from the same row reached by Tab.
 */
export function isActivate(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}
