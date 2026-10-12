// Migration plans of a split (migration.ts): plan and feature ids, who writes a part from the runner's
// rewrite, the rewrites a tool result may carry, where a rule-written part goes after its trial, and the
// formless side-by-side runs a part trial reports.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkMigrationRewrites,
  contractCarrierId,
  migrationBlockId,
  migrationPlaceKey,
  migrationPlanId,
  migrationWriter,
  parsePartTrialReport,
  parseToolResult,
  REVIEW_SCHEMA_VERSION,
  ruleWrittenRouting,
  SIDE_BY_SIDE_COMMAND_ID,
  SIDE_BY_SIDE_TOOL,
  type MigrationRewritePlace,
  type PartRoutingReason,
} from "../src/index.ts";

const SHA = "a".repeat(40);
const rewrite = (fields: Partial<MigrationRewritePlace>): MigrationRewritePlace => ({
  place: { kind: "scope", scope: "orders" },
  target: "main",
  sha: SHA,
  files: [{ path: "orders/report.py", rules: ["display"] }],
  patch: "--- a/orders/report.py\n+++ b/orders/report.py\n@@ -1 +1 @@\n-a\n+b\n",
  residual: 0,
  error: null,
  ...fields,
});

test("plan, block and carrier ids stay valid feature ids", () => {
  assert.equal(migrationPlanId("money-type", "tomas", 2), "migrate:money-type:tomas:2");
  assert.equal(migrationBlockId("money-type", "tomas", 1), "migrate-tomas-money-type");
  assert.equal(migrationBlockId("money-type", "tomas", 3), "migrate-tomas-money-type-3");
  assert.equal(contractCarrierId("money-type", "ines"), "contract-ines-money-type");
  const long = migrationBlockId(`${"x".repeat(60)}-y`, "tomas", 12);
  assert.ok(long.length <= 63 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(long), long);
  assert.equal(migrationPlaceKey({ kind: "feature", feature: "pagination" }), "feature:pagination");
});

test("the runner writes a part only when its rules rewrite every use there", () => {
  assert.deepEqual(migrationWriter(["display"], rewrite({})), { writer: "runner", reason: "the rules display rewrite every use in the place" });
  assert.equal(migrationWriter([], rewrite({})).writer, "task");
  assert.equal(migrationWriter(["display"], undefined).writer, "task");
  assert.match(migrationWriter(["display"], rewrite({ residual: 2 })).reason, /leave 2 uses/u);
  assert.match(migrationWriter(["display"], rewrite({ patch: null, files: [] })).reason, /rewrite nothing/u);
  assert.match(migrationWriter(["display"], rewrite({ error: "the codemod failed" })).reason, /could not run: the codemod failed/u);
});

test("only an impact result carries rewrites, each checked against its schema", () => {
  const result = { schemaVersion: 1, tool: "impact", base: SHA, checkpoint: SHA, result: "found", summary: "", impact: null, checks: [], decisions: [], fix: null, fixRef: null, pushed: false, durationMs: 1 };
  assert.equal(parseToolResult({ ...result, rewrites: [rewrite({})] }).ok, true);
  assert.equal(parseToolResult({ ...result, tool: "check", rewrites: [rewrite({})] }).ok, false);
  assert.equal(parseToolResult({ ...result, rewrites: [{ ...rewrite({}), residual: -1 }] }).ok, false);
  assert.deepEqual(checkMigrationRewrites([rewrite({})]), []);
  assert.ok(checkMigrationRewrites([{ ...rewrite({}), target: "../main" }]).length > 0);
});

test("a rule-written part needs no form: failing tests or a protected difference make an edit task, any other failing check a person", () => {
  const missingForm: PartRoutingReason = { kind: "review", scope: "billing", state: "missing", reviewId: null, invariant: null };
  const failing: PartRoutingReason = { kind: "tests", scope: "billing", status: "failed", breaks: 1 };
  const differs: PartRoutingReason = { kind: "protected_difference", scope: "billing", invariant: "fee-rounding", contract: "billing/api.py::fee", differing: 3, reviewId: 0 };
  const guarded: PartRoutingReason = { kind: "protected_path", scope: "reports", owner: "jun", path: "reports/revenue.py", file: "reports/revenue.py" };
  assert.deepEqual(ruleWrittenRouting([missingForm]), { route: "approve", reasons: [] });
  assert.deepEqual(ruleWrittenRouting([missingForm, failing, differs]), { route: "task", reasons: [failing, differs] });
  assert.deepEqual(ruleWrittenRouting([failing, guarded]), { route: "person", reasons: [guarded] });
  assert.deepEqual(ruleWrittenRouting([{ kind: "admin_mode" }]).route, "person");
});

test("a part trial reports each formless side-by-side run on its own tree against its target", () => {
  const tree = "b".repeat(40);
  const record = (base: string, fork: string, scope: string) => ({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    tool: SIDE_BY_SIDE_TOOL,
    commandId: SIDE_BY_SIDE_COMMAND_ID,
    base,
    fork,
    scope,
    sets: [],
    totals: { inputs: 0, differing: 0, invalid: 0 },
    timings: { mainMs: 0, forkMs: 0, totalMs: 0 },
  });
  const report = (sideBySide: unknown) => ({
    schemaVersion: 1,
    trialId: 4,
    partId: "migrate:money-type:bea:1#1",
    revision: 1,
    checkpoint: SHA,
    target: SHA,
    status: "built",
    tree,
    reason: null,
    tests: [],
    reviews: [],
    sideBySide,
    durationMs: 1,
  });
  assert.equal(parsePartTrialReport(report([{ scope: "billing", record: record(SHA, tree, "billing") }])).ok, true);
  const { sideBySide: _none, ...without } = report([]);
  assert.equal(parsePartTrialReport(without).ok, true);
  assert.deepEqual(parsePartTrialReport(report([{ scope: "billing", record: record(SHA, SHA, "billing") }])), {
    ok: false,
    problems: ["/sideBySide/0 is not a run of its scope on the trial tree against the target"],
  });
  assert.equal(parsePartTrialReport(report([{ scope: "billing", record: record(SHA, tree, "orders") }])).ok, false);
  assert.equal(parsePartTrialReport(report([{ scope: "billing", record: { ...record(SHA, tree, "billing"), tool: "other" } }])).ok, false);
});
