import assert from "node:assert/strict";
import { test } from "node:test";

import { InvariantsFileError, parseInvariantsBytes, parseInvariantsFile, parseScopeMap } from "@penguin/scope-map";

const MAP = parseScopeMap({
  scopes: [
    { id: "analytics", name: "Analytics", owner: "jun", paths: ["analytics/"], test_command: "pytest analytics", depends_on: [] },
    { id: "tax", name: "Tax", owner: "rahul", paths: ["tax/"], test_command: "pytest tax", depends_on: [] },
  ],
});

const valid = {
  $comment: "test invariants",
  invariants: [
    { id: "tablet-patrons-separate", scope: "analytics", statement: "Patrons who log in on one library tablet stay separate people", protected: true },
    { id: "tax-per-line", scope: "tax", statement: "Tax is rounded per line item" },
  ],
  examples: [{ scope: "analytics", file: "./analytics/examples/dau.json", invariants: ["tablet-patrons-separate"] }],
};

test("the invariants file loads each invariant and examples file", () => {
  const file = parseInvariantsFile(valid, MAP);
  assert.deepEqual(file.invariants, [
    { id: "tablet-patrons-separate", scopeId: "analytics", statement: "Patrons who log in on one library tablet stay separate people", protected: true },
    { id: "tax-per-line", scopeId: "tax", statement: "Tax is rounded per line item", protected: false },
  ]);
  assert.deepEqual(file.examples, [{ scopeId: "analytics", file: "analytics/examples/dau.json", invariants: ["tablet-patrons-separate"] }]);
  assert.deepEqual(parseInvariantsBytes(null, MAP), { invariants: [], examples: [] });
});

test("a malformed invariants file is refused with every problem", () => {
  const bad = {
    invariants: [
      { id: "Tax Per Line", scope: "tax", statement: "x" },
      { id: "dup", scope: "tax", statement: "one" },
      { id: "dup", scope: "tax", statement: "two" },
      { id: "nowhere", scope: "billing", statement: "three" },
      { id: "multi", scope: "tax", statement: "line one\nline two" },
      { id: "flag", scope: "tax", statement: "four", protected: "yes" },
      { id: "extra", scope: "tax", statement: "five", run: "rm -rf /" },
    ],
    examples: [
      { scope: "analytics", file: "../outside.json" },
      { scope: "analytics", file: "tax/examples.json" },
      { scope: "analytics", file: "analytics/e.json", invariants: ["dup"] },
    ],
    extra: true,
  };
  assert.throws(
    () => parseInvariantsFile(bad, MAP),
    (error: unknown) => {
      assert.ok(error instanceof InvariantsFileError);
      assert.deepEqual(
        error.issues.map((issue) => issue.field),
        [
          "extra",
          "invariants[0].id",
          "invariants[2].id",
          "invariants[3].scope",
          "invariants[4].statement",
          "invariants[5].protected",
          "invariants[6].run",
          "examples[0].file",
          "examples[1].file",
          "examples[2].invariants",
        ],
      );
      return true;
    },
  );
  assert.throws(() => parseInvariantsBytes("{not json", MAP), InvariantsFileError);
  assert.throws(() => parseInvariantsFile([], MAP), InvariantsFileError);
});
