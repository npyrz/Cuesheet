import { describe, expect, it } from "vitest";
import { utf8Bytes } from "./brief.js";
import { renderRepoMap, type RepoMapFile } from "./repomap.js";

const FILES: RepoMapFile[] = [
  { path: "src/b.ts", symbols: [{ name: "beta", kind: "fn" }] },
  { path: "src/a.ts", symbols: [{ name: "Alpha", kind: "class" }] },
  { path: "src/a.test.ts", symbols: [] },
  { path: "README.ts", symbols: [{ name: "default", kind: "default" }] },
  { path: "src/sub/c.ts", symbols: [{ name: "C", kind: "type" }] },
];

describe("renderRepoMap", () => {
  it("is the same bytes whatever order the files arrive in", () => {
    // `readdir` and `git ls-files` order are not a contract. The map is.
    const forward = renderRepoMap(FILES, 10_000).text;
    const backward = renderRepoMap([...FILES].reverse(), 10_000).text;
    expect(backward).toBe(forward);
  });

  it("groups by directory and gives export-less files one line", () => {
    const { text } = renderRepoMap(FILES, 10_000);
    expect(text).toContain(
      [
        "- src/",
        "  - a.ts: class Alpha",
        "  - b.ts: fn beta",
        "  - also: a.test.ts",
        "- src/sub/",
        "  - c.ts: type C",
      ].join("\n"),
    );
    expect(text).toContain("- ./\n  - README.ts: default");
  });

  it("orders by code unit, not locale", () => {
    // Under most locales `a` sorts before `B`; by code unit `B` comes first.
    // Only the second is the same on every machine.
    const { text } = renderRepoMap(
      [
        { path: "a/x.ts", symbols: [{ name: "x", kind: "fn" }] },
        { path: "B/y.ts", symbols: [{ name: "y", kind: "fn" }] },
      ],
      10_000,
    );
    expect(text.indexOf("- B/")).toBeLessThan(text.indexOf("- a/"));
  });

  it("drops whole directories from the end over the cap, and says how many files", () => {
    const many: RepoMapFile[] = Array.from({ length: 200 }, (_, i) => ({
      path: `pkg${String(i).padStart(3, "0")}/index.ts`,
      symbols: [{ name: `thing${i}`, kind: "const" }],
    }));
    const maxBytes = 2_048;
    const rendered = renderRepoMap(many, maxBytes);

    expect(utf8Bytes(rendered.text)).toBeLessThanOrEqual(maxBytes);
    expect(rendered.omitted).toBeGreaterThan(0);
    expect(rendered.text).toContain("- pkg000/");
    expect(rendered.text).not.toContain("- pkg199/");
    expect(rendered.text).toContain(
      `…and ${rendered.omitted} more files not mapped`,
    );
  });

  it("carries no line numbers, so an edit that moves code changes nothing", () => {
    expect(renderRepoMap(FILES, 10_000).text).not.toMatch(/:\d+/);
  });
});
