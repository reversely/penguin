import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkImpactReport, selectAffectedForks, type ImpactFork, type ImpactReport } from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);

const use = { path: "app/use.py", line: 3, kind: "call", symbol: "core.f.f", name: "core.f.f", scope: "app" } as const;

function fork(id: string, fields: Partial<ImpactFork> = {}): ImpactFork {
  return { id, sha: sha("c"), scopes: ["app"], uses: [], errors: [], ...fields };
}

function report(fields: Partial<ImpactReport> = {}): ImpactReport {
  return {
    schemaVersion: 1,
    tool: "python-impact",
    commandId: "analysis:python-impact",
    base: sha("a"),
    head: sha("b"),
    changes: [
      { symbol: "core.f.f", path: "core/f.py", line: 1, kind: "function", change: "modified", scope: "core", contract: null },
      {
        symbol: "core.f.g",
        path: "core/f.py",
        line: 4,
        kind: "function",
        change: "renamed",
        scope: "core",
        contract: "core/f.py::g",
        to: { symbol: "core.f.h", path: "core/f.py", line: 4 },
      },
    ],
    signatures: [
      {
        symbol: "core.f.f",
        path: "core/f.py",
        line: 1,
        before: "(a)",
        after: "(a, b)",
        added: [{ name: "b", required: true }],
        removed: [],
        breaking: true,
        reasons: ["adds required parameter b"],
      },
    ],
    removedExports: [{ module: "core.f", path: "core/f.py", name: "g" }],
    dataShapes: [],
    contracts: ["core/f.py::g"],
    headUses: [use],
    forks: [fork("with-use", { uses: [use] }), fork("without")],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 3, head: 3, parsed: 4 },
    ...fields,
  };
}

describe("impact report schema", () => {
  test("accepts a report with every kind of finding", () => {
    assert.deepEqual(checkImpactReport(report()), []);
  });

  test("names the tool, its command and its commits", () => {
    assert.notDeepEqual(checkImpactReport({ ...report(), tool: "other" }), []);
    assert.notDeepEqual(checkImpactReport({ ...report(), commandId: "test:app" }), []);
    assert.notDeepEqual(checkImpactReport({ ...report(), head: "HEAD" }), []);
  });

  test("refuses an unknown field, an unknown change kind and a line below 1", () => {
    assert.notDeepEqual(checkImpactReport({ ...report(), extra: true }), []);
    const [change] = report().changes;
    assert.notDeepEqual(checkImpactReport(report({ changes: [{ ...change!, change: "rewritten" as never }] })), []);
    assert.notDeepEqual(checkImpactReport(report({ headUses: [{ ...use, line: 0 }] })), []);
  });

  test("refuses a fork id that could be read as an option or a path", () => {
    for (const id of ["-rf", "../x", "a b", ""]) {
      assert.notDeepEqual(checkImpactReport(report({ forks: [fork(id)] })), [], id);
    }
  });
});

describe("selectAffectedForks", () => {
  test("selects only forks with a use of a changed symbol", () => {
    assert.deepEqual(selectAffectedForks(report()), ["with-use"]);
  });

  test("selects a fork with a file it could not read in its scopes", () => {
    const unreadable = fork("unreadable", { errors: [{ kind: "syntax", path: "app/x.py", message: "line 1" }] });
    assert.deepEqual(selectAffectedForks(report({ forks: [unreadable, fork("clean")] })), ["unreadable"]);
  });

  test("selects every fork when the report is incomplete", () => {
    const incomplete = report({ complete: false, unanalysed: ["core/data.json"] });
    assert.deepEqual(selectAffectedForks(incomplete), ["with-use", "without"]);
  });
});
