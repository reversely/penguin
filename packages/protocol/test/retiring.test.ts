// Retiring symbols (#113, PRD 0.5 section 4.2 step 2): the declaration's form, the next step a new
// call gets through the resolution ladder, the migration groups by owner, and the tool result that
// carries them.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  contractDottedName,
  contractRemoved,
  countIsComplete,
  inDefiningFiles,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  migrationGroups,
  parseRetiring,
  parseToolResult,
  retiringCallDecisions,
  retiringCallerCounts,
  TOOL_RESULT_SCHEMA_VERSION,
  type AgentToolResult,
  type ImpactReport,
  type ImpactUse,
  type RetiringDeclaration,
  type RewriteRule,
  type RoutingContext,
} from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);

const DISPLAY_RULE: RewriteRule = {
  id: "display",
  contract: "shared/money/__init__.py::display",
  kind: "expression",
  pattern: "money.display($amount)",
  replacement: "$amount.display()",
  imports: [],
};

const declaration = (contract: string, replacement: string, rules: RewriteRule[] = []): RetiringDeclaration => ({
  contract,
  replacement,
  feature: "money-type",
  planId: "money-type/v1",
  person: "ines",
  rules,
  recordId: "record-1",
  declaredAt: "2026-03-11T17:00:00.000Z",
});

const RETIRING = [
  declaration("shared/money/__init__.py::display", "shared/money/__init__.py::Money.display", [DISPLAY_RULE]),
  declaration("orders/model.py::line_total", "orders/model.py::line_total_minor"),
];

/** The fixture's scope map, by path prefix. */
const SCOPES: Record<string, string> = { "orders/": "orders", "shared/money/": "money", "mobile_api/": "mobile-api" };
const scopeOf = (path: string): string | undefined => Object.entries(SCOPES).find(([prefix]) => path.startsWith(prefix))?.[1];

const use = (path: string, line: number, symbol: string, scope: string | null): ImpactUse => ({ path, line, kind: "call", symbol, name: symbol.split(".").at(-1) as string, scope });

function report(fields: Partial<ImpactReport>): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base: sha("a"),
    head: sha("b"),
    changes: [],
    signatures: [],
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [],
    forks: [],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 1, head: 1, parsed: 1 },
    ...fields,
  };
}

/** Noor's pagination agent: its charter holds mobile-api; orders belong to Tomas's agent. */
const context: RoutingContext = {
  charter: { handle: "@noor/pagination", person: "noor", scopes: ["mobile-api"], paths: [] },
  scopeOf: (path) => (path.startsWith("mobile_api/") ? "mobile-api" : path.startsWith("orders/") ? "orders" : undefined),
  ownerOf: (scope) => ({ "mobile-api": "noor", orders: "tomas" })[scope],
  ownerAgentOf: (scope) => (scope === "orders" ? "@tomas/orders" : undefined),
  roundLimit: 3,
};

describe("a declaration of retiring symbols", () => {
  test("names each contract and its replacement as path::symbol", () => {
    assert.deepEqual(parseRetiring(undefined), []);
    assert.deepEqual(parseRetiring([{ contract: "shared/money/__init__.py::total", replacement: "shared/money/__init__.py::Money.sum" }]), [
      { contract: "shared/money/__init__.py::total", replacement: "shared/money/__init__.py::Money.sum" },
    ]);
    for (const [value, problem] of [
      [{}, /must be an array/u],
      [[{ contract: "shared/money/__init__.py::price" }], /replacement/u],
      [[{ contract: "../etc/passwd.py::x", replacement: "a.py::b" }], /contract/u],
      [[{ contract: "a.py::x", replacement: "a.py::x" }], /cannot replace itself/u],
      [[{ contract: "a.py::x", replacement: "a.py::y", note: "approve" }], /takes only/u],
      [[{ contract: "a.py::x; rm -rf /", replacement: "a.py::y" }], /contract/u],
      [[{ contract: "a.py::x", replacement: "a.py::y" }, { contract: "a.py::x", replacement: "a.py::z" }], /listed twice/u],
    ] as const) {
      const parsed = parseRetiring(value);
      assert.equal(typeof parsed, "string", JSON.stringify(value));
      assert.match(parsed as string, problem);
    }
  });

  test("names each symbol as the impact analysis does", () => {
    assert.equal(contractDottedName("shared/money/__init__.py::price"), "shared.money.price");
    assert.equal(contractDottedName("orders/model.py::line_total"), "orders.model.line_total");
  });
});

