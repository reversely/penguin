import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  classifyFailure,
  codemodEditProblem,
  codemodPlan,
  FAILURE_KINDS,
  FIX_COMMAND_IDS,
  LADDER_ROUTES,
  ladderRoute,
  RESOLUTION_LADDER,
  type BlockCheck,
  type BlockCheckName,
  type CodemodPlan,
  type FailureFacts,
  type ImpactReport,
  type RoutingContext,
} from "@penguin/protocol";

const sha = (digit: string) => digit.repeat(40);

/** A small project: ana's `core` holds a shared helper; bob's `app` and cy's `web` call it. */
const SCOPES: Record<string, { owner: string; path: string }> = {
  core: { owner: "ana", path: "core" },
  app: { owner: "bob", path: "app" },
  web: { owner: "cy", path: "web" },
};

const context: RoutingContext = {
  charter: { handle: "@ana/core", person: "ana", scopes: ["core"], paths: ["tools/scripts"] },
  scopeOf: (path) => Object.entries(SCOPES).find(([, scope]) => path.startsWith(`${scope.path}/`))?.[0],
  ownerOf: (scope) => SCOPES[scope]?.owner,
  // cy has no identity whose charter holds `web`.
  ownerAgentOf: (scope) => (scope === "app" ? "@bob/app" : undefined),
  roundLimit: 3,
};

function check(name: BlockCheckName, fields: Partial<BlockCheck> = {}): BlockCheck {
  return {
    planId: null,
    target: "bob",
    check: name,
    result: "failed",
    tool: { name: "tool", version: null, commandId: "check:tool" },
    input: { origin: sha("a"), target: sha("b"), merged: sha("c"), paths: null },
    findings: [{ path: "app/use.py", line: 3, code: null, message: "fails" }],
    findingCount: 1,
    summary: "it failed",
    fingerprint: null,
    logRef: null,
    durationMs: 1,
    ...fields,
  };
}

const RENAME: CodemodPlan = {
  edits: [{ kind: "rename", from: "core.dates.start", to: "core.dates.start_local" }],
  paths: ["app/use.py"],
  kinds: ["rename"],
};

function facts(name: BlockCheckName, fields: Partial<Omit<FailureFacts, "check">> & { check?: Partial<BlockCheck> } = {}): FailureFacts {
  const { check: checkFields, ...rest } = fields;
  return { check: check(name, checkFields), targetScopes: ["app"], codemod: null, failedFixes: 0, round: 0, ...rest };
}

