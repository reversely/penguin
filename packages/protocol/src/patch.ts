// A unified diff as a merge plan carries it (PRD 0.4 section 4.2): the proposed fix for a running
// feature, written against that feature's fork head and applied there once its person approves. Only
// text edits of regular files are taken: added, modified and deleted files with their hunks. A rename,
// a copy, a mode change or a binary file is refused, as is a path that leaves the repository.

import type { PlanFileDiff, PlanHunk } from "./plan.ts";

export const PATCH_LIMITS = { bytes: 256 * 1024, files: 60, lines: 20_000, pathLength: 512 } as const;

export type PatchParse = { readonly ok: true; readonly files: PlanFileDiff[] } | { readonly ok: false; readonly message: string };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/u;
// Git's extended header lines that change more than text.
const REFUSED = /^(?:rename from|rename to|copy from|copy to|old mode|new mode|similarity index|dissimilarity index|Binary files|GIT binary patch)/u;
// Git's extended header lines that carry nothing the hunks do not.
const IGNORED = /^(?:diff --git |index |new file mode |deleted file mode )/u;

/** A path from a `---` or `+++` line, without its `a/` or `b/` prefix; null for /dev/null; undefined when unsafe. */
function headerPath(line: string): string | null | undefined {
  const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
  if (raw === "/dev/null") return null;
  const path = raw.replace(/^[ab]\//u, "");
  if (path.length === 0 || path.length > PATCH_LIMITS.pathLength) return undefined;
  return path.split("/").every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..") ? path : undefined;
}

/** Parses a unified diff into its files and hunks, refusing anything but text edits of regular files. */
export function parsePatch(text: string): PatchParse {
  if (new TextEncoder().encode(text).length > PATCH_LIMITS.bytes) return { ok: false, message: `the patch is over ${PATCH_LIMITS.bytes} bytes` };
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > PATCH_LIMITS.lines) return { ok: false, message: `the patch is over ${PATCH_LIMITS.lines} lines` };
  const files: PlanFileDiff[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (REFUSED.test(line)) return { ok: false, message: `line ${index + 1}: renames, copies, mode changes and binary files are not taken` };
    if (IGNORED.test(line) || line.trim() === "") {
      index += 1;
      continue;
    }
    if (!line.startsWith("--- ") || !(lines[index + 1] ?? "").startsWith("+++ ")) {
      return { ok: false, message: `line ${index + 1}: expected a --- and +++ file header` };
    }
    const before = headerPath(line);
    const after = headerPath(lines[index + 1] as string);
    if (before === undefined || after === undefined || (before === null && after === null)) {
      return { ok: false, message: `line ${index + 1}: a path must be relative, of letters, digits, '_', '.', '-' and '/'` };
    }
    if (before !== null && after !== null && before !== after) return { ok: false, message: `line ${index + 1}: renames are not taken` };
    index += 2;
    const hunks: PlanHunk[] = [];
    while (index < lines.length && HUNK.test(lines[index] as string)) {
      const header = HUNK.exec(lines[index] as string) as RegExpExecArray;
      const hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
      };
      index += 1;
      const body: string[] = [];
      let oldSeen = 0;
      let newSeen = 0;
      while (index < lines.length && (oldSeen < hunk.oldLines || newSeen < hunk.newLines)) {
        const entry = lines[index] as string;
        if (entry.startsWith("\\")) {
          index += 1;
          continue;
        }
        const mark = entry[0];
        if (mark !== " " && mark !== "-" && mark !== "+") return { ok: false, message: `line ${index + 1}: a hunk line must start with ' ', '-' or '+'` };
        if (mark !== "+") oldSeen += 1;
        if (mark !== "-") newSeen += 1;
        body.push(entry);
        index += 1;
      }
      if (oldSeen !== hunk.oldLines || newSeen !== hunk.newLines) return { ok: false, message: `line ${index}: a hunk's lines do not match its header` };
      while (index < lines.length && (lines[index] as string).startsWith("\\")) index += 1;
      hunks.push({ ...hunk, lines: body });
    }
    if (hunks.length === 0) return { ok: false, message: `line ${index}: a file without hunks` };
    const path = (after ?? before) as string;
    files.push({ path, scopeId: null, status: before === null ? "added" : after === null ? "deleted" : "modified", hunks, omitted: null });
    if (files.length > PATCH_LIMITS.files) return { ok: false, message: `the patch changes more than ${PATCH_LIMITS.files} files` };
  }
  if (files.length === 0) return { ok: false, message: "the patch changes no file" };
  if (new Set(files.map((file) => file.path)).size !== files.length) return { ok: false, message: "the patch names one file twice" };
  return { ok: true, files };
}

