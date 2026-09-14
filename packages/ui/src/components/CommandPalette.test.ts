import { describe, expect, it } from "vitest";
import { visibleCommands, type Command } from "./CommandPalette.js";

function command(id: string, label: string, needsPrompt = false): Command {
  return {
    id,
    label,
    run: () => undefined,
    ...(needsPrompt && { needsPrompt }),
  };
}

const COMMANDS: Command[] = [
  command("add-station", "Add a Station…"),
  command("stop", "Stop the current run"),
  command("cuesheet-ship", "Run the “ship” cuesheet — gate: default", true),
];

describe("visibleCommands", () => {
  it("shows everything when nothing is typed", () => {
    expect(visibleCommands(COMMANDS, "").map((c) => c.id)).toEqual([
      "add-station",
      "stop",
      "cuesheet-ship",
    ]);
  });

  it("keeps a prompt-taking command visible while a prompt is typed", () => {
    // The catch-22 this exists to break: running a cuesheet needs a prompt,
    // and typing the prompt used to filter the cuesheet out of the list. Found
    // by trying to start a gated run from the Desk and having nothing to click.
    const visible = visibleCommands(COMMANDS, "add rate limiting to uploads");
    expect(visible.map((c) => c.id)).toEqual(["cuesheet-ship"]);
  });

  it("still filters ordinary commands by label", () => {
    expect(visibleCommands(COMMANDS, "stop").map((c) => c.id)).toEqual([
      "stop",
      // The cuesheet stays: the text could be a prompt, and it is the command
      // that would act on it.
      "cuesheet-ship",
    ]);
  });

  it("matches labels case-insensitively and ignores surrounding space", () => {
    expect(
      visibleCommands(COMMANDS, "  ADD A STATION ").map((c) => c.id),
    ).toEqual(["add-station", "cuesheet-ship"]);
  });
});
