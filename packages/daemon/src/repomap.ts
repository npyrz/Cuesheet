/**
 * Building the repo map — Step 59.
 *
 * The format and the rendering rules are `core/repomap.ts`. This is the part
 * that reaches disk: list the workspace, parse each source file with a wasm
 * grammar, and keep what it exports.
 *
 * **`web-tree-sitter`, not the native `tree-sitter` binding.** A native module
 * means a rebuild against Electron's ABI on every platform, which is the risk
 * Step 10 chose files over SQLite to avoid. The grammars are vendored `.wasm`
 * files in `packages/daemon/grammars` — see the README there for why they are
 * not npm dependencies.
 *
 * It is the daemon's job rather than a harness's because a map built per
 * harness is the same work three times, and harnesses never import each other.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderRepoMap,
  type RenderedRepoMap,
  type RepoMapFile,
  type RepoSymbol,
} from "@cuesheet/core";
import { isGitRepo, run } from "@cuesheet/harness";
import { Language, Parser, type Node } from "web-tree-sitter";

export interface RepoMapperOptions {
  /** Where `tree-sitter-<grammar>.wasm` live. Defaults to the vendored copies. */
  grammarsDir?: string;
  /** `web-tree-sitter.wasm`. Defaults to the installed package's own. */
  runtimeWasm?: string;
}

export interface RepoMapper {
  /** Every mapped file under `root`, in no particular order. */
  files(root: string): Promise<RepoMapFile[]>;
  render(root: string, maxBytes: number): Promise<RenderedRepoMap>;
}

type Grammar = "typescript" | "tsx" | "python";

/**
 * Which grammar reads which extension.
 *
 * Plain JavaScript goes through the TSX grammar rather than a third JS one:
 * TSX is a superset of JS plus JSX, and the one construct where the two
 * grammars disagree — `<T>x` casts — cannot appear in a `.js` file. One fewer
 * 400 KB file to ship. `.ts` keeps the TypeScript grammar because in a `.ts`
 * file `<T>x` *is* a cast, and the TSX grammar would misread it as JSX.
 */
const GRAMMAR_BY_EXTENSION: Readonly<Record<string, Grammar>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "tsx",
  ".jsx": "tsx",
  ".mjs": "tsx",
  ".cjs": "tsx",
  ".py": "python",
};

/**
 * Larger than this is generated, minified or vendored, and its "exports" are
 * noise that would crowd real files out of the map's byte cap.
 */
const MAX_FILE_BYTES = 256 * 1024;

/** A walk that finds more than this is not a repository a map can summarise. */
const MAX_FILES = 20_000;

/** Skipped by the fallback walk; `git ls-files` already honours `.gitignore`. */
const WALK_SKIP = new Set(["node_modules", "dist", "build", "out", "target"]);

/**
 * Compiled grammars, by the absolute path of their `.wasm`.
 *
 * Process-wide rather than per mapper, because compiling the TypeScript
 * grammar is about 1.4 MB of WebAssembly and the runtime they compile into is
 * process-wide anyway. Keyed by path so two mappers pointed at different
 * grammar directories still get their own.
 */
const languages = new Map<string, Promise<Language>>();