describe("the resolution ladder", () => {
  // One row per way a failure reaches each of the six steps. Every failure gets exactly one step and
  // one actor.
  const table: {
    name: string;
    facts: FailureFacts;
    step: number;
    failure: string;
    actor: { kind: string; id: string };
    fix: string | null;
  }[] = [
    { name: "format", facts: facts("format"), step: 1, failure: "formatting", actor: { kind: "penguin", id: "penguin" }, fix: "fix:ruff-format" },
    { name: "lint, such as import order", facts: facts("lint"), step: 1, failure: "lint", actor: { kind: "penguin", id: "penguin" }, fix: "fix:ruff-autofix" },
    {
      name: "a merge conflict only in uv.lock",
      facts: facts("merge", { check: { findings: [{ path: "uv.lock", line: null, code: null, message: "conflicts" }] } }),
      step: 2,
      failure: "lockfile-conflict",
      actor: { kind: "penguin", id: "penguin" },
      fix: "fix:uv-lock",
    },
    {
      name: "failing tests on a renamed symbol",
      facts: facts("tests", { codemod: RENAME }),
      step: 3,
      failure: "rename",
      actor: { kind: "penguin", id: "penguin" },
      fix: "fix:python-codemod",
    },
    {
      name: "a type error on a moved symbol",
      facts: facts("typecheck", { codemod: { ...RENAME, kinds: ["move"] } }),
      step: 3,
      failure: "move",
      actor: { kind: "penguin", id: "penguin" },
      fix: "fix:python-codemod",
    },
    {
      name: "a type error on a renamed keyword parameter",
      facts: facts("typecheck", { codemod: { ...RENAME, kinds: ["signature"] } }),
      step: 3,
      failure: "signature",
      actor: { kind: "penguin", id: "penguin" },
      fix: "fix:python-codemod",
    },
    {
      name: "a behaviour change inside the charter",
      facts: facts("tests", { check: { target: "main", findings: [{ path: "core/dates.py", line: 1, code: null, message: "fails" }] }, targetScopes: [] }),
      step: 4,
      failure: "behaviour",
      actor: { kind: "originating-agent", id: "@ana/core" },
      fix: null,
    },
    {
      name: "a behaviour change under a charter path",
      facts: facts("typecheck", { check: { findings: [{ path: "tools/scripts/run.py", line: 1, code: null, message: "x" }] } }),
      step: 4,
      failure: "behaviour",
      actor: { kind: "originating-agent", id: "@ana/core" },
      fix: null,
    },
    {
      name: "a behaviour change outside the charter",
      facts: facts("tests"),
      step: 5,
      failure: "behaviour",
      actor: { kind: "owner-agent", id: "@bob/app" },
      fix: null,
    },
    {
      name: "a test failure with no file goes by the target's scopes",
      facts: facts("tests", { check: { findings: [], findingCount: 0 } }),
      step: 5,
      failure: "behaviour",
      actor: { kind: "owner-agent", id: "@bob/app" },
      fix: null,
    },
    {
      name: "a lint failure Penguin's autofix did not clear",
      facts: facts("lint", { failedFixes: 1 }),
      step: 5,
      failure: "behaviour",
      actor: { kind: "owner-agent", id: "@bob/app" },
      fix: null,
    },
    {
      name: "a merge conflict outside the lockfile",
      facts: facts("merge", { check: { findings: [{ path: "app/use.py", line: null, code: null, message: "conflicts" }] } }),
      step: 5,
      failure: "behaviour",
      actor: { kind: "owner-agent", id: "@bob/app" },
      fix: null,
    },
    {
      name: "a check that could not run",
      facts: facts("typecheck", { check: { result: "error", summary: "pyright is not installed" } }),
      step: 6,
      failure: "tool-error",
      actor: { kind: "person", id: "ana" },
      fix: null,
    },
    {
      name: "a mechanical failure past the round limit",
      facts: facts("format", { round: 3 }),
      step: 6,
      failure: "round-limit",
      actor: { kind: "person", id: "ana" },
      fix: null,
    },
    {
      name: "a behaviour change in a scope whose owner has no identity for it",
      facts: facts("tests", { check: { target: "cy", findings: [{ path: "web/page.py", line: 1, code: null, message: "fails" }] }, targetScopes: ["web"] }),
      step: 6,
      failure: "behaviour",
      actor: { kind: "person", id: "cy" },
      fix: null,
    },
  ];

  for (const row of table) {
    test(`${row.name}: step ${row.step}`, () => {
      const decision = classifyFailure(row.facts, context);
      assert.equal(decision.step, row.step);
      assert.equal(decision.failure, row.failure);
      assert.deepEqual(decision.actor, row.actor);
      assert.equal(decision.fix?.commandId ?? null, row.fix);
      assert.equal(decision.nextStep, RESOLUTION_LADDER[row.step - 1]?.nextStep);
      assert.equal(decision.evidence.summary, row.facts.check.summary);
      assert.ok(decision.reason.length > 0);
    });
  }

  test("the table covers all six steps", () => {
    assert.deepEqual([...new Set(table.map((row) => row.step))].sort(), [1, 2, 3, 4, 5, 6]);
  });

  test("the ladder is data: every route names a known failure and step, and every fix has a command", () => {
    for (const route of LADDER_ROUTES) {
      assert.ok((FAILURE_KINDS as readonly string[]).includes(route.failure));
      assert.ok(RESOLUTION_LADDER.some((step) => step.step === route.step));
      if (route.fix !== undefined) {
        assert.ok(FIX_COMMAND_IDS[route.fix].startsWith("fix:"));
        assert.ok(RESOLUTION_LADDER[route.step - 1]?.fixes.includes(route.fix));
      }
    }
    // A row for one check wins over a row for any check; an unknown pairing is a behaviour change.
    assert.equal(ladderRoute("tests", "rename").step, 3);
    assert.equal(ladderRoute("overlap", "rename").failure, "behaviour");
  });
});

