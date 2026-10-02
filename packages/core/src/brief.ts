/**
 * The brief has a budget — Step 58.
 *
 * Before this, a reviewer was handed the workspace diff cut off at a character
 * count. That bounded the bill and wrecked the review: a diff that overran
 * stopped mid-hunk, inside whichever file happened to sort last, and the
 * reviewer was told only that *something* was missing.
 *
 * What replaces it works in whole files. A patch is split at its `diff --git`
 * headers, files are kept or left out entire, and everything left out is
 * named — so a reviewer that saw half the change can say which half.
 *
 * Pure, and in `core`, for the reason `gate.ts` is: what a reviewer is shown
 * decides what a review is worth, and that has to be testable against a
 * forty-thousand-line patch without a process or a repository.
 */

/** What one file contributed to a diff, in lines. */
export interface ChangedFile {
  /** Workspace-relative, posix — the form leash and gate globs match. */
  path: string;
  insertions: number;
  deletions: number;
}

/** One file's slice of a unified diff, header to the next header. */
export interface PatchFile extends ChangedFile {
  text: string;
  bytes: number;
}

export interface ElidedFile {
  path: string;
  bytes: number;
  /** Which rule left it out. `never_review` names the glob that matched. */
  reason: "budget" | "never_review";
  rule?: string;
}

/**
 * Split a `git diff` into per-file sections.
 *
 * Anything before the first header is kept as an unnamed section rather than
 * dropped; `git diff` writes none, but a harness-supplied patch might, and a
 * splitter that silently discards input is the wrong place to economise.
 */
export function splitPatch(patch: string): PatchFile[] {
  if (patch === "") return [];

  const sections: string[] = [];
  let current = "";
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ") && current !== "") {
      sections.push(current);
      current = "";
    }
    current += line;
  }
  if (current !== "") sections.push(current);

  return sections.map((text) => {
    const counted = countLines(text);
    return {
      path: sectionPath(text),
      text,
      bytes: utf8Bytes(text),
      ...counted,
    };
  });
}

/**
 * Which file a section is about.
 *
 * The `+++` line wins over the `diff --git` header because the header is
 * ambiguous for a path containing ` b/` — git does not quote spaces — while
 * `+++ b/<path>` is one path to end of line. A deletion has `+++ /dev/null`,
 * so it falls back to `---`. A binary or mode-only change has neither line,
 * and only then is the header parsed.
 */