describe("the retiring-calls check", () => {
  const impact = report({
    forks: [
      {
        id: "pagination",
        sha: sha("b"),
        scopes: [],
        since: sha("a"),
        mergeBase: sha("a"),
        carried: 4,
        uses: [
          use("mobile_api/order_lines_page.py", 2, "orders.model.line_total", "mobile-api"),
          use("mobile_api/order_lines_page.py", 12, "orders.model.line_total", "mobile-api"),
          use("mobile_api/order_lines_page.py", 12, "shared.money.display", "mobile-api"),
          // A use of a symbol nobody retires is no step.
          use("mobile_api/order_lines_page.py", 3, "shared.platform.pagination.page", "mobile-api"),
        ],
        errors: [],
      },
    ],
  });

  test("a call a declared rule rewrites is step 3, Penguin's codemod; any other is the agent's step 4 with the replacement", () => {
    const decisions = retiringCallDecisions(impact, "pagination", RETIRING, context, sha("b"), (path) => (path === "mobile_api/order_lines_page.py" ? ["display"] : []));
    assert.deepEqual(
      decisions.map((each) => [each.check, each.failure, each.step, each.actor.id, each.fix?.commandId ?? null, each.evidence.findings.map((finding) => finding.line)]),
      [
        ["retiring", "retiring-call", 4, "@noor/pagination", null, [2, 12]],
        ["retiring", "retiring-rule", 3, "penguin", "fix:python-codemod", [12]],
      ],
    );
    assert.match(decisions[0]?.reason ?? "", /orders\/model\.py::line_total on lines 2, 12; it is retiring, use orders\/model\.py::line_total_minor/u);
    assert.match(decisions[1]?.reason ?? "", /rules display rewrite it/u);
  });

  test("a rule that does not rewrite the file leaves the call to the agent", () => {
    const decisions = retiringCallDecisions(impact, "pagination", RETIRING, context, sha("b"));
    assert.deepEqual(decisions.map((each) => each.step), [4, 4]);
  });

  test("a call outside the agent's charter goes to the owner's agent at step 5", () => {
    const outside = report({ forks: [{ id: "x", sha: sha("b"), scopes: [], uses: [use("orders/extra.py", 4, "orders.model.line_total", "orders")], errors: [] }] });
    const [decision] = retiringCallDecisions(outside, "x", RETIRING, context, sha("b"));
    assert.deepEqual([decision?.step, decision?.actor], [5, { kind: "owner-agent", id: "@tomas/orders" }]);
  });

  test("an impact result carries the steps and the migration groups; another tool's result carries neither", () => {
    const decisions = retiringCallDecisions(impact, "pagination", RETIRING, context, sha("b"));
    const result: AgentToolResult = {
      schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
      tool: "impact",
      base: sha("a"),
      checkpoint: sha("b"),
      result: "found",
      summary: "2 places",
      impact,
      checks: [],
      decisions,
      migration: migrationGroups(impact, RETIRING, () => "tomas", () => "noor", scopeOf),
      fix: null,
      fixRef: null,
      pushed: false,
      durationMs: 1,
    };
    const parsed = parseToolResult(JSON.parse(JSON.stringify(result)));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const fix = parseToolResult({ ...result, tool: "apply_fix", impact: null, migration: undefined });
    assert.equal(fix.ok, false);
    const check = parseToolResult({ ...result, tool: "check", impact: null });
    assert.equal(check.ok, false);
  });
});

