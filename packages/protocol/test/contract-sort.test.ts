// Sorting a contract diff (#116, PRD 0.5 section 4.2 step 1): each sort result, the decision it
// gives, and the expand edits Penguin's codemod writes for a rename, a move and a keyword rename.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  expandPlan,
  IMPACT_COMMAND_ID,
  IMPACT_SCHEMA_VERSION,
  IMPACT_TOOL,
  pythonModuleOf,
  sortContractDiff,
  type ImpactChange,
  type ImpactReport,
  type ImpactUse,
} from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);
const OWN = new Set(["core"]);

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

const change = (symbol: string, kind: ImpactChange["change"], extra: Partial<ImpactChange> = {}): ImpactChange => ({
  symbol,
  path: "core/util.py",
  line: 1,
  kind: "function",
  change: kind,
  scope: "core",
  contract: null,
  ...extra,
});
const use = (symbol: string, scope: string | null, path = "app/use.py"): ImpactUse => ({ path, line: 3, kind: "call", symbol, name: symbol.split(".").at(-1) as string, scope });
const signature = (symbol: string, fields: Partial<ImpactReport["signatures"][number]>): ImpactReport["signatures"][number] => ({
  symbol,
  path: "core/util.py",
  line: 1,
  before: "(a)",
  after: "(a)",
  added: [],
  removed: [],
  breaking: false,
  reasons: [],
  ...fields,
});

const sortOf = (impact: ImpactReport, symbol: string) => sortContractDiff(impact, OWN).entries.find((entry) => entry.symbol === symbol);

describe("each sort result", () => {
  test("a new symbol is additive and the feature needs nothing more", () => {
    const sorted = sortContractDiff(report({ changes: [change("core.util.fresh", "added")] }), OWN);
    assert.equal(sorted.entries[0]?.sort, "additive");
    assert.equal(sorted.decision, "none");
  });

  test("a rename with callers outside the author's scopes is incompatible and splits the feature", () => {
    const impact = report({
      changes: [change("core.util.old", "renamed", { to: { symbol: "core.util.new", path: "core/util.py", line: 4 } })],
      headUses: [use("core.util.old", "app"), use("core.util.old", "core", "core/inner.py")],
    });
    const sorted = sortContractDiff(impact, OWN);
    assert.deepEqual(
      { sort: sorted.entries[0]?.sort, breaks: sorted.entries[0]?.breaks, callers: sorted.entries[0]?.callers, decision: sorted.decision },
      { sort: "incompatible", breaks: "rename", callers: 1, decision: "split" },
    );
    assert.equal(sorted.entries[0]?.reason, "renamed to core.util.new, with 1 caller outside the author's scopes");
  });

  test("a running feature's own use counts as a caller", () => {
    const impact = report({
      changes: [change("core.util.gone", "removed")],
      forks: [{ id: "weekly", sha: sha("c"), scopes: ["app"], uses: [use("core.util.gone", "app")], errors: [] }],
    });
    assert.equal(sortOf(impact, "core.util.gone")?.sort, "incompatible");
  });

  test("a breaking change whose callers all sit in the author's scopes is compatible", () => {
    const impact = report({ changes: [change("core.util.gone", "removed")], headUses: [use("core.util.gone", "core", "core/inner.py")] });
    assert.deepEqual([sortOf(impact, "core.util.gone")?.sort, sortContractDiff(impact, OWN).decision], ["compatible", "none"]);
  });

  test("a kept rename is compatible: the old name still reaches the new definition", () => {
    const impact = report({
      changes: [change("core.util.old", "renamed", { to: { symbol: "core.util.new", path: "core/util.py", line: 4 }, kept: true })],
      headUses: [use("core.util.old", "app")],
    });
    assert.equal(sortOf(impact, "core.util.old")?.sort, "compatible");
  });

  test("a new parameter with a default is compatible", () => {
    const impact = report({
      changes: [change("core.util.f", "modified", { contract: "core/util.py::f" })],
      signatures: [signature("core.util.f", { after: "(a, b=1)", added: [{ name: "b", required: false }] })],
      headUses: [use("core.util.f", "app")],
    });
    assert.equal(sortOf(impact, "core.util.f")?.sort, "compatible");
  });

  test("a keyword rename and a changed type with outside callers are incompatible, each with its break", () => {
    const impact = report({
      changes: [change("core.util.f", "modified"), change("core.util.total", "modified")],
      signatures: [
        signature("core.util.f", {
          before: "(a, percent)",
          after: "(a, rate)",
          removed: ["percent"],
          added: [{ name: "rate", required: true }],
          breaking: true,
          reasons: ["removes parameter percent", "adds required parameter rate"],
        }),
        signature("core.util.total", { before: "(prices: list[float]) -> float", after: "(prices: list[Money]) -> Money" }),
      ],
      headUses: [use("core.util.f", "app"), use("core.util.total", "app")],
    });
    assert.deepEqual(sortOf(impact, "core.util.f")?.keyword, { from: "percent", to: "rate" });
    assert.equal(sortOf(impact, "core.util.f")?.breaks, "keyword-rename");
    assert.equal(sortOf(impact, "core.util.total")?.breaks, "type");
    assert.equal(sortOf(impact, "core.util.total")?.sort, "incompatible");
  });

  test("a parameter replaced by *args is a breaking signature, not a keyword rename", () => {
    const impact = report({
      changes: [change("core.util.percent_off", "modified")],
      signatures: [
        signature("core.util.percent_off", {
          before: "(amount: float, percent: int) -> float",
          after: "(amount: float, *percents: int) -> float",
          removed: ["percent"],
          added: [{ name: "percents", required: false }],
          breaking: true,
          reasons: ["removes parameter percent"],
        }),
      ],
      headUses: [use("core.util.percent_off", "app")],
    });
    assert.deepEqual([sortOf(impact, "core.util.percent_off")?.breaks, sortOf(impact, "core.util.percent_off")?.keyword], ["signature", null]);
  });

  test("a body change to a declared contract with the same signature is a behaviour change and keeps the merge plan", () => {
    const impact = report({ changes: [change("core.util.start", "modified", { contract: "core/util.py::start" })] });
    const sorted = sortContractDiff(impact, OWN);
    assert.equal(sorted.entries[0]?.sort, "behaviour");
    assert.equal(sorted.decision, "plan");
  });

  test("a body change to an undeclared symbol nobody outside calls is compatible", () => {
    assert.equal(sortOf(report({ changes: [change("core.util._helper", "modified")] }), "core.util._helper")?.sort, "compatible");
  });

  test("an incompatible entry wins over a behaviour change: the split comes first", () => {
    const impact = report({
      changes: [change("core.util.gone", "removed"), change("core.util.start", "modified", { contract: "core/util.py::start" })],
      headUses: [use("core.util.gone", null)],
    });
    assert.equal(sortContractDiff(impact, OWN).decision, "split");
  });

  test("a name dropped from a module's exports with no change of its own is a removed symbol", () => {
    const impact = report({ removedExports: [{ module: "core.util", path: "core/util.py", name: "LIMIT" }], headUses: [use("core.util.LIMIT", "app")] });
    assert.deepEqual([sortOf(impact, "core.util.LIMIT")?.breaks, sortOf(impact, "core.util.LIMIT")?.sort], ["removed", "incompatible"]);
  });
});

