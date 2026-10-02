import { describe, expect, it } from "vitest";
import {
  checkBrief,
  describeElision,
  estimateTokens,
  fitPatch,
  splitPatch,
  utf8Bytes,
  type ElidedFile,
} from "./brief.js";

/** One file's worth of `git diff`, as git writes it. */
function section(path: string, added: number, body = "x"): string {
  const lines = Array.from({ length: added }, (_, i) => `+${body}${i}\n`);
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 0000000..1111111 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${added} @@\n` +
    lines.join("")
  );
}

/** A frame that adds nothing, so the budget is the patch's alone. */
const bare = (patch: string, elided: readonly ElidedFile[]): string =>
  patch + describeElision(elided);

describe("splitPatch", () => {
  it("splits at each header and keeps every byte", () => {
    const patch = section("src/a.ts", 2) + section("src/b.ts", 3);
    const files = splitPatch(patch);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files.map((f) => f.text).join("")).toBe(patch);
    expect(files.map((f) => f.insertions)).toEqual([2, 3]);
  });

  it("counts a hunk line that starts with +++ as an insertion, not a header", () => {
    const patch =
      "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1,2 @@\n-old\n+++ heading\n+new\n";
    const [file] = splitPatch(patch);
    expect(file).toMatchObject({ path: "x.md", insertions: 2, deletions: 1 });
  });

  it("names a deleted file by its old path, not /dev/null", () => {
    const patch =
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
    expect(splitPatch(patch)[0]).toMatchObject({
      path: "gone.ts",
      deletions: 1,
    });
  });

  it("names a binary change from the header, which is all it has", () => {
    const patch =
      "diff --git a/img/logo.png b/img/logo.png\nnew file mode 100644\nBinary files /dev/null and b/img/logo.png differ\n";
    expect(splitPatch(patch)[0]?.path).toBe("img/logo.png");
  });

  it("decodes git's octal quoting so a glob sees the real name", () => {
    // `core.quotepath` writes é as \303\251.
    const patch =
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1 @@\n+x\n';
    expect(splitPatch(patch)[0]?.path).toBe("café.ts");
  });

  it("reads a path with a space from the +++ line, where it is unambiguous", () => {
    const patch =
      "diff --git a/my b/file.ts b/my b/file.ts\n--- a/my b/file.ts\n+++ b/my b/file.ts\n@@ -0,0 +1 @@\n+x\n";
    expect(splitPatch(patch)[0]?.path).toBe("my b/file.ts");
  });

  it("returns nothing for an empty patch", () => {
    expect(splitPatch("")).toEqual([]);
  });
});

describe("fitPatch", () => {
  it("bounds a forty-thousand-line diff and names what it left out", () => {
    const patch =
      section("src/limiter.ts", 30) +
      section("package-lock.json", 40_000) +
      section("src/limiter.test.ts", 20);
    const maxBytes = 50_000;

    const fitted = fitPatch({
      files: splitPatch(patch),
      maxBytes,
      frame: bare,
    });

    expect(fitted.bytes).toBeLessThanOrEqual(maxBytes);
    expect(fitted.overBudget).toBe(false);
    expect(fitted.kept).toEqual(["src/limiter.ts", "src/limiter.test.ts"]);
    expect(fitted.elided).toEqual([
      expect.objectContaining({ path: "package-lock.json", reason: "budget" }),
    ]);
    expect(fitted.text).toContain("package-lock.json");
    // Whole files or nothing: the other files stop at line 29, so any line
    // past that is a piece of the lockfile.
    expect(fitted.text).not.toContain("+x30\n");
    expect(fitted.text).not.toContain("+x39999\n");
  });

  it("keeps the survivors in the patch's own order, not size order", () => {
    const patch = section("z.ts", 5) + section("a.ts", 1) + section("m.ts", 3);
    const fitted = fitPatch({
      files: splitPatch(patch),
      maxBytes: 1_000_000,
      frame: bare,
    });
    expect(fitted.kept).toEqual(["z.ts", "a.ts", "m.ts"]);
    expect(fitted.text).toBe(patch);
  });

  it("drops the largest first, whatever order the paths sort in", () => {
    // `a-big` sorts first. Keeping files in order until the budget runs out
    // would keep it and drop the real change.
    const patch = section("a-big.json", 2_000) + section("src/real.ts", 10);
    const fitted = fitPatch({
      files: splitPatch(patch),
      maxBytes: 5_000,
      frame: bare,
    });
    expect(fitted.kept).toEqual(["src/real.ts"]);
  });

  it("spends the budget on always_review paths before smaller ones", () => {
    const files = splitPatch(
      section("docs/a.md", 10) +
        section("docs/b.md", 10) +
        section("src/auth/token.ts", 60),
    );
    const one = files[0]?.bytes ?? 0;
    const auth = files[2]?.bytes ?? 0;
    const fitted = fitPatch({
      files,
      // Room for the auth file and one doc, with slack for the note — not for
      // both docs and the auth file.
      maxBytes: auth + one + 400,
      frame: bare,
      priority: (path) => path.startsWith("src/auth/"),
    });
    expect(fitted.kept).toContain("src/auth/token.ts");
  });

  it("leaves never_review files out by name, before any budget is spent", () => {
    const fitted = fitPatch({
      files: splitPatch(section("yarn.lock", 3) + section("src/a.ts", 3)),
      maxBytes: 1_000_000,
      frame: bare,
      exclude: (path) => (path === "yarn.lock" ? "*.lock" : undefined),
    });
    expect(fitted.kept).toEqual(["src/a.ts"]);
    expect(fitted.elided).toEqual([
      expect.objectContaining({
        path: "yarn.lock",
        reason: "never_review",
        rule: "*.lock",
      }),
    ]);
  });

  it("counts the elision note against the budget it is reporting on", () => {
    // Twenty files, a budget that holds about half, and a frame whose note
    // grows with every file dropped. The note must not push it over.
    const files = splitPatch(
      Array.from({ length: 20 }, (_, i) =>
        section(`src/file-${i}.ts`, 10),
      ).join(""),
    );
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    const maxBytes = Math.floor(total / 2);
    const fitted = fitPatch({ files, maxBytes, frame: bare });
    expect(fitted.bytes).toBeLessThanOrEqual(maxBytes);
    expect(fitted.elided.length).toBeGreaterThan(0);
  });

  it("reports a frame that is over budget on its own, rather than sending it", () => {
    const fitted = fitPatch({
      files: splitPatch(section("a.ts", 1)),
      maxBytes: 10,
      frame: (patch) => `a frame much longer than ten bytes${patch}`,
    });
    expect(fitted.overBudget).toBe(true);
    expect(fitted.kept).toEqual([]);
  });
});

describe("describeElision", () => {
  it("is empty when nothing was left out", () => {
    expect(describeElision([])).toBe("");
  });

  it("lists fifty by name and counts the rest", () => {
    const elided = Array.from({ length: 60 }, (_, i) => ({
      path: `f${i}`,
      bytes: 10,
      reason: "budget" as const,
    }));
    const note = describeElision(elided);
    expect(note).toContain("60 changed files were left out");
    expect(note).toContain("- f49 ");
    expect(note).not.toContain("- f50 ");
    expect(note).toContain("…and 10 more");
  });
});

describe("utf8Bytes and estimateTokens", () => {
  it("counts bytes the way the wire does", () => {
    for (const text of ["ascii", "café", "日本語", "emoji 🎛️", ""]) {
      expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it("estimates about four bytes a token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("x".repeat(4_000))).toBe(1_000);
  });
});

describe("checkBrief", () => {
  it("passes a prompt that fits, with its estimate", () => {
    const check = checkBrief("add rate limiting", 1024);
    expect(check.refused).toBeUndefined();
    expect(check.estimatedTokens).toBeGreaterThan(0);
  });

  it("refuses a prompt over the ceiling, saying the number is an estimate", () => {
    const check = checkBrief("x".repeat(5_000), 4_096);
    expect(check.refused).toMatch(/estimated/);
    expect(check.refused).toContain("max_brief_bytes");
  });
});