describe("migration groups", () => {
  test("group main's callers by scope owner and each running feature's own callers by its person", () => {
    const impact = report({
      headUses: [use("orders/history.py", 9, "orders.model.line_total", "orders"), use("tools/x.py", 1, "orders.model.line_total", null)],
      forks: [
        { id: "split-shipments", sha: sha("c"), scopes: [], uses: [use("orders/shipments.py", 5, "orders.model.line_total", "orders")], errors: [] },
        { id: "order-history", sha: sha("d"), scopes: [], uses: [use("mobile_api/history.py", 7, "shared.money.display", "mobile-api")], errors: [] },
        { id: "cart-sync", sha: sha("e"), scopes: [], uses: [use("mobile_api/cart_sync.py", 7, "shared.money.display", "mobile-api")], errors: [] },
        { id: "no-calls", sha: sha("f"), scopes: [], uses: [use("app/x.py", 1, "shared.money.Money", "app")], errors: [] },
      ],
    });
    const people: Record<string, string> = { "split-shipments": "tomas", "order-history": "noor", "cart-sync": "noor", "no-calls": "elif" };
    const { groups, unowned } = migrationGroups(impact, RETIRING, (scope) => ({ orders: "tomas" })[scope], (feature) => people[feature], scopeOf);
    assert.deepEqual(
      groups.map((group) => [group.owner, group.places.map((each) => (each.place.kind === "scope" ? `scope:${each.place.scope}` : each.place.feature)), group.uses]),
      [
        ["noor", ["cart-sync", "order-history"], 2],
        ["tomas", ["split-shipments", "scope:orders"], 2],
      ],
    );
    assert.equal(unowned, 1);
  });

  test("the defining scope's own module and tests make no part; its other files and every other scope's tests do", () => {
    const impact = report({
      headUses: [
        use("orders/tests/test_model.py", 9, "orders.model.line_total", "orders"),
        use("orders/history.py", 3, "orders.model.line_total", "orders"),
        use("mobile_api/tests/test_orders.py", 4, "orders.model.line_total", "mobile-api"),
        use("shared/money/tests/test_money.py", 7, "shared.money.display", "money"),
      ],
      forks: [{ id: "split-shipments", sha: sha("c"), scopes: [], uses: [use("orders/tests/test_shipments.py", 5, "orders.model.line_total", "orders")], errors: [] }],
    });
    const owners: Record<string, string> = { orders: "tomas", "mobile-api": "noor", money: "ines" };
    const { groups } = migrationGroups(impact, RETIRING, (scope) => owners[scope], () => "tomas", scopeOf);
    assert.deepEqual(
      groups.map((group) => [group.owner, group.places.map((each) => [each.place.kind === "scope" ? `scope:${each.place.scope}` : each.place.feature, each.uses.map((one) => one.path)])]),
      [
        ["noor", [["scope:mobile-api", ["mobile_api/tests/test_orders.py"]]]],
        // Another running feature's own change to the defining scope's tests is a caller: the contract step does not edit its fork.
        ["tomas", [["split-shipments", ["orders/tests/test_shipments.py"]], ["scope:orders", ["orders/history.py"]]]],
      ],
    );
  });
});

describe("the defining scope's own files", () => {
  test("the defining module and the test files of the scope that holds it, nothing else", () => {
    const own = (path: string, contract = "orders/model.py::line_total") => inDefiningFiles({ path }, contract, scopeOf);
    assert.equal(own("orders/model.py"), true);
    assert.equal(own("orders/tests/test_model.py"), true);
    assert.equal(own("orders/model_test.py"), true);
    assert.equal(own("orders/history.py"), false);
    assert.equal(own("orders/tests/conftest.py"), false);
    assert.equal(own("mobile_api/tests/test_orders.py"), false);
    // With no scope for the module, only the module itself is its own.
    assert.equal(own("tools/tests/test_x.py", "tools/x.py::f"), false);
    assert.equal(own("tools/x.py", "tools/x.py::f"), true);
  });
});