function sectionPath(text: string): string {
  let minus: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) break;
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      if (target !== "/dev/null") return stripPrefix(unquote(target));
    }
    if (line.startsWith("--- ")) {
      const source = line.slice(4).replace(/\t$/, "");
      if (source !== "/dev/null") minus = stripPrefix(unquote(source));
    }
  }
  if (minus !== undefined) return minus;

  const header = /^diff --git (?:"?a\/.*?"? )"?b\/(.*?)"?\r?$/m.exec(text);
  return header?.[1] !== undefined ? unquote(`"${header[1]}"`) : "";
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/**
 * Undo git's C-style path quoting.
 *
 * With the default `core.quotepath`, any non-ASCII byte is written as an
 * octal escape — `"src/\303\251t\303\251.ts"` — and a glob compiled against
 * the real name would never match the escaped one. Decoding to bytes and then
 * to UTF-8 is what turns it back into the name on disk.
 */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) {
    return path;
  }
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    '"': 34,
    "\\": 92,
    a: 7,
    b: 8,
    f: 12,
    r: 13,
    v: 11,
  };
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const next = body[i + 1] ?? "";
    bytes.push(simple[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Lines added and removed in one section.
 *
 * Only inside hunks: before the first `@@`, `+++` and `---` are headers, and
 * after it a line `+++x` is an insertion of `++x`. Counting by prefix alone
 * gets both cases wrong in opposite directions.
 */
function countLines(text: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) inHunk = false;
    if (!inHunk) continue;
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}

export interface FitOptions {
  files: readonly PatchFile[];
  /** The hard ceiling on the *whole* brief, frame included, in UTF-8 bytes. */
  maxBytes: number;
  /**
   * The brief around the diff. Called with the patch that survived and what
   * was left out, so the note naming the elided files is inside the budget
   * rather than an overrun on top of it.
   */
  frame: (patch: string, elided: readonly ElidedFile[]) => string;
  /** A `never_review` rule that matches this path, if one does. */
  exclude?: (path: string) => string | undefined;
  /** Kept first when the budget is short — `always_review`. */
  priority?: (path: string) => boolean;
}

export interface FittedBrief {
  text: string;
  bytes: number;
  kept: string[];
  elided: ElidedFile[];
  /**
   * The frame alone is over budget: no diff fits, and no amount of elision
   * will help. The caller refuses the step rather than sending this.
   */
  overBudget: boolean;
}

/**
 * Assemble a brief whose diff fits inside `maxBytes`, losing whole files.
 *
 * **Which files go is decided by size, smallest kept first** — not by order.
 * Keeping the first files that fit would make what a reviewer sees depend on
 * how paths sort, so `package-lock.json` would survive a budget that dropped
 * `src/`. Smallest-first drops the lockfile, the vendored bundle and the
 * regenerated snapshot, which are the files least likely to be read line by
 * line by anybody. `always_review` paths are placed ahead of that ordering,
 * because an auth change is worth more of the budget than a dozen small ones.
 * The survivors are then emitted in the patch's own order.
 *
 * The note naming what was elided costs bytes too, and it grows as more is
 * elided. So this iterates: assemble, measure the overrun, shrink the space
 * for the patch by exactly that much, and try again. The space strictly
 * decreases, so it terminates — at worst with nothing kept.
 */
export function fitPatch(options: FitOptions): FittedBrief {
  const excluded: ElidedFile[] = [];
  const candidates: { file: PatchFile; index: number }[] = [];
  options.files.forEach((file, index) => {
    const rule = options.exclude?.(file.path);
    if (rule !== undefined) {
      excluded.push({
        path: file.path,
        bytes: file.bytes,
        reason: "never_review",
        rule,
      });
    } else {
      candidates.push({ file, index });
    }
  });

  const priority = options.priority ?? (() => false);
  const order = [...candidates].sort((a, b) => {
    const pa = priority(a.file.path) ? 0 : 1;
    const pb = priority(b.file.path) ? 0 : 1;
    return pa - pb || a.file.bytes - b.file.bytes || a.index - b.index;
  });

  let space = options.maxBytes;
  for (;;) {
    const kept = new Set<number>();
    let used = 0;
    for (const { file, index } of order) {
      if (used + file.bytes > space) continue;
      kept.add(index);
      used += file.bytes;
    }

    const shown = candidates.filter(({ index }) => kept.has(index));
    const dropped: ElidedFile[] = candidates
      .filter(({ index }) => !kept.has(index))
      .map(({ file }) => ({
        path: file.path,
        bytes: file.bytes,
        reason: "budget" as const,
      }));
    const elided = [...excluded, ...dropped];
    const text = options.frame(
      shown.map(({ file }) => file.text).join(""),
      elided,
    );
    const bytes = utf8Bytes(text);
    const over = bytes - options.maxBytes;

    if (over <= 0 || used === 0) {
      return {
        text,
        bytes,
        kept: shown.map(({ file }) => file.path),
        elided,
        overBudget: over > 0,
      };
    }
    space = used - over;
  }
}

/** The most elided files a note lists by name before summarising the rest. */
const NOTE_LIMIT = 50;

/**
 * What the reviewer is told it did not see.
 *
 * Addressed to the reviewer, because the reviewer is the one who can act on
 * it: a verdict over an elided diff that does not say so is a review that
 * claims more than it checked.
 */
export function describeElision(elided: readonly ElidedFile[]): string {
  if (elided.length === 0) return "";
  const lines = elided.slice(0, NOTE_LIMIT).map((file) => {
    const why =
      file.reason === "never_review"
        ? `never_review "${file.rule ?? ""}"`
        : "over the brief budget";
    return `- ${file.path} (${formatBytes(file.bytes)}, ${why})`;
  });
  if (elided.length > NOTE_LIMIT) {
    lines.push(`- …and ${String(elided.length - NOTE_LIMIT)} more`);
  }
  return [
    `${String(elided.length)} changed file${elided.length === 1 ? " was" : "s were"} left out of this diff. You have not seen ${elided.length === 1 ? "it" : "them"}; do not approve ${elided.length === 1 ? "it" : "them"} by implication, and say so in your summary if it matters:`,
    ...lines,
  ].join("\n");
}

/** `812 B`, `14.2 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 length without allocating an encoded copy of a megabyte patch. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte code point, not two 3-byte ones.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Roughly how many input tokens a text costs. **An estimate, always.**
 *
 * The only exact answer is a vendor's token-counting endpoint, and calling one
 * needs the vendor's key — which the README promises Cuesheet never holds. So
 * this is the common rule of thumb for BPE tokenizers over English and code,
 * about four bytes a token, and every surface that shows it says "estimated".
 * It is good for "this brief is 50k tokens, not 5k" and for nothing finer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / BYTES_PER_TOKEN);
}

export const BYTES_PER_TOKEN = 4;

/** The pre-run half of the budget: what a prompt costs before it is sent. */
export interface BriefCheck {
  bytes: number;
  /** An estimate — see {@link estimateTokens}. */
  estimatedTokens: number;
  maxBytes: number;
  /** Present when the prompt alone is over the ceiling. */
  refused?: string;
}

/**
 * Can a prompt fit in a brief at all?
 *
 * Asked at `POST /runs`, before anything is enqueued. Every brief the run
 * assembles carries the prompt — an engineer's verbatim, a reviewer's inside
 * the review contract — so a prompt over the ceiling is a run whose first
 * Station would be refused. Refusing it here is the same answer at second
 * zero, with no queue turn and no Station started.
 *
 * Only a floor: the Commons prefix and a reviewer's diff are added later and
 * are not known yet. The estimate is shown so an operator sees the size of
 * what they are about to send, labelled as the guess it is.
 */
export function checkBrief(prompt: string, maxBytes: number): BriefCheck {
  const bytes = utf8Bytes(prompt);
  const estimatedTokens = estimateTokens(prompt);
  return {
    bytes,
    estimatedTokens,
    maxBytes,
    ...(bytes > maxBytes && {
      refused:
        `This prompt is ${formatBytes(bytes)} (about ` +
        `${estimatedTokens.toLocaleString("en-US")} tokens, estimated), over ` +
        `max_brief_bytes of ${formatBytes(maxBytes)}. Nothing was started. ` +
        `Shorten it or raise [limits] max_brief_bytes.`,
    }),
  };
}
