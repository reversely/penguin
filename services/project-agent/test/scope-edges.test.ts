// Scope dependencies read from the code (#134): after each promotion Penguin asks the check runner for
// main's scope edges in one request of its own, keeps them with the promotion at which each count last
// changed, and builds each person's role from them beside the declared `depends_on` entries.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { IMPACT_COMMAND_ID, IMPACT_SCHEMA_VERSION, IMPACT_TOOL, type AgentToolResult, type ImpactReport, type ImpactScopeEdge } from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import { claimToolRuns, recordToolResult } from "../src/agent-tool-runner.ts";
import { AgentToolStore } from "../src/agent-tools.ts";
import { buildPersonScopes } from "../src/dashboard-views.ts";
import { PENGUIN_SESSION } from "../src/retiring-count.ts";
import { EDGES_SEARCH, edgesReported, personRole, requestScopeEdges, roleIndex, ScopeEdgeStore } from "../src/scope-edges.ts";
import { GitRepo, sqlite } from "./issues-repo.ts";
import { PlanProject } from "./plan-project.ts";

const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const sha = (n: number) => n.toString(16).padStart(40, "e");
const edge = (consumer: string, provider: string, calls: number, imports = 1, references = 0): ImpactScopeEdge => ({ consumer, provider, calls, imports, references });

const scope = (id: string, owner: string, dependsOn: string[] = []) => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  owner,
  paths: [`${id}/`],
  test_command: "true",
  depends_on: dependsOn.map((provider) => ({ scope: provider, kind: "imports" })),
});
// Ines owns money and ledger; tax declares money, which its code also calls; orders calls money
// undeclared; reports declares ledger, which its code never uses.
const scopeMap = parseScopeMap({
  scopes: [scope("money", "ines"), scope("ledger", "ines", ["money"]), scope("tax", "rahul", ["money"]), scope("orders", "tomas"), scope("reports", "jun", ["ledger"])],
});

function impact(head: string, edges: ImpactScopeEdge[], complete = true): ImpactReport {
  return {
    schemaVersion: IMPACT_SCHEMA_VERSION,
    tool: IMPACT_TOOL,
    commandId: IMPACT_COMMAND_ID,
    base: head,
    head,
    changes: [],
    signatures: [],
    removedExports: [],
    dataShapes: [],
    contracts: [],
    headUses: [],
    forks: [],
    unanalysed: [],
    errors: [],
    complete,
    truncated: !complete,
    files: { base: 5, head: 5, parsed: 5 },
    scopeEdges: edges,
  };
}

describe("the stored scope edges", () => {
  let clock: number;
  let store: ScopeEdgeStore;
  beforeEach(() => {
    clock = Date.parse("2026-10-01T00:00:00.000Z");
    store = new ScopeEdgeStore(sqlite().sql, () => clock);
  });

  test("an edge keeps the promotion at which its counts last changed", () => {
    assert.equal(store.snapshot().derivation, null);
    store.derived([edge("tax", "money", 4), edge("orders", "money", 2)], sha(1), 1, true);
    clock += 60_000;
    store.derived([edge("tax", "money", 4), edge("orders", "money", 3)], sha(2), 2, true);
    const { derivation, edges } = store.snapshot();
    assert.deepEqual(derivation, { promotion: sha(2), derivedAt: "2026-10-01T00:01:00.000Z", complete: true });
    assert.deepEqual(
      edges.map((each) => [each.consumer, each.calls, each.inCode, each.updatedPromotion]),
      [
        ["orders", 3, true, sha(2)],
        ["tax", 4, true, sha(1)],
      ],
    );
  });

  test("a complete report drops an edge the code no longer shows; an incomplete one drops none", () => {
    store.derived([edge("tax", "money", 4), edge("orders", "money", 2)], sha(1), 1, true);
    store.derived([edge("tax", "money", 4)], sha(2), 2, false);
    assert.equal(store.snapshot().edges.find((each) => each.consumer === "orders")?.inCode, true);
    store.derived([edge("tax", "money", 4)], sha(3), 3, true);
    const orders = store.snapshot().edges.find((each) => each.consumer === "orders");
    assert.deepEqual([orders?.inCode, orders?.calls, orders?.updatedPromotion], [false, 0, sha(3)]);
    // It comes back with the promotion that shows it again.
    store.derived([edge("tax", "money", 4), edge("orders", "money", 1)], sha(4), 4, true);
    const back = store.snapshot().edges.find((each) => each.consumer === "orders");
    assert.deepEqual([back?.inCode, back?.calls, back?.updatedPromotion], [true, 1, sha(4)]);
  });

  test("a report older than the stored one is ignored", () => {
    store.derived([edge("tax", "money", 4)], sha(2), 7, true);
    assert.equal(store.derived([], sha(1), 6, true), false);
    assert.equal(store.snapshot().derivation?.promotion, sha(2));
    assert.equal(store.snapshot().edges[0]?.inCode, true);
  });
});

