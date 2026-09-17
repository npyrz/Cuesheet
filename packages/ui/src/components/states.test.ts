/**
 * Every surface, in all three of its non-happy states, rendered.
 *
 * The first test in this repo that renders a component. That is a deliberate
 * and narrow exception to the division the rest of the UI keeps — logic in a
 * `.ts` where a test can reach it, `.tsx` as markup and nothing else — and the
 * reason is Step 44's done-when, which is a claim about *surfaces* rather than
 * about a function: "every surface has all three non-happy states." A test of
 * `describeSurface` proves the sentences exist. It cannot prove anybody wired
 * them up, and the bug it is guarding against is precisely the one where a
 * screen keeps its old null check and never asks.
 *
 * `renderToStaticMarkup` rather than a DOM: vitest runs in node here, effects
 * do not run, and none of these states depend on one — every one of them is
 * what the first paint shows. That is exactly the paint in question.
 *
 * What this cannot do is say whether any of it *looks* right. Nothing in this
 * repo can, today. See Step 44's note on what was and was not looked at.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Limits } from "@cuesheet/core";
import { LaunchSurface } from "./LaunchSurface.js";
import { ProjectView } from "./ProjectView.js";
import { RunSurface } from "./RunSurface.js";
import type { Load } from "../surface.js";

const LOADING: Load = { status: "loading" };
const READY: Load = { status: "ready" };
const FAILED: Load = { status: "failed", error: "connect ECONNREFUSED" };

const LIMITS: Limits = { warn_at: 0.8, block_at: 0.95, when_capped: {} };

function html(element: React.JSX.Element): string {
  return renderToStaticMarkup(element);
}

function launch(load: Load): string {
  return html(
    createElement(LaunchSurface, {
      projects: [],
      load,
      onOpen: () => undefined,
      onForget: () => undefined,
      onRetry: () => undefined,
    }),
  );
}

function project(load: Load): string {
  return html(
    createElement(ProjectView, {
      projectId: "p1",
      projectName: "api",
      projectRoot: "/code/api",
      stations:
        load.status === "ready"
          ? {
              stations: [],
              harnesses: [],
              cuesheets: [],
              limits: LIMITS,
              warnings: [],
              sourcePath: null,
            }
          : null,
      usage: null,
      load,
      onAddStation: () => undefined,
      onOpenLedger: () => undefined,
      onRetry: () => undefined,
    }),
  );
}

function runs(load: Load): string {
  return html(
    createElement(RunSurface, {
      runs: [],
      selected: null,
      events: [],
      eventsLoaded: false,
      load,
      onSelect: () => undefined,
      onStop: () => undefined,
      onRetry: () => undefined,
      loadDiff: () => Promise.resolve(null),
    }),
  );
}

const SURFACES: Record<string, (load: Load) => string> = {
  launch,
  project,
  runs,
};

describe("every surface, in all three states", () => {
  for (const [name, render] of Object.entries(SURFACES)) {
    describe(name, () => {
      it("says what it is reading", () => {
        const markup = render(LOADING);
        expect(markup).toContain('data-kind="loading"');
        // Never the empty state's words while a fetch is in flight.
        expect(markup).not.toContain('data-kind="empty"');
      });

      it("says there is nothing, once it knows that", () => {
        const markup = render(READY);
        expect(markup).toContain('data-kind="empty"');
        expect(markup).not.toContain('data-kind="loading"');
      });

      it("says it could not read, and offers to try again", () => {
        const markup = render(FAILED);
        expect(markup).toContain('data-kind="error"');
        expect(markup).toContain('role="alert"');
        expect(markup).toContain("try again");
        // The daemon's own words, kept. Replacing them is how somebody
        // re-types a path that was never wrong.
        expect(markup).toContain("connect ECONNREFUSED");
        // And never dressed as progress.
        expect(markup).not.toContain('data-kind="loading"');
      });
    });
  }

  it("keeps the project on screen while its configuration is unreadable", () => {
    // The header is not part of the failure. Blanking the whole view to
    // announce that one fetch threw takes the project's name and root down
    // with it — and the name is how somebody knows which daemon to go and
    // look at.
    const markup = project(FAILED);
    expect(markup).toContain("api");
    expect(markup).toContain("/code/api");
  });

  it("does not offer to add a Station to a project it cannot read", () => {
    // The empty state's action, on a surface that failed, is an invitation to
    // do the one thing that is not going to work.
    expect(project(FAILED)).not.toContain("Add a Station");
    expect(project(READY)).toContain("Add a Station");
  });
});
