// Which of the originating change's modules Penguin copies into an affected fork (#178, design.md Fix
// writes), read through the Artifacts binding. The originating change's own files are its baseline on
// main compared with its checkpoint, in the originating fork. The fork's side is the Python files of
// the part's scopes at the fork head, with the part's patch applied: every module of the change they
// import, then every module of the change those import (`copiedModules` in packages/protocol), is
// copied byte for byte. A module the fork already holds at the checkpoint's bytes is left out. A module
// the fork changed itself is never overwritten: the write is refused with that reason. Nothing here
// runs Git, imports the code or calls a model.

import { applyPatchFile, copiedModules, type ModuleCopy, type PlanFileDiff } from "@penguin/protocol";

import { changedFiles, readFileText, type GitObjectReader } from "./repo-diff.ts";

/** The most Python files of the part's scopes read to find what the fork imports. */
const START_FILE_LIMIT = 2_000;

/** A file's blob hash at a root tree, or null when it is absent or not a file. */
export async function fileHash(reader: Pick<GitObjectReader, "readTree">, tree: string, path: string): Promise<string | null> {
  let current = tree;
  const segments = path.split("/");
  for (const [index, name] of segments.entries()) {
    const entry = (await reader.readTree(current))?.find((each) => each.name === name);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry.type === "tree" ? null : entry.hash;
    if (entry.type !== "tree") return null;
    current = entry.hash;
  }
  return null;
}

/** Each Python file under `prefixes` at a root tree, with its blob hash; a prefix may name one file. */
async function pythonFiles(reader: Pick<GitObjectReader, "readTree">, tree: string, prefixes: readonly string[]): Promise<{ path: string; hash: string }[]> {
  const found = new Map<string, string>();
  for (const prefix of prefixes) {
    const path = prefix.replace(/\/+$/u, "");
    if (path === "") continue;
    const file = await fileHash(reader, tree, path);
    if (file !== null) {
      if (path.endsWith(".py")) found.set(path, file);
      continue;
    }
    const subtree = await subtreeHash(reader, tree, path);
    if (subtree === null) continue;
    for (const each of await changedFiles(reader, null, subtree)) {
      if (each.newHash !== null && each.path.endsWith(".py")) found.set(`${path}/${each.path}`, each.newHash);
    }
  }
  return [...found].map(([path, hash]) => ({ path, hash })).slice(0, START_FILE_LIMIT);
}

async function subtreeHash(reader: Pick<GitObjectReader, "readTree">, tree: string, path: string): Promise<string | null> {
  let current = tree;
  for (const name of path.split("/")) {
    const entry = (await reader.readTree(current))?.find((each) => each.name === name);
    if (entry === undefined || entry.type !== "tree") return null;
    current = entry.hash;
  }
  return current;
}

async function blobText(reader: Pick<GitObjectReader, "readBlob">, hash: string): Promise<string | null> {
  const blob = await reader.readBlob(hash);
  return blob === null ? null : blob.text();
}

/** What a write copies: the copy and each copied module's blob at the checkpoint, or why it may not. */
export type CopyReading =
  | { readonly status: "ok"; readonly copy: ModuleCopy | null; readonly hashes: ReadonlyMap<string, string> }
  | { readonly status: "refused"; readonly message: string };

export interface CopyInput {
  /** The originating fork's reader: it holds the checkpoint and the baseline it was built on. */
  readonly origin: GitObjectReader;
  readonly checkpoint: string;
  readonly baseline: string;
  /** The affected fork's reader and the head the write fast-forwards. */
  readonly fork: GitObjectReader;
  readonly head: string;
  /** The paths of the part's scopes. */
  readonly scopePaths: readonly string[];
  /** The part's patch, applied to the head before its imports are read. */
  readonly patch: readonly PlanFileDiff[];
}

/** The originating change's modules the fork needs and does not hold yet. */
export async function readCopy(input: CopyInput): Promise<CopyReading> {
  const { origin, fork } = input;
  const [source, base, head] = await Promise.all([origin.readCommit(input.checkpoint), origin.readCommit(input.baseline), fork.readCommit(input.head)]);
  if (source === null || base === null) return { status: "refused", message: `the originating checkpoint ${input.checkpoint} or its baseline is not in the originating fork` };
  if (head === null) return { status: "refused", message: `${input.head} is not in the fork` };
  const changed = (await changedFiles(origin, base.treeHash, source.treeHash)).filter((file) => file.newHash !== null && file.path.endsWith(".py"));
  if (changed.length === 0) return { status: "ok", copy: null, hashes: new Map() };
  const texts = new Map<string, string>();
  for (const file of changed) texts.set(file.path, (await blobText(origin, file.newHash as string)) ?? "");
  const patched = new Map(input.patch.map((file) => [file.path, file]));
  const start: string[] = [];
  for (const file of await pythonFiles(fork, head.treeHash, input.scopePaths)) {
    if (patched.has(file.path)) continue;
    start.push((await blobText(fork, file.hash)) ?? "");
  }
  for (const file of input.patch) {
    const applied = applyPatchFile(file, await readFileText(fork, head.treeHash, file.path));
    if (applied.ok && applied.text !== null) start.push(applied.text);
  }
  const byPath = new Map(changed.map((file) => [file.path, file]));
  const paths: string[] = [];
  const hashes = new Map<string, string>();
  for (const path of copiedModules(start, texts)) {
    const file = byPath.get(path);
    if (file === undefined || patched.has(path)) continue;
    const held = await fileHash(fork, head.treeHash, path);
    if (held === file.newHash) continue;
    if (held !== file.oldHash) {
      return { status: "refused", message: `the fork changed ${path} itself, so Penguin does not overwrite it with the originating change's copy` };
    }
    paths.push(path);
    hashes.set(path, file.newHash as string);
  }
  if (paths.length === 0) return { status: "ok", copy: null, hashes };
  return { status: "ok", copy: { source: input.checkpoint, base: input.baseline, paths }, hashes };
}
