/**
 * What the shell knows about the project the Desk is showing.
 *
 * Step 41's second done-when: the window title and the tray reflect the active
 * project. The Desk is the only thing that knows which one that is — the
 * daemon deliberately has no notion of a current project (Phase 8), and two
 * windows on two projects is what that decision is for — so the answer arrives
 * over IPC from the renderer.
 *
 * Which is why `parseActiveProject` exists and why it is strict. Everything
 * else crossing this bridge goes renderer-ward; this is the one message coming
 * the other way, and a main process that trusts a renderer's object shape is
 * how a title bar ends up rendering `[object Object]` in the best case. Pure
 * and tested for the same reason `summary.ts` is: it runs inside an IPC
 * handler, where a throw is swallowed and the symptom is a title that simply
 * never changes.
 */

/** The shape `window.cuesheet.setActiveProject` sends. */
export interface ActiveProject {
  id: string;
  name: string;
  root: string;
}

/** How long a name may be before the title bar stops being a title bar. */
const MAX_NAME = 120;

/**
 * The payload, or `null` for "nothing is open" — which is also the answer for
 * anything malformed. There is no error branch on purpose: the failure mode
 * worth avoiding is a shell that believes a project is open when the Desk has
 * moved on, and "no project" is the state that is always safe to be wrong
 * about, because the next switch corrects it.
 */
export function parseActiveProject(payload: unknown): ActiveProject | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  const { id, name, root } = candidate;
  if (typeof id !== "string" || id === "") return null;
  if (typeof name !== "string" || name === "") return null;
  if (typeof root !== "string" || root === "") return null;
  // Control characters, newlines included: a name is drawn into a title bar
  // and a tray menu, neither of which has a second line to put one on. Written
  // as a scan rather than a character class, because the lint rule against
  // control characters in a pattern is a good rule — the usual way one gets
  // into a regex is by accident.
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return { id, name: name.slice(0, MAX_NAME), root };
}

/**
 * The window title.
 *
 * Project first, app second — the reverse of what the app called itself
 * before this step. A window list, a dock preview and a `⌘`-Tab card all
 * truncate from the end, and with "Cuesheet" leading, three windows on three
 * projects are three identical entries.
 */
export function windowTitle(project: ActiveProject | null): string {
  return project === null ? "Cuesheet" : `${project.name} — Cuesheet`;
}

/**
 * The tray tooltip, which answers two different questions at once: which
 * project, and is the daemon actually up. The port was already here and is
 * kept — "is the thing even running" is the reason somebody hovers a tray
 * icon, and the project is what they need to know next.
 */
export function trayTooltip(
  project: ActiveProject | null,
  port: number,
): string {
  const where = `daemon on 127.0.0.1:${String(port)}`;
  return project === null
    ? `Cuesheet — ${where}`
    : `${project.name} — ${where}`;
}

/**
 * The disabled first line of the tray menu.
 *
 * The full root rather than the name, because the menu has the width for it
 * and because this is the one place that can answer "*which* api?" without
 * making somebody open a window to find out.
 */
export function trayProjectLabel(project: ActiveProject | null): string {
  return project === null ? "No project open" : project.root;
}