describe("the expand plan", () => {
  test("a rename, a move and a keyword rename become codemod edits on the files that hold the old names", () => {
    const impact = report({
      changes: [
        change("core.util.old", "renamed", { to: { symbol: "core.util.new", path: "core/util.py", line: 4 } }),
        change("core.a.helper", "moved", { path: "core/a.py", to: { symbol: "core.b.helper", path: "core/b.py", line: 1 } }),
        change("core.util.f", "modified"),
        change("core.util.price", "modified"),
      ],
      signatures: [
        signature("core.util.f", { removed: ["percent"], added: [{ name: "rate", required: true }], breaking: true, reasons: ["removes parameter percent", "adds required parameter rate"] }),
        signature("core.util.price", { before: "(amount: float) -> float", after: "(amount: int) -> Money" }),
      ],
      headUses: ["core.util.old", "core.a.helper", "core.util.f", "core.util.price"].map((symbol) => use(symbol, "app")),
    });
    const plan = expandPlan(sortContractDiff(impact, OWN).entries);
    assert.deepEqual(plan.edits, [
      { kind: "rename", from: "core.util.old", to: "core.util.new" },
      { kind: "move", from: "core.a.helper", to: "core.b.helper" },
      { kind: "rename-parameter", function: "core.util.f", from: "percent", to: "rate" },
    ]);
    assert.deepEqual(plan.paths, ["core/a.py", "core/util.py"]);
    assert.deepEqual(plan.manual, [{ symbol: "core.util.price", reason: "a changed type: write the parallel function beside the old one" }]);
  });

  test("a module path names its dotted module", () => {
    assert.deepEqual([pythonModuleOf("shared/money/__init__.py"), pythonModuleOf("core/util.py")], ["shared.money", "core.util"]);
  });
});
