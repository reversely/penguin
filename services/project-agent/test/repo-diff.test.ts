// The tree diff and line hunks the Worker reads out of Artifacts for a merge plan's changed lines,
// checked against Git itself: a reader that answers readCommit, readTree and readBlob from a real
// repository stands in for the binding, and `git diff` on the same commits is the expected answer.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { PlanHunk } from "@penguin/protocol";

import { changedFiles, fileDiffs, lineHunks } from "../src/repo-diff.ts";
import { gitReader } from "./git-reader.ts";

const ISOLATED = ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...ISOLATED, ...args], { cwd, encoding: "utf8" });
}

function write(root: string, files: Record<string, string | Buffer | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) {
      rmSync(full);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

/** `git diff -U3` of one file between two commits, as hunks. */
function gitHunks(root: string, from: string, to: string, path: string): PlanHunk[] {
  const out = git(root, "diff", "--no-color", "--no-indent-heuristic", "--diff-algorithm=myers", "-U3", from, to, "--", path);
  const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] = [];
  for (const line of out.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header !== null) {
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      });
    } else if (hunks.length > 0 && /^[ +-]/u.test(line) && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
      hunks.at(-1)?.lines.push(line);
    }
  }
  return hunks;
}

const lines = (count: number, label: string) => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

describe("reading a commit's changes through the binding's object reads", () => {
  let root: string;
  let base: string;
  let head: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "penguin-repo-diff-"));
    git(root, "init", "-q", "-b", "main");
    write(root, {
      "ingestion/identity_map.py": lines(40, "rule"),
      "ingestion/tests/test_map.py": lines(5, "test"),
      "analytics/models.py": lines(10, "model"),
      "docs/notes.md": "unchanged\n",
      "ingestion/logo.bin": Buffer.from([0, 1, 2, 3]),
    });
    base = commit(root, "Base");
    const changed = lines(40, "rule").split("\n");
    changed[4] = "rule 5, limited to five identities per device";
    changed.splice(30, 2, "rule 31 and 32 merged");
    write(root, {
      "ingestion/identity_map.py": changed.join("\n"),
      "ingestion/limits.py": "MAX_IDENTITIES_PER_DEVICE = 1\n",
      "ingestion/tests/test_map.py": null,
      "analytics/models.py": lines(10, "model").replace("model 3", "model three"),
      "ingestion/logo.bin": Buffer.from([0, 1, 2, 4]),
    });
    head = commit(root, "Limit identities per device\n\nA tablet joins at most one person.");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test("changedFiles lists what git diff lists, reading no tree whose hash did not change", async () => {
    const reader = gitReader(root);
    const [from, to] = await Promise.all([reader.readCommit(base), reader.readCommit(head)]);
    reader.calls.length = 0;
    const files = await changedFiles(reader, from?.treeHash ?? null, to?.treeHash as string);
    const expected = git(root, "diff", "--name-only", base, head).trim().split("\n");
    assert.deepEqual(
      files.map((file) => file.path),
      expected,
    );
    assert.deepEqual(
      files.find((file) => file.path === "ingestion/limits.py"),
      { path: "ingestion/limits.py", oldHash: null, newHash: git(root, "rev-parse", `${head}:ingestion/limits.py`).trim() },
    );
    // Two root trees, two `ingestion/` trees, two `analytics/` trees and the deleted `ingestion/tests/`; never `docs/`.
    assert.equal(reader.calls.filter((call) => call === "readTree").length, 7);
  });

  test("each file's hunks are the ones git diff -U3 prints", async () => {
    const reader = gitReader(root);
    const [from, to] = await Promise.all([reader.readCommit(base), reader.readCommit(head)]);
    const files = await changedFiles(reader, from?.treeHash ?? null, to?.treeHash as string);
    const { files: diffs, truncated } = await fileDiffs(reader, files, (path) => path.split("/")[0] ?? null);
    assert.equal(truncated, false);
    for (const diff of diffs) {
      if (diff.omitted !== null) continue;
      assert.deepEqual(diff.hunks, gitHunks(root, base, head, diff.path), diff.path);
    }
    assert.deepEqual(
      diffs.map((diff) => [diff.path, diff.status, diff.scopeId, diff.omitted, diff.hunks.length]),
      [
        ["analytics/models.py", "modified", "analytics", null, 1],
        ["ingestion/identity_map.py", "modified", "ingestion", null, 2],
        ["ingestion/limits.py", "added", "ingestion", null, 1],
        ["ingestion/logo.bin", "modified", "ingestion", "binary", 0],
        ["ingestion/tests/test_map.py", "deleted", "ingestion", null, 1],
      ],
    );
  });
});

test("lineHunks merges changes closer than twice the context and numbers an empty side from 0", () => {
  assert.deepEqual(lineHunks([], ["a", "b"]), [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }]);
  assert.deepEqual(lineHunks(["a"], []), [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-a"] }]);
  const before = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
  const after = before.map((line) => (line === "l2" || line === "l8" ? `${line}!` : line));
  const [hunk, ...rest] = lineHunks(before, after);
  assert.deepEqual(rest, []);
  assert.deepEqual([hunk?.oldStart, hunk?.oldLines, hunk?.newStart, hunk?.newLines], [1, 11, 1, 11]);
  assert.equal(lineHunks(before, before).length, 0);
});