/**
 * Where the file's hunks do not apply to `before`, the file's lines at the patch's base (null when the
 * file is absent there), or null when every hunk applies at its stated line.
 */
export function patchMismatch(file: PlanFileDiff, before: readonly string[] | null): string | null {
  if (file.status === "added") return before === null ? null : `${file.path} already exists at the base`;
  if (before === null) return `${file.path} is not in the fork at the base`;
  for (const hunk of file.hunks) {
    const expected = hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const actual = before.slice(start, start + expected.length);
    if (actual.length !== expected.length || actual.some((line, offset) => line !== expected[offset])) {
      return `${file.path}: the hunk at line ${hunk.oldStart} does not match the fork at the base`;
    }
  }
  if (file.status === "deleted" && file.hunks.reduce((sum, hunk) => sum + hunk.oldLines, 0) !== before.length) {
    return `${file.path}: the deletion does not cover the whole file`;
  }
  return null;
}

export type PatchApply = { readonly ok: true; readonly text: string | null } | { readonly ok: false; readonly message: string };

/**
 * The file's text once its hunks are applied to `before`, its text at the patch's base (null when the
 * file is absent there), or null for a deletion. Every hunk must match at its stated line, as
 * `patchMismatch` checks; nothing is applied with an offset or fuzz. Lines split at "\n", so a file's
 * own line endings and its final newline are kept; an added file ends with a newline.
 *
 * The fix writer (the originating agent's bridge or the check runner) commits this text. Penguin
 * compares the pushed commit with it, so both sides compute the approved fix the same way.
 */
export function applyPatchFile(file: PlanFileDiff, before: string | null): PatchApply {
  if (file.status === "added") {
    if (before !== null) return { ok: false, message: `${file.path} already exists at the base` };
    const added = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)));
    return { ok: true, text: `${added.join("\n")}\n` };
  }
  if (before === null) return { ok: false, message: `${file.path} is not in the fork at the base` };
  const endsWithNewline = before.endsWith("\n");
  const lines = before.length === 0 ? [] : (endsWithNewline ? before.slice(0, -1) : before).split("\n");
  // A line of a file with CRLF endings, read here as "text\r", matches the patch's "text".
  const mismatch = patchMismatch(file, lines.map((line) => line.replace(/\r$/u, "")));
  if (mismatch !== null) return { ok: false, message: mismatch };
  if (file.status === "deleted") return { ok: true, text: null };
  // A file whose every line ends in CRLF gets CRLF on the lines the patch adds too.
  const end = lines.length > 0 && lines.every((line) => line.endsWith("\r")) ? "\r" : "";
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor) return { ok: false, message: `${file.path}: the hunk at line ${hunk.oldStart} overlaps the one before it` };
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        out.push(`${line.slice(1)}${end}`);
        continue;
      }
      if (line.startsWith(" ")) out.push(lines[cursor] as string);
      cursor += 1;
    }
  }
  out.push(...lines.slice(cursor));
  return { ok: true, text: out.length === 0 ? "" : `${out.join("\n")}${endsWithNewline ? "\n" : ""}` };
}