export function createRepoMapper(options: RepoMapperOptions = {}): RepoMapper {
  // Per absolute path, keyed on what `stat` says. A run-start regeneration
  // re-parses only files that changed since the last one, which is what makes
  // "regenerate on every run" cheap enough to be the policy.
  const cache = new Map<
    string,
    { mtimeMs: number; size: number; symbols: RepoSymbol[] }
  >();

  async function language(grammar: Grammar): Promise<Language> {
    const file = nodePath.join(
      options.grammarsDir ?? defaultGrammarsDir(),
      `tree-sitter-${grammar}.wasm`,
    );
    let loading = languages.get(file);
    if (loading === undefined) {
      loading = (async () => {
        await initParser(options.runtimeWasm ?? defaultRuntimeWasm());
        // Read here and handed over as bytes, rather than given as a path:
        // what `Language.load` does with a string depends on what emscripten
        // thinks the environment is, and inside an esbuild bundle in an asar
        // that guess is the thing most likely to be wrong.
        return Language.load(new Uint8Array(await readFile(file)));
      })();
      // A failed load is not memoised: a grammar file restored between
      // regenerations should be picked up without restarting the daemon.
      loading.catch(() => languages.delete(file));
      languages.set(file, loading);
    }
    return loading;
  }

  async function files(root: string): Promise<RepoMapFile[]> {
    const listed = await listFiles(root);
    const mapped: RepoMapFile[] = [];
    // Before `new Parser()`, which throws if the wasm runtime is not up yet.
    // Paid even for a repository with nothing to parse, which is the price
    // of finding a missing runtime file on the first map rather than later.
    await initParser(options.runtimeWasm ?? defaultRuntimeWasm());
    const parser = new Parser();
    const seen = new Set<string>();
    try {
      for (const relative of listed) {
        const grammar =
          GRAMMAR_BY_EXTENSION[nodePath.posix.extname(relative).toLowerCase()];
        if (grammar === undefined) continue;
        const absolute = nodePath.join(root, relative);
        seen.add(absolute);

        let info;
        try {
          info = await stat(absolute);
        } catch {
          continue; // Listed by git and deleted since; not part of the shape.
        }
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;

        const cached = cache.get(absolute);
        if (
          cached !== undefined &&
          cached.mtimeMs === info.mtimeMs &&
          cached.size === info.size
        ) {
          mapped.push({ path: relative, symbols: cached.symbols });
          continue;
        }

        parser.setLanguage(await language(grammar));
        const source = await readFile(absolute, "utf8");
        const tree = parser.parse(source);
        if (tree === null) continue;
        const symbols =
          grammar === "python"
            ? pythonSymbols(tree.rootNode)
            : scriptSymbols(tree.rootNode);
        tree.delete();
        cache.set(absolute, {
          mtimeMs: info.mtimeMs,
          size: info.size,
          symbols,
        });
        mapped.push({ path: relative, symbols });
      }
    } finally {
      parser.delete();
    }
    // Forget files that left the tree, so the cache cannot outgrow it.
    const prefix = root.endsWith(nodePath.sep)
      ? root
      : `${root}${nodePath.sep}`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix) && !seen.has(key)) cache.delete(key);
    }
    return mapped;
  }

  return {
    files,
    async render(root, maxBytes) {
      return renderRepoMap(await files(root), maxBytes);
    },
  };
}

let parserReady: Promise<void> | undefined;

/**
 * `Parser.init` is process-global in `web-tree-sitter`: one wasm runtime per
 * process, whoever asks first. Memoised for that reason, and reset on failure
 * so a missing runtime file is retried rather than poisoning the process.
 */
async function initParser(runtimeWasm: string): Promise<void> {
  parserReady ??= (async () => {
    const wasmBinary = await readFile(runtimeWasm);
    await Parser.init({
      wasmBinary: wasmBinary.buffer.slice(
        wasmBinary.byteOffset,
        wasmBinary.byteOffset + wasmBinary.byteLength,
      ),
    });
  })();
  parserReady.catch(() => {
    parserReady = undefined;
  });
  return parserReady;
}

/**
 * The vendored grammars, beside `dist/` in a checkout or an npm install.
 *
 * Only meaningful when this module is loaded as itself. Bundled into the
 * Electron main process, `import.meta.url` is gone — which is why the desktop
 * passes `grammarsDir` explicitly and this default is never reached there.
 */
export function defaultGrammarsDir(): string {
  return nodePath.join(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    "..",
    "grammars",
  );
}

export function defaultRuntimeWasm(): string {
  return createRequire(import.meta.url).resolve(
    "web-tree-sitter/web-tree-sitter.wasm",
  );
}

/**
 * Workspace files, posix and relative.
 *
 * `git ls-files` first: tracked plus untracked-but-not-ignored is exactly
 * "the repository as the operator sees it", `.gitignore` included, and
 * re-implementing `.gitignore` semantics is not a job worth taking on. `-z`
 * because without it git C-quotes any path with a non-ASCII byte. Outside a
 * repository, a plain walk that skips the usual build output.
 */
