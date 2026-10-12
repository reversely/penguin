// PRD 0.5 section 4.2 step 2 (Migrate): the remaining callers of a retiring symbol are grouped by
// owner, on main and in running features' own changes. The defining scope's own module and tests are
// not callers; they leave with the contract step.

import assert from "node:assert/strict";
import test from "node:test";

import { migrationGroups, type ImpactReport, type RetiringDeclaration } from "@penguin/protocol";

const declaration = {
  contract: "shared/money.py::price",
  replacement: "shared/money.py::Money",
  feature: "money-minor-units",
  planId: "plan-1",
  person: "ines",
  rules: [],
  recordId: "r1",
  declaredAt: "2026-10-12T00:00:00Z",
} as RetiringDeclaration;

const use = (path: string, scope: string | null) => ({ path, line: 4, kind: "call", symbol: "shared.money.price", name: "price", scope });

const impact = {
  headUses: [use("tax/invoice.py", "tax"), use("checkout/cart.py", "checkout"), use("shared/money.py", "money"), use("shared/tests/test_money.py", "money")],
  forks: [{ id: "basket-size", sha: "c".repeat(40), scopes: ["analytics"], uses: [use("analytics/basket.py", "analytics")] }],
} as unknown as ImpactReport;

const dri: Record<string, string> = { tax: "rahul", checkout: "priya", money: "ines", analytics: "jun" };
const scopeOf = (path: string) => (path.startsWith("shared/") ? "money" : path.split("/")[0]);

test("callers group by the owner of their place, on main and in running features", () => {
  const { groups } = migrationGroups(impact, [declaration], (scope) => dri[scope], () => "jun", scopeOf);
  assert.deepEqual(
    groups.map((group) => [group.owner, group.uses]),
    [["jun", 1], ["priya", 1], ["rahul", 1]],
  );
});

test("the defining module and its scope's tests are not callers", () => {
  const { groups } = migrationGroups(impact, [declaration], (scope) => dri[scope], () => "jun", scopeOf);
  assert.ok(!groups.some((group) => group.owner === "ines"));
});

test("a caller in a scope with no owner is counted as unowned, not dropped silently", () => {
  const orphan = { headUses: [use("legacy/old.py", null)], forks: [] } as unknown as ImpactReport;
  assert.equal(migrationGroups(orphan, [declaration], () => undefined, () => undefined, () => undefined).unowned, 1);
});
