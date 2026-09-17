import { describe, expect, it } from "vitest";
import {
  parseActiveProject,
  trayProjectLabel,
  trayTooltip,
  windowTitle,
  type ActiveProject,
} from "./project.js";

const api: ActiveProject = {
  id: "a1",
  name: "api",
  root: "/Users/noah/code/api",
};

describe("parseActiveProject", () => {
  it("accepts the shape the bridge sends", () => {
    expect(parseActiveProject({ ...api })).toEqual(api);
  });

  it("reads null as nothing open", () => {
    expect(parseActiveProject(null)).toBeNull();
  });

  it("refuses a payload missing a field rather than titling it undefined", () => {
    expect(parseActiveProject({ id: "a1", name: "api" })).toBeNull();
    expect(parseActiveProject({ id: "a1", root: "/x" })).toBeNull();
    expect(parseActiveProject({ name: "api", root: "/x" })).toBeNull();
  });

  it("refuses the wrong types and the empty string", () => {
    expect(parseActiveProject({ id: 1, name: "api", root: "/x" })).toBeNull();
    expect(parseActiveProject({ id: "a1", name: "", root: "/x" })).toBeNull();
    expect(parseActiveProject("api")).toBeNull();
    expect(parseActiveProject(undefined)).toBeNull();
  });

  it("refuses a name carrying a newline", () => {
    // A title bar and a tray menu have one line each. A project folder can be
    // named anything the filesystem allows, and this is the message that comes
    // *into* the main process.
    expect(
      parseActiveProject({ id: "a1", name: "api\nrm -rf", root: "/x" }),
    ).toBeNull();
  });

  it("truncates a name too long to be a title", () => {
    const long = "x".repeat(500);
    expect(
      parseActiveProject({ id: "a1", name: long, root: "/x" })?.name,
    ).toHaveLength(120);
  });
});

describe("windowTitle", () => {
  it("puts the project first, because titles truncate from the end", () => {
    expect(windowTitle(api)).toBe("api — Cuesheet");
  });

  it("is just the app when nothing is open", () => {
    // The launch surface. A title still naming the last project would
    // advertise one the window is not showing.
    expect(windowTitle(null)).toBe("Cuesheet");
  });
});

describe("trayTooltip", () => {
  it("answers both questions a hover is asking", () => {
    expect(trayTooltip(api, 7373)).toBe("api — daemon on 127.0.0.1:7373");
  });

  it("keeps the port when no project is open", () => {
    expect(trayTooltip(null, 7373)).toBe("Cuesheet — daemon on 127.0.0.1:7373");
  });
});

describe("trayProjectLabel", () => {
  it("shows the root, which is what tells two checkouts apart", () => {
    expect(trayProjectLabel(api)).toBe("/Users/noah/code/api");
  });

  it("says so plainly when there is no project", () => {
    expect(trayProjectLabel(null)).toBe("No project open");
  });
});
