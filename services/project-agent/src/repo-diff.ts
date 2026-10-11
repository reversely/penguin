// What a commit changed, read through the Artifacts binding (PRD 0.4 section 8: the Worker reads
// "changed lines, contracts and invariants for plans and reviews"). The binding has no diff,
// so the files come from comparing two root trees one level at a time, skipping every subtree whose
// hash did not change, and each file's changed lines from a line diff of its two blobs (Myers' O(ND)
// algorithm, with the common head and tail trimmed first). Nothing here runs Git or calls a model.

import { PLAN_LIMITS, type PlanFileDiff, type PlanHunk } from "@penguin/protocol";

/** The subset of `ArtifactsCommitMetadata` read here. */
export interface CommitObject {
  readonly hash: string;
  readonly treeHash: string;
  readonly message: string;
  readonly parents: readonly string[];
}

/** The subset of `ArtifactsTreeEntry` read here. */
export interface TreeObjectEntry {
  readonly name: string;
  readonly hash: string;
  readonly type: string;
}

/** The subset of the binding's `ArtifactsRepo` capability read here. */
export interface GitObjectReader {
  readCommit(hash: string): Promise<CommitObject | null>;
  readTree(hash: string): Promise<readonly TreeObjectEntry[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
}

/** A file that differs between two trees, with its blob on each side; null where it is absent. */
export interface ChangedFile {
  readonly path: string;
  readonly oldHash: string | null;
  readonly newHash: string | null;
}

/** Bounds that keep one diff small enough for one SQL row and one RPC answer (PLAN_LIMITS). */
export const DIFF_LIMITS = {
  context: PLAN_LIMITS.diffContext,
  blobBytes: PLAN_LIMITS.diffBlobBytes,
  /** Diff lines kept across every file of one diff; the rest is cut and the diff marked truncated. */
  totalLines: PLAN_LIMITS.diffLines,
  files: PLAN_LIMITS.diffFiles,
  lineLength: PLAN_LIMITS.diffLineLength,
  /** Edit distance past which a file's change is shown as every old line removed and every new line added. */
  maxEdits: 400,
} as const;

/** The first line of a commit message: its subject. */
export function commitSubject(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * The files that differ between two root trees, in path order. `fromTree` null compares against an
 * empty tree. Subtrees with equal hashes are not read.
 */
export async function changedFiles(
  repo: Pick<GitObjectReader, "readTree">,
  fromTree: string | null,
  toTree: string,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  await compareTrees(repo, fromTree, toTree, "", files);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function compareTrees(
  repo: Pick<GitObjectReader, "readTree">,
  fromTree: string | null,
  toTree: string | null,
  prefix: string,
  files: ChangedFile[],
): Promise<void> {
  if (fromTree === toTree) return;
  const [before, after] = await Promise.all([entries(repo, fromTree), entries(repo, toTree)]);
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(name);
    const now = after.get(name);
    if (old?.hash === now?.hash && old?.type === now?.type) continue;
    const path = `${prefix}${name}`;
    const oldTree = old?.type === "tree" ? old.hash : null;
    const newTree = now?.type === "tree" ? now.hash : null;
    if (oldTree !== null || newTree !== null) await compareTrees(repo, oldTree, newTree, `${path}/`, files);
    const oldFile = old !== undefined && old.type !== "tree" ? old.hash : null;
    const newFile = now !== undefined && now.type !== "tree" ? now.hash : null;
    if (oldFile !== newFile) files.push({ path, oldHash: oldFile, newHash: newFile });
  }
}

async function entries(
  repo: Pick<GitObjectReader, "readTree">,
  tree: string | null,
): Promise<Map<string, TreeObjectEntry>> {
  if (tree === null) return new Map();
  const listed = await repo.readTree(tree);
  if (listed === null) throw new Error(`tree ${tree} not found`);
  return new Map(listed.map((entry) => [entry.name, entry]));
}

/**
 * Each file's changed lines as unified-diff hunks, in the order given, within DIFF_LIMITS. `scopeOf`
 * names the scope a path falls in. Returns the files and whether any line or file was cut.
 */
export async function fileDiffs(
  repo: Pick<GitObjectReader, "readBlob">,
  files: readonly ChangedFile[],
  scopeOf: (path: string) => string | null,
): Promise<{ files: PlanFileDiff[]; truncated: boolean }> {
  const diffs: PlanFileDiff[] = [];
  let budget: number = DIFF_LIMITS.totalLines;
  let truncated = files.length > DIFF_LIMITS.files;
  for (const file of files.slice(0, DIFF_LIMITS.files)) {
    const status = file.oldHash === null ? "added" : file.newHash === null ? "deleted" : "modified";
    const base = { path: file.path, scopeId: scopeOf(file.path), status } as const;
    const [old, now] = await Promise.all([blobLines(repo, file.oldHash), blobLines(repo, file.newHash)]);
    if (old.omitted !== null || now.omitted !== null) {
      diffs.push({ ...base, hunks: [], omitted: old.omitted ?? now.omitted });
      continue;
    }
    const hunks: PlanHunk[] = [];
    for (const hunk of lineHunks(old.lines, now.lines)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const lines = hunk.lines.slice(0, budget).map((line) => clip(line, DIFF_LIMITS.lineLength));
      if (lines.length < hunk.lines.length) truncated = true;
      budget -= lines.length;
      hunks.push({ ...hunk, lines });
    }
    diffs.push({ ...base, hunks, omitted: null });
  }
  return { files: diffs, truncated };
}

interface BlobLines {
  readonly lines: string[];
  readonly omitted: "binary" | "too_large" | null;
}

async function blobLines(repo: Pick<GitObjectReader, "readBlob">, hash: string | null): Promise<BlobLines> {
  if (hash === null) return { lines: [], omitted: null };
  const blob = await repo.readBlob(hash);
  // A submodule or a missing object has no blob to read.
  if (blob === null) return { lines: [], omitted: "binary" };
  if (blob.size > DIFF_LIMITS.blobBytes) return { lines: [], omitted: "too_large" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.subarray(0, 8_000).includes(0)) return { lines: [], omitted: "binary" };
  return { lines: splitLines(new TextDecoder().decode(bytes)), omitted: null };
}

/** A text's lines without their line ends; a final line end adds no empty line. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Edit = "=" | "-" | "+";

/**
 * Unified-diff hunks turning `before` into `after`, each line prefixed with " ", "-" or "+", with
 * `context` unchanged lines around each change. Line numbers start at 1; an empty side starts at 0.
 */
export function lineHunks(
  before: readonly string[],
  after: readonly string[],
  context: number = DIFF_LIMITS.context,
): PlanHunk[] {
  const edits = editScript(before, after);
  const hunks: PlanHunk[] = [];
  // Position of each edit in the old and new file.
  const positions: { edit: Edit; oldIndex: number; newIndex: number }[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const edit of edits) {
    positions.push({ edit, oldIndex, newIndex });
    if (edit !== "+") oldIndex += 1;
    if (edit !== "-") newIndex += 1;
  }
  let at = 0;
  while (at < positions.length) {
    const firstChange = positions.findIndex((p, index) => index >= at && p.edit !== "=");
    if (firstChange < 0) break;
    const start = Math.max(at, firstChange - context);
    let end = firstChange;
    // Extend over changes separated by at most 2 * context unchanged lines.
    for (let index = firstChange; index < positions.length; index += 1) {
      if ((positions[index] as { edit: Edit }).edit !== "=") end = index;
      else if (index - end > 2 * context) break;
    }
    const stop = Math.min(positions.length, end + context + 1);
    const slice = positions.slice(start, stop);
    const lines = slice.map((p) => {
      const text = p.edit === "+" ? (after[p.newIndex] as string) : (before[p.oldIndex] as string);
      return `${p.edit === "=" ? " " : p.edit}${text}`;
    });
    const oldLines = slice.filter((p) => p.edit !== "+").length;
    const newLines = slice.filter((p) => p.edit !== "-").length;
    const first = slice[0] as { oldIndex: number; newIndex: number };
    hunks.push({
      oldStart: oldLines === 0 ? first.oldIndex : first.oldIndex + 1,
      oldLines,
      newStart: newLines === 0 ? first.newIndex : first.newIndex + 1,
      newLines,
      lines,
    });
    at = stop;
  }
  return hunks;
}

/** The shortest edit script from `a` to `b`, or a full replacement past DIFF_LIMITS.maxEdits edits. */
function editScript(a: readonly string[], b: readonly string[]): Edit[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const middle = myers(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  return [...Array<Edit>(head).fill("="), ...middle, ...Array<Edit>(tail).fill("=")];
}

function myers(a: readonly string[], b: readonly string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, DIFF_LIMITS.maxEdits);
  // trace[d] holds the furthest x on each diagonal k in -d..d, at index k + d, before step d.
  const trace: Int32Array[] = [];
  let v = new Int32Array(3);
  for (let d = 0; d <= limit; d += 1) {
    const next = new Int32Array(2 * d + 3);
    const at = (row: Int32Array, depth: number, k: number): number => row[k + depth] ?? 0;
    for (let k = -d; k <= d; k += 2) {
      const previous = d - 1;
      const down = k === -d || (k !== d && at(v, previous, k - 1) < at(v, previous, k + 1));
      let x = d === 0 ? 0 : down ? at(v, previous, k + 1) : at(v, previous, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, n, m);
      }
    }
    trace.push(next);
    v = next;
  }
  return [...Array<Edit>(n).fill("-"), ...Array<Edit>(m).fill("+")];
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d - 1] as Int32Array;
    const depth = d - 1;
    const at = (k: number): number => v[k + depth] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      edits.push("=");
      x -= 1;
      y -= 1;
    }
    edits.push(down ? "+" : "-");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    edits.push("=");
    x -= 1;
    y -= 1;
  }
  return edits.reverse();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