describe("a person's role from derived and declared edges", () => {
  let store: ScopeEdgeStore;
  beforeEach(() => {
    store = new ScopeEdgeStore(sqlite().sql, () => Date.parse("2026-10-01T00:00:00.000Z"));
    // Ledger reads money inside Ines's own scopes, which no row shows.
    store.derived([edge("tax", "money", 4, 2, 1), edge("orders", "money", 9, 1), edge("ledger", "money", 3), edge("tax", "ledger", 0, 1)], sha(1), 1, true);
  });

  test("reads and read by come from the code with call sites, and declared entries stay as additions", () => {
    const role = personRole(roleIndex(scopeMap, store.snapshot()), "ines");
    assert.deepEqual(
      role.dependents.map(({ id, calls, uses, derived, declared, via }) => [id, calls, uses, derived, declared, via]),
      [
        // Ranked by call sites: orders is in the code only, tax both in the code and declared.
        ["orders", 9, 10, true, false, ["money"]],
        ["tax", 4, 8, true, true, ["ledger", "money"]],
        // Declared on ledger, absent from the code at the derivation.
        ["reports", 0, 0, false, true, ["ledger"]],
      ],
    );
    assert.deepEqual(role.counts, { owns: 2, reads: 0, readBy: 3 });
    assert.deepEqual(role.derivation?.promotion, sha(1));
    // Each owned scope counts other people's calls into it.
    assert.deepEqual(
      role.scopes.map(({ id, calls, derived, declared, ownerId }) => [id, calls, derived, declared, ownerId]),
      [
        ["money", 13, true, true, "ines"],
        ["ledger", 0, true, true, "ines"],
      ],
    );
    const tax = personRole(roleIndex(scopeMap, store.snapshot()), "rahul");
    assert.deepEqual(
      tax.dependencies.map(({ id, calls, ownerId }) => [id, calls, ownerId]),
      [
        ["money", 4, "ines"],
        ["ledger", 0, "ines"],
      ],
    );
  });

  test("a declared edge absent from the code reads as declared only, with the derivation that checked it", () => {
    const reports = personRole(roleIndex(scopeMap, store.snapshot()), "jun").dependencies;
    assert.deepEqual(
      reports.map(({ id, derived, declared, updatedPromotion }) => [id, derived, declared, updatedPromotion]),
      [["ledger", false, true, sha(1)]],
    );
    // Before any derivation every dependency is declared only, with nothing checked.
    const before = personRole(roleIndex(scopeMap, { derivation: null, edges: [] }), "jun");
    assert.deepEqual(
      before.dependencies.map(({ id, derived, declared, updatedPromotion }) => [id, derived, declared, updatedPromotion]),
      [["ledger", false, true, null]],
    );
    assert.equal(before.derivation, null);
  });

  test("the team view keeps the top scopes of each row with every row's full count", () => {
    const role = personRole(roleIndex(scopeMap, store.snapshot()), "ines", 1);
    assert.deepEqual(
      role.dependents.map((each) => each.id),
      ["orders"],
    );
    assert.deepEqual(role.counts, { owns: 2, reads: 0, readBy: 3 });
  });

  test("an edge names a scope the map no longer holds: it is left out", () => {
    store.derived([edge("gone", "money", 50)], sha(2), 2, false);
    assert.ok(!personRole(roleIndex(scopeMap, store.snapshot()), "ines").dependents.some((each) => each.id === "gone"));
  });

  test("the person page answers every row in full", async () => {
    const page = await buildPersonScopes({ scopeMap: async () => scopeMap, scopeEdges: () => store.snapshot() }, "ines");
    assert.equal(page.person, "ines");
    assert.equal(page.role.dependents.length, 3);
    // Scope names and counts only: no path, line or symbol.
    assert.ok(!/\/|::|line/u.test(JSON.stringify(page.role.dependents.map(({ id, name, calls, uses }) => ({ id, name, calls, uses })))));
  });
});

