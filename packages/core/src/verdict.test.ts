import { describe, expect, it } from "vitest";
import { parseVerdict } from "./verdict.js";

describe("parseVerdict", () => {
  it("reads the fenced JSON block the instructions ask for", () => {
    const parsed = parseVerdict(`I read the diff and it looks wrong.

\`\`\`json
{"decision": "fail", "findings": [{"category": "security", "severity": "block", "summary": "Filename comes from the client."}]}
\`\`\`
`);

    expect(parsed.decision).toBe("fail");
    expect(parsed.source).toBe("json");
    expect(parsed.findings).toEqual([
      {
        category: "security",
        severity: "block",
        summary: "Filename comes from the client.",
      },
    ]);
  });

  it("takes the last block, not the restated example", () => {
    // Models love to quote the format back at you before using it.
    const parsed = parseVerdict(`I will answer in this shape:

\`\`\`json
{"decision": "pass", "findings": []}
\`\`\`

Having now looked:

\`\`\`json
{"decision": "fail", "findings": []}
\`\`\`
`);
    expect(parsed.decision).toBe("fail");
  });

  it("accepts an unlabelled fence", () => {
    expect(
      parseVerdict('```\n{"decision":"pass","findings":[]}\n```').decision,
    ).toBe("pass");
  });

  it("falls back to a spoken VERDICT line", () => {
    expect(parseVerdict("Looks good to me.\n\nVERDICT: pass\n").decision).toBe(
      "pass",
    );
    expect(parseVerdict("**Verdict:** **fail** — see below").decision).toBe(
      "fail",
    );
  });

  it("abstains on a review with no verdict in it", () => {
    // The case the whole feature turns on. "LGTM" is not an approval this
    // parser is willing to invent, and `evaluateGate` cannot satisfy
    // `require` with an abstention.
    const parsed = parseVerdict("LGTM, ship it!");
    expect(parsed.decision).toBe("abstain");
    expect(parsed.source).toBe("none");
  });

  it("abstains on empty output, which is what a crashed reviewer produces", () => {
    expect(parseVerdict("").decision).toBe("abstain");
  });

  it("abstains rather than guessing at malformed JSON", () => {
    expect(parseVerdict('```json\n{"decision": "pa\n```').decision).toBe(
      "abstain",
    );
  });

  it("ignores a decision word it does not recognise", () => {
    expect(
      parseVerdict('```json\n{"decision": "maybe", "findings": []}\n```')
        .decision,
    ).toBe("abstain");
  });

  it("keeps a finding whose severity is missing or nonsense", () => {
    // A Gate blocks on the *category*, so dropping the finding because its
    // severity was unreadable would discard the part that matters.
    const parsed = parseVerdict(
      '```json\n{"decision":"fail","findings":[{"category":"correctness","summary":"Off by one."},{"category":"security","severity":"catastrophic","summary":"Key in the log."}]}\n```',
    );
    expect(parsed.findings.map((f) => f.severity)).toEqual(["warn", "warn"]);
    expect(parsed.findings.map((f) => f.category)).toEqual([
      "correctness",
      "security",
    ]);
  });

  it("drops a finding with no category, which is not a finding", () => {
    const parsed = parseVerdict(
      '```json\n{"decision":"fail","findings":[{"summary":"something is off"},"nope",null]}\n```',
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.decision).toBe("fail");
  });

  it("gives a categorised finding a summary when it arrives without one", () => {
    const parsed = parseVerdict(
      '```json\n{"decision":"fail","findings":[{"category":"data-loss"}]}\n```',
    );
    expect(parsed.findings[0]).toEqual({
      category: "data-loss",
      severity: "warn",
      summary: "Unexplained data-loss finding.",
    });
  });

  it("prefers a JSON block over a line elsewhere in the text", () => {
    const parsed = parseVerdict(
      'VERDICT: pass\n\n```json\n{"decision":"fail","findings":[]}\n```',
    );
    expect(parsed.decision).toBe("fail");
  });
});
