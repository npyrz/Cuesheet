import { describe, expect, it } from "vitest";
import {
  FactFormatError,
  isFactId,
  parseFact,
  serializeFact,
  slugify,
  type Fact,
} from "./commons.js";

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: "rate-limiting",
    title: "Rate limiting is keyed on account, never on IP",
    tags: ["api", "convention"],
    projects: ["cuesheet"],
    provenance: {
      station: "opus",
      run: "20260916T101500000Z-0001",
      at: "2026-09-16T10:15:00.000Z",
    },
    body: "We key the limiter on the account id.\n\nIP keys break behind the proxy.",
    ...over,
  };
}

describe("isFactId", () => {
  it("refuses anything that could leave the commons directory", () => {
    // Same discipline as `RUN_ID_PATTERN`, and for the same reason: this string
    // becomes a filename. Without it, `DELETE /commons/../../projects.json`
    // deletes the project registry.
    for (const bad of [
      "..",
      "../escape",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "C:\\Windows",
      ".hidden",
      "trailing-",
      "-leading",
      "double--hyphen",
      "UPPER",
      "with space",
      "",
    ]) {
      expect(isFactId(bad)).toBe(false);
    }
  });

  it("refuses a name too long to be a comfortable filename", () => {
    expect(isFactId("a".repeat(81))).toBe(false);
    expect(isFactId("a".repeat(80))).toBe(true);
  });

  it("accepts the shape a slug produces", () => {
    expect(isFactId("rate-limiting")).toBe(true);
    expect(isFactId("step-39")).toBe(true);
  });
});

describe("slugify", () => {
  it("turns a title into a filename somebody would recognise in git log", () => {
    expect(slugify("Rate limiting is keyed on account, never on IP")).toBe(
      "rate-limiting-is-keyed-on-account-never-on-ip",
    );
  });

  it("folds accents rather than dropping the letter", () => {
    // `café` must not become `caf`: the id is read by humans in a file list.
    expect(slugify("Café conventions")).toBe("cafe-conventions");
  });

  it("is null when nothing survives, rather than inventing a name", () => {
    // A caller handed `untitled-4` would discover the collision later, in a
    // store whose whole value is that you can find things in it.
    expect(slugify("—  ///  —")).toBeNull();
    expect(slugify("日本語")).toBeNull();
  });

  it("never produces an id its own validator rejects", () => {
    for (const title of [
      "Trailing punctuation!!!",
      "  leading and trailing  ",
      "double  --  hyphens",
      "x".repeat(200),
    ]) {
      const slug = slugify(title);
      expect(slug === null || isFactId(slug)).toBe(true);
    }
  });
});

describe("serializeFact / parseFact", () => {
  it("round-trips a fact through the bytes on disk", () => {
    const original = fact();
    const parsed = parseFact(original.id, serializeFact(original));
    expect(parsed).toEqual(original);
  });

  it("writes something an operator could have typed", () => {
    const text = serializeFact(fact());
    expect(text.startsWith("+++\n")).toBe(true);
    expect(text).toContain('title = "Rate limiting is keyed on account');
    expect(text).toContain("[provenance]");
    expect(text).toContain("We key the limiter on the account id.");
  });

  it("ends in exactly one newline, so a rewrite is not a diff", () => {
    // Step 47 requires that running a projection twice produces no diff. That
    // promise starts here: a file that gains a blank line on every rewrite makes every
    // downstream comparison noisy.
    const text = serializeFact(fact({ body: "one line\n\n\n" }));
    expect(text.endsWith("one line\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("is stable — serializing twice produces identical bytes", () => {
    expect(serializeFact(fact())).toBe(serializeFact(fact()));
  });

  it("keeps a hand-written fact with no Station or Run", () => {
    // A fact somebody typed has no provenance to invent, and inventing one
    // would make "what did an agent write while I was not looking" a filter
    // nobody could trust.
    const typed = fact({ provenance: { at: "2026-09-16T10:15:00.000Z" } });
    const parsed = parseFact(typed.id, serializeFact(typed));
    expect(parsed.provenance).toEqual({ at: "2026-09-16T10:15:00.000Z" });
    expect(parsed.provenance.station).toBeUndefined();
  });

  it("reads a file written with CRLF", () => {
    // A commons repository cloned on Windows, or edited in an editor that
    // normalises the other way.
    const text = serializeFact(fact()).replace(/\n/g, "\r\n");
    expect(parseFact("rate-limiting", text).title).toContain("Rate limiting");
  });

  it("names the file when the frontmatter is not valid TOML", () => {
    // A file the operator hand-edited into something else. Step 47's
    // projection and Step 48's inbox both have to skip it *loudly*.
    expect(() => parseFact("broken", "+++\ntitle = \n+++\n\nbody\n")).toThrow(
      FactFormatError,
    );
  });

  it("refuses a file with no fence rather than guessing where the body starts", () => {
    expect(() => parseFact("plain", "# Just markdown\n")).toThrow(
      /frontmatter fence/,
    );
    expect(() => parseFact("open", '+++\ntitle = "x"\n')).toThrow(
      /never closes it/,
    );
  });

  it("refuses to parse under an id that could escape the directory", () => {
    expect(() => parseFact("../escape", serializeFact(fact()))).toThrow(
      FactFormatError,
    );
  });
});
