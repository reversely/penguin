// The symbols a plan part's patch takes from the project (PRD 0.5 section 4.2 step 3, #132). A patch
// for a running feature is tried on a tree that merges the plan's checkpoint onto the feature's fork
// head with the patch applied. A name the patch's new lines import from a project module must exist in
// that tree: defined in the module at the checkpoint or the fork head, or added by the patch itself.
// Otherwise every trial of the part fails on an import, and propose_plan names the symbol at once.
//
// The scan is plain text over Python source, so no code is run: `from <module> import <names>` on the
// patch's added lines (one line, or a parenthesised list over several), absolute or relative. A module
// that is no file in either tree nor in the patch is a library's, and is left to the tests.

import type { PlanFileDiff } from "@penguin/protocol";

/** One name an added import takes from a module. */
export interface ImportedName {
  /** The patch file and the line of the import in the patched file. */
  readonly file: string;
  readonly line: number;
  /** The module as written, such as `core.time` or `.helpers`. */
  readonly module: string;
  readonly name: string;
  /** The repository paths that hold the module, in the order Python tries them. */
  readonly paths: readonly string[];
}

/** A name a patch imports that exists in neither tree nor in the patch. */
export interface MissingSymbol extends ImportedName {
  /** The module file the name was looked for in. */
  readonly modulePath: string;
}

/** The lines of the patched file that the patch adds, numbered from 1. */
export function addedLines(file: Pick<PlanFileDiff, "hunks">): Set<number> {
  const added = new Set<number>();
  for (const hunk of file.hunks) {
    let line = hunk.newStart;
    for (const text of hunk.lines) {
      if (text.startsWith("+")) added.add(line);
      if (!text.startsWith("-")) line += 1;
    }
  }
  return added;
}

const FROM_IMPORT = /^\s*from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(.*)$/u;
const IDENTIFIER = /^[A-Za-z_]\w*$/u;

/** The repository paths of `module` imported from `file`: `a/b.py` and `a/b/__init__.py`. */
export function modulePaths(module: string, file: string): string[] {
  const dots = /^\.*/u.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).split(".").filter((part) => part !== "");
  let base: string[] = [];
  if (dots > 0) {
    base = file.split("/").slice(0, -1);
    if (dots - 1 > base.length) return [];
    base = base.slice(0, base.length - (dots - 1));
  }
  const segments = [...base, ...rest];
  if (segments.length === 0) return [];
  const stem = segments.join("/");
  return [`${stem}.py`, `${stem}/__init__.py`];
}

/** The import list's names, without aliases or comments; `*` and anything malformed is left out. */
function names(list: string): string[] {
  return list
    .replace(/#.*$/u, "")
    .replace(/[()\\]/gu, "")
    .split(",")
    .map((entry) => entry.trim().split(/\s+as\s+/u)[0]?.trim() ?? "")
    .filter((name) => IDENTIFIER.test(name));
}

/** Each name a `from ... import` statement on an added line of a Python file takes. */
export function importedNames(path: string, text: string, added: ReadonlySet<number>): ImportedName[] {
  if (!path.endsWith(".py")) return [];
  const lines = text.split(/\r?\n/u);
  const found: ImportedName[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = FROM_IMPORT.exec(lines[index] as string);
    if (match === null) continue;
    const start = index;
    let list = match[2] as string;
    // A parenthesised list runs to its closing parenthesis; a backslash continues the line.
    if (list.includes("(") && !list.includes(")")) {
      while (index + 1 < lines.length && !list.includes(")")) list += ` ${lines[++index] as string}`;
    } else {
      while (list.trimEnd().endsWith("\\") && index + 1 < lines.length) list += ` ${lines[++index] as string}`;
    }
    let touched = false;
    for (let line = start + 1; line <= index + 1 && !touched; line += 1) touched = added.has(line);
    if (!touched) continue;
    const module = match[1] as string;
    const paths = modulePaths(module, path);
    for (const name of names(list)) found.push({ file: path, line: start + 1, module, name, paths });
  }
  return found;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether Python source `text` binds `name` at module level: a def or class, an assignment or
 * annotation, or an import that brings it in (a re-export). A plain text scan of unindented lines.
 */
export function bindsName(text: string, name: string): boolean {
  const word = escapeRegExp(name);
  const definition = new RegExp(`^(?:async\\s+def|def|class)\\s+${word}\\b`, "u");
  const assignment = new RegExp(`^${word}\\s*(?::|=(?!=))`, "u");
  const imported = new RegExp(`^(?:from\\s+\\S+\\s+)?import\\s+.*\\b${word}\\b`, "u");
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (definition.test(line) || assignment.test(line)) return true;
    if (!/^(?:from|import)\s/u.test(line)) continue;
    let statement = line;
    if (statement.includes("(") && !statement.includes(")")) {
      while (index + 1 < lines.length && !statement.includes(")")) statement += ` ${lines[++index] as string}`;
    }
    const aliased = new RegExp(`\\bas\\s+${word}\\b`, "u").test(statement);
    const plain = imported.test(statement) && !new RegExp(`\\b${word}\\s+as\\b`, "u").test(statement);
    if (aliased || plain) return true;
  }
  return false;
}

/**
 * Reads one repository path in each tree the trial merges: the patched file when the patch writes it
 * (`patched`, which wins), else the file at the checkpoint and at the fork head. Each absent is null.
 */
export type TreeFiles = (path: string) => Promise<{ readonly patched: string | null | undefined; readonly checkpoint: string | null; readonly head: string | null }>;

/**
 * The names the imports find in no tree: a name counts as present when the patched module binds it,
 * or, for a module the patch leaves alone, when the module at the checkpoint or the fork head binds it,
 * or when it is a submodule file of a package. A module no tree holds is a library's and is skipped.
 */
export async function missingSymbols(imports: readonly ImportedName[], read: TreeFiles): Promise<MissingSymbol[]> {
  const cache = new Map<string, Awaited<ReturnType<TreeFiles>>>();
  const files = async (path: string) => {
    if (!cache.has(path)) cache.set(path, await read(path));
    return cache.get(path) as Awaited<ReturnType<TreeFiles>>;
  };
  const exists = async (path: string): Promise<boolean> => {
    const found = await files(path);
    return found.patched !== undefined ? found.patched !== null : found.checkpoint !== null || found.head !== null;
  };
  const missing: MissingSymbol[] = [];
  for (const each of imports) {
    let modulePath: string | undefined;
    for (const path of each.paths) {
      if (await exists(path)) {
        modulePath = path;
        break;
      }
    }
    if (modulePath === undefined) continue;
    const found = await files(modulePath);
    const texts = found.patched !== undefined ? [found.patched] : [found.checkpoint, found.head];
    if (texts.some((text) => text !== null && bindsName(text, each.name))) continue;
    // `from pkg import mod` names a submodule when pkg is a package holding mod.
    if (modulePath.endsWith("/__init__.py")) {
      const [file, init] = modulePaths(`.${each.name}`, modulePath);
      if ((file !== undefined && (await exists(file))) || (init !== undefined && (await exists(init)))) continue;
    }
    missing.push({ ...each, modulePath });
  }
  return missing;
}
