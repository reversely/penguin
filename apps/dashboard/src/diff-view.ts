// A unified diff as the change tree shows it: each hunk's lines numbered on the old and the new side,
// and each file's count of added and removed lines. Pure, so the numbering is tested without a browser
// (test/diff-view.test.ts).

import type { PlanHunk } from "@penguin/protocol";

export interface DiffRow {
  readonly kind: "add" | "remove" | "context";
  /** The line's number in the old file, or null for an added line. */
  readonly old: number | null;
  /** The line's number in the new file, or null for a removed line. */
  readonly new: number | null;
  /** The line without its " ", "-" or "+" prefix. */
  readonly text: string;
}

/** A hunk's lines numbered from its starts: context and removed lines count on the old side, context and added on the new. */
export function hunkRows(hunk: Pick<PlanHunk, "oldStart" | "newStart" | "lines">): DiffRow[] {
  let old = hunk.oldStart;
  let next = hunk.newStart;
  return hunk.lines.map((line) => {
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "+") return { kind: "add", old: null, new: next++, text };
    if (mark === "-") return { kind: "remove", old: old++, new: null, text };
    return { kind: "context", old: old++, new: next++, text };
  });
}

/** A hunk's header as unified diff prints it: `@@ -12,4 +12,6 @@`. */
export function hunkHeader(hunk: PlanHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** Added and removed lines across a file's hunks. */
export function lineCounts(hunks: readonly Pick<PlanHunk, "lines">[]): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}