describe("codemod edits from the contract diff", () => {
  const use = (path: string, symbol: string, kind: "call" | "import" = "call") =>
    ({ path, line: 3, kind, symbol, name: symbol, scope: "app" }) as const;
  const report: ImpactReport = {
    schemaVersion: 1,
    tool: "python-impact",
    commandId: "analysis:python-impact",
    base: sha("a"),
    head: sha("b"),
    changes: [
      {
        symbol: "core.dates.start",
        path: "core/dates.py",
        line: 1,
        kind: "function",
        change: "renamed",
        scope: "core",
        contract: null,
        to: { symbol: "core.dates.start_local", path: "core/dates.py", line: 1 },
      },
      { symbol: "core.dates.end", path: "core/dates.py", line: 9, kind: "function", change: "modified", scope: "core", contract: null },
    ],
    signatures: [
      {
        symbol: "core.dates.end",
        path: "core/dates.py",
        line: 9,
        before: "(moment, zone)",
        after: "(moment, offset)",
        added: [{ name: "offset", required: true }],
        removed: ["zone"],
        breaking: true,
        reasons: ["removes parameter zone"],
      },
    ],
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [use("core/use.py", "core.dates.start", "import")],
    forks: [
      {
        id: "bob",
        sha: sha("c"),
        scopes: ["app"],
        uses: [use("app/b.py", "core.dates.start", "import"), use("app/a.py", "core.dates.start"), use("app/c.py", "core.dates.end")],
        errors: [],
      },
      { id: "cy", sha: sha("d"), scopes: ["web"], uses: [], errors: [] },
    ],
    unanalysed: [],
    errors: [],
    complete: true,
    truncated: false,
    files: { base: 1, head: 1, parsed: 2 },
  };

  test("a fork's uses of a renamed symbol and a renamed keyword give one edit each", () => {
    const plan = codemodPlan(report, "bob");
    assert.deepEqual(plan.edits, [
      { kind: "rename", from: "core.dates.start", to: "core.dates.start_local" },
      { kind: "rename-parameter", function: "core.dates.end", from: "zone", to: "offset" },
    ]);
    assert.deepEqual(plan.paths, ["app/a.py", "app/b.py", "app/c.py"]);
    assert.deepEqual(plan.kinds, ["rename", "signature"]);
  });

  test("the head tree's own callers, and a fork with no use", () => {
    assert.deepEqual(codemodPlan(report, null).paths, ["core/use.py"]);
    assert.deepEqual(codemodPlan(report, "cy"), { edits: [], paths: [], kinds: [] });
  });

  test("an edit is checked field by field", () => {
    assert.equal(codemodEditProblem({ kind: "rename", from: "a.b", to: "a.c" }), null);
    assert.equal(codemodEditProblem({ kind: "rename-parameter", function: "a.b", from: "x", to: "y" }), null);
    assert.match(codemodEditProblem({ kind: "rename", from: "a.b", to: "a.b" }) ?? "", /differ/);
    assert.match(codemodEditProblem({ kind: "rename", from: "a.b; import os", to: "a.c" }) ?? "", /dotted/);
    assert.match(codemodEditProblem({ kind: "move", from: "a.b", to: "c.b", script: "x" }) ?? "", /unknown field/);
    assert.match(codemodEditProblem({ kind: "rename-parameter", function: "a.b", from: "x.y", to: "z" }) ?? "", /identifier/);
    assert.match(codemodEditProblem({ kind: "exec" }) ?? "", /kind/);
  });
});
