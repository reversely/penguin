// Applying an approved patch to a file and the fix commit's message (#91). The fix writer and Penguin's
// check of the pushed commit both call applyPatchFile, so they agree on the approved fix byte for byte.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyPatchFile, checkFixWriteSpec, fixCommitMessage, formatPatch, parsePatch, type FixWriteSpec, type PlanFileDiff } from "../src/index.ts";

function onlyFile(text: string): PlanFileDiff {
  const parsed = parsePatch(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  const [file] = parsed.files;
  assert.ok(file);
  return file;
}

const RENAME = ["--- a/tax/rounding.py", "+++ b/tax/rounding.py", "@@ -1,3 +1,3 @@", " import x", "-total = price(line)", "+total = price_minor(line)", " done = True", ""].join("\n");

describe("applyPatchFile", () => {
  test("applies each hunk at its stated line and keeps the rest of the file", () => {
    const before = "import x\ntotal = price(line)\ndone = True\ntail = 1\n";
    assert.deepEqual(applyPatchFile(onlyFile(RENAME), before), { ok: true, text: "import x\ntotal = price_minor(line)\ndone = True\ntail = 1\n" });
  });

  test("keeps a file's missing final newline and its CRLF line ends", () => {
    assert.deepEqual(applyPatchFile(onlyFile(RENAME), "import x\ntotal = price(line)\ndone = True"), {
      ok: true,
      text: "import x\ntotal = price_minor(line)\ndone = True",
    });
    assert.deepEqual(applyPatchFile(onlyFile(RENAME), "import x\r\ntotal = price(line)\r\ndone = True\r\n"), {
      ok: true,
      text: "import x\r\ntotal = price_minor(line)\r\ndone = True\r\n",
    });
  });

  test("applies two hunks in order", () => {
    const text = ["--- a/f.py", "+++ b/f.py", "@@ -1,1 +1,1 @@", "-a = 1", "+a = 2", "@@ -4,1 +4,2 @@", " d = 4", "+e = 5", ""].join("\n");
    assert.deepEqual(applyPatchFile(onlyFile(text), "a = 1\nb = 2\nc = 3\nd = 4\n"), { ok: true, text: "a = 2\nb = 2\nc = 3\nd = 4\ne = 5\n" });
  });

  test("adds and deletes whole files", () => {
    const added = onlyFile(["--- /dev/null", "+++ b/new.py", "@@ -0,0 +1,2 @@", "+x = 1", "+y = 2", ""].join("\n"));
    assert.deepEqual(applyPatchFile(added, null), { ok: true, text: "x = 1\ny = 2\n" });
    assert.deepEqual(applyPatchFile(added, "x = 0\n"), { ok: false, message: "new.py already exists at the base" });
    const deleted = onlyFile(["--- a/old.py", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x = 1", "-y = 2", ""].join("\n"));
    assert.deepEqual(applyPatchFile(deleted, "x = 1\ny = 2\n"), { ok: true, text: null });
    assert.equal(applyPatchFile(deleted, "x = 1\ny = 2\nz = 3\n").ok, false);
  });

  test("refuses a hunk that does not match the file at its line, with no offset or fuzz", () => {
    const outcome = applyPatchFile(onlyFile(RENAME), "# moved down\nimport x\ntotal = price(line)\ndone = True\n");
    assert.deepEqual(outcome, { ok: false, message: "tax/rounding.py: the hunk at line 1 does not match the fork at the base" });
    assert.equal(applyPatchFile(onlyFile(RENAME), null).ok, false);
  });
});

describe("the fix commit", () => {
  const fields = {
    partId: "money-minor/v1#2",
    revision: 3,
    target: "tax-rounding",
    approvedBy: "rahul",
    writtenBy: "@ines/money",
    ref: "feature-tax-rounding@1111111111111111111111111111111111111111+patch:sha256:ab",
  };

  test("its message names the part, its revision, the approver, the fix and the writer, and nothing else", () => {
    assert.equal(
      fixCommitMessage(fields),
      [
        "fix(tax-rounding): write merge plan part money-minor/v1#2 revision 3",
        "",
        "Part money-minor/v1#2 revision 3, approved by rahul.",
        "Fix feature-tax-rounding@1111111111111111111111111111111111111111+patch:sha256:ab.",
        "Written by @ines/money.",
        "",
      ].join("\n"),
    );
  });

  test("a writer's spec is checked against its schema", () => {
    const spec: FixWriteSpec = {
      writeId: 7,
      feature: "money-minor",
      planId: "money-minor/v1",
      partId: fields.partId,
      revision: 3,
      kind: "behavioural",
      writer: "agent",
      target: "tax-rounding",
      fork: "feature-tax-rounding",
      branch: "main",
      parent: "1".repeat(40),
      rebased: false,
      paths: ["tax/rounding.py"],
      patch: RENAME,
      message: fixCommitMessage(fields),
    };
    assert.deepEqual(checkFixWriteSpec(spec), []);
    assert.notDeepEqual(checkFixWriteSpec({ ...spec, fork: "main" }), []);
    assert.notDeepEqual(checkFixWriteSpec({ ...spec, branch: "feature" }), []);
    assert.notDeepEqual(checkFixWriteSpec({ ...spec, parent: "HEAD" }), []);
    assert.notDeepEqual(checkFixWriteSpec({ ...spec, extra: true }), []);
  });
});

describe("formatPatch", () => {
  test("writes added, modified and deleted files as a unified diff that parsePatch reads back", () => {
    const text = [
      "--- /dev/null",
      "+++ b/a/new.py",
      "@@ -0,0 +1,1 @@",
      "+x = 1",
      "--- a/a/old.py",
      "+++ b/a/old.py",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-y = 1",
      "+y = 2",
      "--- a/a/gone.py",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-z = 1",
      "",
    ].join("\n");
    const parsed = parsePatch(text);
    assert.ok(parsed.ok);
    assert.equal(formatPatch(parsed.files), text);
  });
});
