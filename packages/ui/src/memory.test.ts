import { describe, expect, it } from "vitest";
import { commaList, memoryApproval, memoryDraft } from "./memory.js";

describe("memory inbox drafts", () => {
  it("starts from the captured body and suggested fact id", () => {
    expect(
      memoryDraft({
        id: "memory-1",
        suggestedId: "project-switches-are-client-only",
        title: "Project switches are client-only",
        body: "Runs continue.",
        tags: ["projects", "desk"],
        projects: ["api-123456"],
        provenance: {
          station: "codex",
          run: "run-1",
          at: "2026-09-18T12:00:00.000Z",
        },
      }),
    ).toEqual({
      id: "project-switches-are-client-only",
      title: "Project switches are client-only",
      body: "Runs continue.",
      tags: "projects, desk",
      projects: "api-123456",
    });
  });

  it("turns edited comma lists into trimmed unique values", () => {
    expect(commaList(" projects, desk, projects,  ")).toEqual([
      "projects",
      "desk",
    ]);
    expect(
      memoryApproval({
        id: "  final-id ",
        title: " Edited title ",
        body: " Edited body \n",
        tags: "one, two",
        projects: "api-123456",
      }),
    ).toEqual({
      id: "final-id",
      title: "Edited title",
      body: "Edited body",
      tags: ["one", "two"],
      projects: ["api-123456"],
    });
  });
});