describe("the callers of each retiring symbol", () => {
  const impact = report({
    headUses: [use("orders/tests/test_model.py", 9, "orders.model.line_total", "orders"), use("tools/x.py", 1, "orders.model.line_total", null)],
    forks: [
      { id: "split-shipments", sha: sha("c"), scopes: [], uses: [use("orders/shipments.py", 5, "orders.model.line_total", "orders")], errors: [] },
      { id: "cart-sync", sha: sha("e"), scopes: [], uses: [use("mobile_api/cart_sync.py", 7, "orders.model.line_total", "mobile-api")], errors: [] },
      { id: "no-calls", sha: sha("f"), scopes: [], uses: [use("app/x.py", 1, "shared.money.Money", "app")], errors: [] },
    ],
  });

  test("count every use on main, in any scope or none, and in each running feature's own changes; a symbol nobody calls counts zero", () => {
    assert.deepEqual(retiringCallerCounts(impact, RETIRING, () => undefined), [
      { contract: "orders/model.py::line_total", onMain: 2, features: [{ feature: "cart-sync", uses: 1 }, { feature: "split-shipments", uses: 1 }], callers: 4, ownUses: 0, ownFiles: [] },
      { contract: "shared/money/__init__.py::display", onMain: 0, features: [], callers: 0, ownUses: 0, ownFiles: [] },
    ]);
  });

  test("the defining scope's own uses on main and in the originating feature's own changes are counted apart, never as callers", () => {
    const own = report({
      headUses: [use("orders/tests/test_model.py", 9, "orders.model.line_total", "orders"), use("orders/tests/test_model.py", 12, "orders.model.line_total", "orders")],
      forks: [
        { id: "money-type", sha: sha("c"), scopes: [], uses: [use("orders/tests/test_totals.py", 2, "orders.model.line_total", "orders")], errors: [] },
        { id: "split-shipments", sha: sha("d"), scopes: [], uses: [use("orders/tests/test_shipments.py", 5, "orders.model.line_total", "orders")], errors: [] },
      ],
    });
    const [lineTotal] = retiringCallerCounts(own, RETIRING, scopeOf);
    assert.deepEqual(lineTotal, {
      contract: "orders/model.py::line_total",
      onMain: 0,
      features: [{ feature: "split-shipments", uses: 1 }],
      callers: 1,
      ownUses: 3,
      ownFiles: ["orders/tests/test_model.py", "orders/tests/test_totals.py"],
    });
    // Once the other feature's caller moved, the count reaches zero with the own uses still on main.
    const moved = retiringCallerCounts({ ...own, forks: own.forks.slice(0, 1) }, RETIRING, scopeOf);
    assert.deepEqual(
      moved.map((each) => [each.contract, each.callers, each.ownUses]),
      [
        ["orders/model.py::line_total", 0, 3],
        ["shared/money/__init__.py::display", 0, 0],
      ],
    );
  });

  test("only a complete report with no unreadable file proves that no caller is left", () => {
    assert.equal(countIsComplete(impact), true);
    assert.equal(countIsComplete({ ...impact, complete: false }), false);
    assert.equal(countIsComplete({ ...impact, truncated: true }), false);
    assert.equal(countIsComplete({ ...impact, errors: [{ kind: "syntax", path: "orders/x.py", message: "bad", tree: "head" }] }), false);
    const unreadable = { ...impact, forks: [{ id: "cart-sync", sha: sha("e"), scopes: [], uses: [], errors: [{ kind: "syntax", path: "mobile_api/x.py", message: "bad" }] }] };
    assert.equal(countIsComplete(unreadable), false);
  });

  test("a contract diff removes a contract when the old name is gone, not when an alias keeps it", () => {
    const change = { symbol: "orders.model.line_total", path: "orders/model.py", line: 4, kind: "function", scope: "orders", contract: "orders/model.py::line_total" } as const;
    assert.equal(contractRemoved(report({ changes: [{ ...change, change: "removed" }] }), "orders/model.py::line_total"), true);
    assert.equal(contractRemoved(report({ changes: [{ ...change, change: "renamed", kept: true }] }), "orders/model.py::line_total"), false);
    assert.equal(contractRemoved(report({ changes: [{ ...change, change: "modified" }] }), "orders/model.py::line_total"), false);
    assert.equal(contractRemoved(report({ removedExports: [{ module: "orders.model", path: "orders/model.py", name: "line_total" }] }), "orders/model.py::line_total"), true);
  });
});
