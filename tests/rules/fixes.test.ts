// How a proposed fix is checked before anyone writes it (PRD 0.5 sections 4.2 and 4.4): a patch must
// apply exactly to the fork it targets, and a declared rewrite rule must be well formed, since Penguin
// applies it with no agent.

import assert from "node:assert/strict";
import test from "node:test";

import { applyPatchFile, parsePatch, parseRewriteRules } from "@penguin/protocol";

const PATCH = [
  "diff --git a/analytics/weekly.py b/analytics/weekly.py",
  "--- a/analytics/weekly.py",
  "+++ b/analytics/weekly.py",
  "@@ -1,2 +1,2 @@",
  "-from shared.dates import start_of_day",
  "+from shared.dates import start_of_local_day",
  " WEEK = 7",
  "",
].join("\n");

test("a patch applies to the text it was made against", () => {
  const parsed = parsePatch(PATCH);
  assert.ok(parsed.ok);
  const applied = applyPatchFile(parsed.files[0]!, "from shared.dates import start_of_day\nWEEK = 7\n");
  assert.deepEqual(applied, { ok: true, text: "from shared.dates import start_of_local_day\nWEEK = 7\n" });
});

test("a patch whose context no longer matches the fork is refused", () => {
  const parsed = parsePatch(PATCH);
  assert.ok(parsed.ok);
  assert.equal(applyPatchFile(parsed.files[0]!, "import os\nWEEK = 7\n").ok, false);
});

test("a well-formed rewrite rule is accepted", () => {
  const rules = parseRewriteRules([{ id: "price-times", contract: "shared/money.py::price", kind: "expression", pattern: "money.price($a * $q)", replacement: "$a.times($q)", imports: [] }]);
  assert.ok(Array.isArray(rules));
});

test("a rewrite rule without a contract is refused", () => {
  assert.equal(typeof parseRewriteRules([{ id: "bad", kind: "expression", pattern: "x", replacement: "y" }]), "string");
});