describe("Penguin's read of main's scope dependencies after each promotion", () => {
  let project: PlanProject;
  let runs: AgentToolStore;
  let store: ScopeEdgeStore;

  beforeEach(async () => {
    project = new PlanProject(scopeMap, new GitRepo().dir);
    runs = new AgentToolStore(project.sql);
    store = new ScopeEdgeStore(project.sql);
    await project.open("money-minor", "ines", { scopes: ["money"] }, { id: "s-ines", handle: "@ines/money" });
    await project.open("fees", "tomas", { scopes: ["orders"] }, { id: "s-tomas", handle: "@tomas/orders" });
  });

  const result = (main: string, report: ImpactReport | null): AgentToolResult => ({
    schemaVersion: 1,
    tool: "impact",
    base: main,
    checkpoint: main,
    result: report === null ? "error" : "found",
    summary: "read",
    impact: report,
    checks: [],
    decisions: [],
    fix: null,
    fixRef: null,
    pushed: false,
    durationMs: 3,
  });

  test("each promotion asks once, the runner claims it with no other fork and its report is stored", async () => {
    const runId = requestScopeEdges({ features: project.features, runs }, "money-minor", sha(5));
    assert.ok(runId !== undefined);
    assert.equal(requestScopeEdges({ features: project.features, runs }, "money-minor", sha(5)), undefined);
    assert.equal(requestScopeEdges({ features: project.features, runs }, "unknown", sha(5)), undefined);
    const run = runs.get(runId);
    assert.deepEqual([run?.sessionId, run?.caller, run?.input["search"], run?.baseSha, run?.checkpointSha], [PENGUIN_SESSION, "penguin", EDGES_SEARCH, sha(5), sha(5)]);
    const claimed = await claimToolRuns({ runs, features: project.features, identity: () => undefined }, RUNNER);
    const [claim] = claimed.status === "ok" ? claimed.runs : [];
    assert.deepEqual([claim?.runId, claim?.base, claim?.charter.handle, claim?.forks], [runId, sha(5), "penguin", []]);
    const recorded = recordToolResult(runs, RUNNER, runId, result(sha(5), impact(sha(5), [edge("orders", "money", 2)])));
    assert.equal(recorded.status, "recorded", JSON.stringify(recorded));
    assert.equal(recorded.status === "recorded" && edgesReported(store, recorded.run), true);
    assert.deepEqual(store.snapshot().derivation?.promotion, sha(5));
    assert.deepEqual(store.snapshot().edges.map((each) => [each.consumer, each.provider, each.calls]), [["orders", "money", 2]]);
    // No agent session hears of it.
    assert.deepEqual(runs.deliver("s-ines"), []);
  });

  test("a failed read keeps the stored edges", async () => {
    store.derived([edge("orders", "money", 2)], sha(4), 0, true);
    const runId = requestScopeEdges({ features: project.features, runs }, "money-minor", sha(6));
    assert.ok(runId !== undefined);
    await claimToolRuns({ runs, features: project.features, identity: () => undefined }, RUNNER);
    const recorded = recordToolResult(runs, RUNNER, runId, result(sha(6), null));
    assert.equal(recorded.status === "recorded" && edgesReported(store, recorded.run), false);
    assert.equal(store.snapshot().derivation?.promotion, sha(4));
  });
});
