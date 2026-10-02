/**
 * The repo map against real grammars and a real repository.
 *
 * Nothing here is mocked: the point of vendoring wasm is that it loads on
 * every platform CI runs, and the only way to know is to load it.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createRepoMapper, defaultGrammarsDir } from "./repomap.js";

const exec = promisify(execFile);

// Real `git` and a 1.4 MB grammar compiled on first use; a budget for a
// loaded machine, not a wait.
vi.setConfig({ testTimeout: 30_000 });

async function repo(files: Record<string, string>): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-map-")),
  );
  await exec("git", ["init", "-q"], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content, "utf8");
  }
  return root;
}

describe("the repo mapper", () => {
  it("reads every export form TypeScript has", async () => {
    const root = await repo({
      "src/all.ts": [
        "export function fn() {}",
        "export function* gen() {}",
        "export class Klass {}",
        "export abstract class Base {}",
        "export interface Shape {}",
        "export type Alias = string;",
        "export enum Color { Red }",
        "export const one = 1, two = 2;",
        "export let mutable = 0;",
        "export declare const ambient: number;",
        "export { fn as renamed };",
        'export * from "./other.js";',
        'export * as ns from "./other.js";',
        "export default class {}",
        "function hidden() {}",
        "const notExported = 1;",
      ].join("\n"),
    });
    const [file] = await createRepoMapper().files(root);
    expect(file?.path).toBe("src/all.ts");
    expect(file?.symbols).toEqual([
      { name: "fn", kind: "fn" },
      { name: "gen", kind: "fn" },
      { name: "Klass", kind: "class" },
      { name: "Base", kind: "class" },
      { name: "Shape", kind: "interface" },
      { name: "Alias", kind: "type" },
      { name: "Color", kind: "enum" },
      { name: "one", kind: "const" },
      { name: "two", kind: "const" },
      { name: "mutable", kind: "const" },
      { name: "ambient", kind: "const" },
      { name: "renamed", kind: "reexport" },
      { name: '* from "./other.js"', kind: "reexport" },
      { name: "ns", kind: "reexport" },
      { name: "default", kind: "default" },
    ]);
  });

  it("reads JSX through the TSX grammar, and a TS cast through the TS one", async () => {
    const root = await repo({
      "ui/App.jsx": "export function App() { return <div />; }\n",
      "ui/cast.ts": "export const n = <number>(1 as unknown);\n",
    });
    const files = await createRepoMapper().files(root);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.symbols]));
    expect(byPath["ui/App.jsx"]).toEqual([{ name: "App", kind: "fn" }]);
    expect(byPath["ui/cast.ts"]).toEqual([{ name: "n", kind: "const" }]);
  });

  it("maps public Python by convention: no leading underscore", async () => {
    const root = await repo({
      "tool/cli.py": [
        "def main():\n    pass",
        "def _private():\n    pass",
        "@dataclass\nclass Config:\n    pass",
        "class _Hidden:\n    pass",
      ].join("\n\n"),
    });
    const [file] = await createRepoMapper().files(root);
    expect(file?.symbols).toEqual([
      { name: "main", kind: "fn" },
      { name: "Config", kind: "class" },
    ]);
  });

  it("honours .gitignore, because git lists the files", async () => {
    const root = await repo({
      ".gitignore": "generated/\n",
      "src/kept.ts": "export const kept = 1;\n",
      "generated/noise.ts": "export const noise = 1;\n",
    });
    const files = await createRepoMapper().files(root);
    expect(files.map((f) => f.path)).toEqual(["src/kept.ts"]);
  });

  it("renders the same bytes twice, and notices an edit on the third", async () => {
    const root = await repo({ "src/a.ts": "export const a = 1;\n" });
    const mapper = createRepoMapper();
    const first = await mapper.render(root, 24_000);
    const second = await mapper.render(root, 24_000);
    expect(second.text).toBe(first.text);

    // A size change, so the cache key moves even on a filesystem whose
    // mtime resolution would hide an edit this fast.
    await writeFile(
      path.join(root, "src/a.ts"),
      "export const a = 1;\nexport function added() {}\n",
      "utf8",
    );
    const third = await mapper.render(root, 24_000);
    expect(third.text).toContain("fn added");
  });

  it("maps a folder that is not a repository by walking it", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-map-")),
    );
    await mkdir(path.join(root, "lib"));
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(root, "lib", "x.ts"), "export const x = 1;\n");
    await writeFile(
      path.join(root, "node_modules", "dep", "y.ts"),
      "export const y = 1;\n",
    );
    const files = await createRepoMapper().files(root);
    expect(files.map((f) => f.path)).toEqual(["lib/x.ts"]);
  });

  it("loads every vendored grammar", async () => {
    // A grammar file replaced with one built for an ABI this runtime does
    // not support would fail here, not in somebody's projection.
    const grammars = (await readdir(defaultGrammarsDir())).filter((name) =>
      name.endsWith(".wasm"),
    );
    expect(grammars.sort()).toEqual([
      "tree-sitter-python.wasm",
      "tree-sitter-tsx.wasm",
      "tree-sitter-typescript.wasm",
    ]);
    const root = await repo({
      "a.ts": "export const a = 1;",
      "b.tsx": "export const b = 1;",
      "c.py": "def c():\n    pass",
    });
    const files = await createRepoMapper().files(root);
    expect(files.every((file) => file.symbols.length === 1)).toBe(true);
  });

  it("fails loudly when the grammars are missing, rather than mapping nothing", async () => {
    const root = await repo({ "a.ts": "export const a = 1;" });
    const mapper = createRepoMapper({
      grammarsDir: path.join(root, "no-grammars-here"),
    });
    await expect(mapper.files(root)).rejects.toThrow();
  });
});
