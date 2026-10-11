// A plan part's fix is mechanical exactly when the resolution ladder's step 3 codemod could have
// written it: every changed line swaps names as a codemod edit of the contract diff does
// (codemodPlan in @penguin/protocol). The parts' patches parse and apply as `git diff` prints them.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  codemodPlan,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  parsePatch,
  patchMismatch,
  type ImpactReport,
  type PlanFileDiff,
} from "@penguin/protocol";

import { classifyFix } from "../src/propose-plan.ts";

const SHA = "a".repeat(40);
const use = (path: string, symbol: string, kind: "call" | "import" = "call") => ({ path, line: 1, kind, symbol, name: symbol.split(".").at(-1) as string, scope: "tax" });

function report(changes: ImpactReport["changes"], signatures: ImpactReport["signatures"], uses: ReturnType<typeof use>[]): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base: SHA,
    head: SHA,
    changes,
    signatures,
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [],
    forks: [{ id: "tax-rounding", sha: SHA, scopes: ["tax"], uses, errors: [] }],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 1, head: 1, parsed: 1 },
  };
}

const file = (lines: string[]): PlanFileDiff[] => [
  { path: "tax/a.py", scopeId: "tax", status: "modified", omitted: null, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }] },
];

test("a move and a renamed keyword are mechanical, as the codemod's edits; anything more is behavioural", () => {
  const moved = report(
    [
      {
        symbol: "shared.money.price",
        path: "shared/money.py",
        line: 1,
        kind: "function",
        change: "moved",
        scope: "money",
        contract: null,
        to: { symbol: "shared.pricing.price", path: "shared/pricing.py", line: 1 },
      },
    ],
    [],
    [use("tax/a.py", "shared.money.price", "import")],
  );
  assert.deepEqual(codemodPlan(moved, "tax-rounding").edits, [{ kind: "move", from: "shared.money.price", to: "shared.pricing.price" }]);
  assert.equal(classifyFix(file(["-from shared.money import price", "+from shared.pricing import price"]), moved, "tax-rounding").kind, "mechanical");
  // The same swap where no codemod edit reaches (main has no use of the symbol) is behavioural.
  assert.equal(classifyFix(file(["-from shared.money import price", "+from shared.pricing import price"]), moved, null).kind, "behavioural");

  const keyword = report(
    [{ symbol: "shared.money.price", path: "shared/money.py", line: 1, kind: "function", change: "modified", scope: "money", contract: null }],
    [
      {
        symbol: "shared.money.price",
        path: "shared/money.py",
        line: 1,
        before: "price(item, cents)",
        after: "price(item, minor)",
        added: [{ name: "minor", required: true }],
        removed: ["cents"],
        breaking: true,
        reasons: ["cents removed"],
      },
    ],
    [use("tax/a.py", "shared.money.price")],
  );
  assert.equal(classifyFix(file(["-total = price(line, cents=2)", "+total = price(line, minor=2)"]), keyword, "tax-rounding").kind, "mechanical");
  const extra = classifyFix(file(["-total = price(line, cents=2)", "+total = price(line, minor=2, offset=1)"]), keyword, "tax-rounding");
  assert.deepEqual(extra, { kind: "behavioural", reason: "tax/a.py:1 changes more than a codemod edit of the contract diff swaps" });
});

test("a patch parses as git diff prints it and applies only where its lines match", () => {
  const text = [
    "diff --git a/tax/a.py b/tax/a.py",
    "index 1111111..2222222 100644",
    "--- a/tax/a.py",
    "+++ b/tax/a.py",
    "@@ -1,2 +1,2 @@",
    " import x",
    "-y = 1",
    "+y = 2",
    "diff --git a/tax/b.py b/tax/b.py",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/tax/b.py",
    "@@ -0,0 +1 @@",
    "+z = 3",
    "",
  ].join("\n");
  const parsed = parsePatch(text);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const [modified, added] = parsed.files;
  assert.deepEqual([modified?.path, modified?.status, added?.path, added?.status], ["tax/a.py", "modified", "tax/b.py", "added"]);
  assert.equal(patchMismatch(modified as PlanFileDiff, ["import x", "y = 1"]), null);
  assert.match(patchMismatch(modified as PlanFileDiff, ["import x", "y = 9"]) ?? "", /does not match/u);
  assert.equal(patchMismatch(added as PlanFileDiff, null), null);
  assert.match(patchMismatch(added as PlanFileDiff, ["z = 0"]) ?? "", /already exists/u);

  for (const bad of [
    "--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n",
    "--- a/x.py\n+++ b/y.py\n@@ -1 +1 @@\n-a\n+b\n",
    "diff --git a/x.py b/y.py\nrename from x.py\nrename to y.py\n",
    "--- a/x.py\n+++ b/x.py\nBinary files differ\n",
    "--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-a\n+b\n",
    "rm -rf /\n",
    "",
  ]) {
    assert.equal(parsePatch(bad).ok, false, JSON.stringify(bad));
  }
});
