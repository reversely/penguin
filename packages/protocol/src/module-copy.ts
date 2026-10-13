// Penguin's update of an affected running feature's fork (#178, design.md Fix writes). No agent writes
// code into another person's fork. Penguin's check runner copies the originating change's new or
// changed modules that the fork imports, byte for byte from the originating checkpoint, and the
// plan's rewrite rules rewrite the fork's own call sites (the part's patch). Once the originating
// change reaches main the fork holds main's own bytes of each copied module, so taking main
// conflicts in none of them.
//
// The modules are found by reading imports as text: Penguin never imports or runs the code. A module
// is copied only when it is one of the files the originating change itself added or changed
// (`copyProblem`), and each copied module's own imports are followed the same way.

/** The modules a write copies into the fork and where they come from. */
export interface ModuleCopy {
  /** The originating checkpoint each module is copied from. */
  readonly source: string;
  /** The commit on main the originating change started from: its own changes are base to source. */
  readonly base: string;
  /** The files copied byte for byte, sorted; each one the originating change added or changed. */
  readonly paths: readonly string[];
}

/** The most modules one write copies. */
export const MODULE_COPY_LIMIT = 64;

const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const FROM_IMPORT = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.*)$/u;
const IMPORT = /^\s*import\s+(.+)$/u;

/** One absolute import a file makes: the module and, for `from m import a, b`, the names it takes. */
export interface PythonImport {
  readonly module: string;
  readonly names: readonly string[];
}

/** The absolute imports a Python file states at the start of a line. Relative imports are skipped. */
export function pythonImports(text: string): PythonImport[] {
  const found: PythonImport[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const from = FROM_IMPORT.exec(line);
    if (from !== null) {
      const names = (from[2] as string)
        .replace(/[()\\]/gu, " ")
        .split("#")[0]!
        .split(",")
        .map((name) => name.trim().split(/\s+as\s+/u)[0]!.trim())
        .filter((name) => DOTTED.test(name) && !name.includes("."));
      if (DOTTED.test(from[1] as string)) found.push({ module: from[1] as string, names });
      continue;
    }
    const plain = IMPORT.exec(line);
    if (plain === null) continue;
    for (const part of (plain[1] as string).split("#")[0]!.split(",")) {
      const module = part.trim().split(/\s+as\s+/u)[0]!.trim();
      if (DOTTED.test(module)) found.push({ module, names: [] });
    }
  }
  return found;
}

/**
 * The repository files an import may load: the module as a file or a package, each package above
 * it, and, for `from m import name`, `name` as a submodule of `m`.
 */
export function importedFiles(imported: PythonImport): string[] {
  const parts = imported.module.split(".");
  const files: string[] = [];
  for (let depth = 1; depth < parts.length; depth += 1) files.push(`${parts.slice(0, depth).join("/")}/__init__.py`);
  const path = parts.join("/");
  files.push(`${path}.py`, `${path}/__init__.py`);
  for (const name of imported.names) files.push(`${path}/${name}.py`, `${path}/${name}/__init__.py`);
  return files;
}

/**
 * The originating change's modules a fork needs, sorted: each changed file that one of `start` (the
 * texts of the fork's own files, the patch applied) imports, then each changed file a copied module
 * imports, until none is left. `changed` maps each file the change added or changed to its text at
 * the originating checkpoint.
 */
export function copiedModules(start: Iterable<string>, changed: ReadonlyMap<string, string>): string[] {
  const copied = new Set<string>();
  const pending = [...start];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const imported of pythonImports(text)) {
      for (const path of importedFiles(imported)) {
        const source = changed.get(path);
        if (source === undefined || copied.has(path)) continue;
        copied.add(path);
        pending.push(source);
      }
    }
  }
  return [...copied].sort();
}

/**
 * Why a write may not copy `paths`, or null when it may: a copy must be a file the originating
 * change itself added or changed, which `changed` lists, and no more than MODULE_COPY_LIMIT.
 */
export function copyProblem(paths: readonly string[], changed: ReadonlySet<string>): string | null {
  if (paths.length > MODULE_COPY_LIMIT) return `a write copies at most ${MODULE_COPY_LIMIT} modules`;
  const outside = paths.find((path) => !changed.has(path));
  if (outside !== undefined) return `${outside} is not a file the originating change added or changed, so Penguin does not copy it`;
  return null;
}
