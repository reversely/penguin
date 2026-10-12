// The form of a merge plan's rewrite rules, as the Worker checks it before any runner parses one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRewriteRules, rewriteRulesKey, type RewriteRule } from "../src/index.ts";

const DISPLAY: RewriteRule = {
  id: "display",
  contract: "shared/money/__init__.py::display",
  kind: "expression",
  pattern: "money.display($amount)",
  replacement: "$amount.display()",
  imports: [],
};

test("a plan's rules keep their order and only their known fields; absent is none", () => {
  assert.deepEqual(parseRewriteRules(undefined), []);
  const annotation = { ...DISPLAY, id: "price-annotation", kind: "annotation", pattern: "float", replacement: "money.Money", imports: [{ module: "decimal", name: "Decimal" }] };
  assert.deepEqual(parseRewriteRules([DISPLAY, annotation]), [DISPLAY, annotation]);
  // The key ignores the order of each rule's fields, not the order of the rules.
  const reordered = { imports: [], replacement: DISPLAY.replacement, pattern: DISPLAY.pattern, kind: DISPLAY.kind, contract: DISPLAY.contract, id: DISPLAY.id };
  assert.equal(rewriteRulesKey([reordered]), rewriteRulesKey([DISPLAY]));
  assert.notEqual(rewriteRulesKey([DISPLAY, annotation as RewriteRule]), rewriteRulesKey([annotation as RewriteRule, DISPLAY]));
});

test("a rule of the wrong form is refused with the field that breaks it", () => {
  const bad: [unknown, RegExp][] = [
    [{}, /rules must be an array/u],
    [[{ ...DISPLAY, code: "import os" }], /unknown field code/u],
    [[{ ...DISPLAY, id: "Display Rule" }], /id must be lowercase/u],
    [[{ ...DISPLAY, contract: "shared/money/__init__.py" }], /path::symbol/u],
    [[{ ...DISPLAY, contract: "shared/money/__init__.py::Money.display" }], /module-level name/u],
    [[{ ...DISPLAY, kind: "exec" }], /kind must be one of expression, annotation/u],
    [[{ ...DISPLAY, pattern: "" }], /pattern must be a Python expression/u],
    [[{ ...DISPLAY, replacement: "x".repeat(501) }], /replacement must be a Python expression/u],
    [[{ ...DISPLAY, pattern: "money.display($)" }], /a \$ must start a placeholder/u],
    [[{ ...DISPLAY, pattern: "money.display($a, $a)" }], /appears twice/u],
    [[{ ...DISPLAY, replacement: "$other.display()" }], /\$other, which the pattern does not bind/u],
    [[{ ...DISPLAY, kind: "annotation" }], /takes no placeholders/u],
    [[{ ...DISPLAY, imports: [{ module: "os; rm -rf /", name: "x" }] }], /an import is/u],
    [[DISPLAY, DISPLAY], /two rules share the id display/u],
    [Array.from({ length: 33 }, (_, index) => ({ ...DISPLAY, id: `r${index}` })), /at most 32 rules/u],
  ];
  for (const [value, message] of bad) {
    const parsed = parseRewriteRules(value);
    assert.equal(typeof parsed, "string", JSON.stringify(value).slice(0, 200));
    assert.match(parsed as string, message);
  }
});