async function listFiles(root: string): Promise<string[]> {
  if (await isGitRepo(root)) {
    const listed = await run(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeoutMs: 30_000 },
    );
    if (listed.code === 0) {
      return [...new Set(listed.stdout.split("\0").filter(Boolean))].slice(
        0,
        MAX_FILES,
      );
    }
  }
  const found: string[] = [];
  await walk(root, "", found);
  return found;
}

async function walk(root: string, dir: string, found: string[]): Promise<void> {
  if (found.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(nodePath.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue;
    const relative = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(root, relative, found);
    else if (entry.isFile()) found.push(relative);
  }
}

/**
 * Exported symbols of a TypeScript or JavaScript module, in source order.
 *
 * Top level only. An export inside a `declare module` block or a namespace is
 * real, but it is rare, and a map is a table of contents rather than an index.
 */
export function scriptSymbols(root: Node): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;

    if (node.children.some((child) => child.type === "default")) {
      symbols.push({ name: "default", kind: "default" });
      continue;
    }

    const declaration = node.childForFieldName("declaration");
    if (declaration !== null) {
      symbols.push(...declared(declaration));
      continue;
    }

    const source = node.childForFieldName("source");
    const clause = node.namedChildren.find(
      (child) => child.type === "export_clause",
    );
    if (clause !== undefined) {
      for (const specifier of clause.namedChildren) {
        if (specifier.type !== "export_specifier") continue;
        const name =
          specifier.childForFieldName("alias") ??
          specifier.childForFieldName("name");
        if (name !== null) symbols.push({ name: name.text, kind: "reexport" });
      }
      continue;
    }

    const namespace = node.namedChildren.find(
      (child) => child.type === "namespace_export",
    );
    if (namespace !== undefined) {
      const name = namespace.namedChildren.at(-1);
      if (name !== undefined)
        symbols.push({ name: name.text, kind: "reexport" });
      continue;
    }

    if (source !== null && node.children.some((child) => child.type === "*")) {
      symbols.push({ name: `* from ${source.text}`, kind: "reexport" });
    }
  }
  return symbols;
}

function declared(node: Node): RepoSymbol[] {
  const named = (kind: RepoSymbol["kind"]): RepoSymbol[] => {
    const name = node.childForFieldName("name");
    return name === null ? [] : [{ name: name.text, kind }];
  };
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
      return named("fn");
    case "class_declaration":
    case "abstract_class_declaration":
      return named("class");
    case "interface_declaration":
      return named("interface");
    case "type_alias_declaration":
      return named("type");
    case "enum_declaration":
      return named("enum");
    case "lexical_declaration":
    case "variable_declaration":
      return node.namedChildren
        .filter((child) => child.type === "variable_declarator")
        .map((child) => child.childForFieldName("name"))
        .filter((name): name is Node => name?.type === "identifier")
        .map((name) => ({ name: name.text, kind: "const" as const }));
    case "ambient_declaration":
      // `export declare const x` — the declaration is one level down.
      return node.namedChildren.flatMap(declared);
    default:
      return [];
  }
}

/**
 * Public top-level definitions of a Python module.
 *
 * Python has no `export`, so "exported" is the convention: a leading
 * underscore is private. `__all__` would be more exact and is not read — it
 * is a runtime list that can be built by code, and a map that half-evaluates
 * Python is worse than one that states its rule.
 */
export function pythonSymbols(root: Node): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  for (const top of root.namedChildren) {
    const node =
      top.type === "decorated_definition"
        ? top.childForFieldName("definition")
        : top;
    if (node === null) continue;
    const kind =
      node.type === "function_definition"
        ? "fn"
        : node.type === "class_definition"
          ? "class"
          : undefined;
    if (kind === undefined) continue;
    const name = node.childForFieldName("name");
    if (name === null || name.text.startsWith("_")) continue;
    symbols.push({ name: name.text, kind });
  }
  return symbols;
}
