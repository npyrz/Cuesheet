import { describe, expect, it } from "vitest";

const script = new URL("../../../scripts/release-notes.mjs", import.meta.url)
  .href;
const { changelogSection, renderReleaseNotes } = (await import(script)) as {
  changelogSection(text: string, section?: string): string;
  renderReleaseNotes(
    text: string,
    options: { repository: string; sha: string; branch: string },
  ): string;
};

describe("changelog-backed release notes", () => {
  const changelog =
    "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n### Fixed\r\n\r\n- A current fix.\r\n\r\n## [0.1.0] — 2026-09-15\r\n\r\n- Old history.\r\n";

  it("selects the current changes without presenting old releases as new", () => {
    expect(changelogSection(changelog)).toBe("### Fixed\n\n- A current fix.");
    expect(changelogSection(changelog, "0.1.0")).toBe("- Old history.");
  });

  it("fails before publication if the section is missing, ambiguous or empty", () => {
    for (const input of [
      "# Changelog",
      "## [Unreleased]\n### Added\n<!-- add changes here -->",
      "## [Unreleased]\n- A\n## [Unreleased]\n- B",
    ]) {
      expect(() => changelogSection(input)).toThrow();
    }
  });

  it("ties notes to the exact commit and escapes branch metadata", () => {
    const sha = "a".repeat(40);
    const notes = renderReleaseNotes(changelog, {
      repository: "npyrz/Cuesheet",
      sha,
      branch: "test/<b>`branch`",
    });
    expect(notes).toContain(`/blob/${sha}/CHANGELOG.md`);
    expect(notes).toContain("**Prerelease**");
    expect(notes).toContain("test/&#60;b&#62;&#96;branch&#96;");
    expect(notes).toContain("A current fix.");
    expect(notes).not.toContain("Old history.");
    expect(
      renderReleaseNotes(changelog, {
        repository: "npyrz/Cuesheet",
        sha,
        branch: "main",
      }),
    ).toContain("**Production**");
  });
});
