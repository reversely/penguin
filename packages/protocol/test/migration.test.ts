// Migration plans of a split (migration.ts): plan and feature ids, who writes a part from the runner's
// rewrite, and the rewrites a tool result may carry.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkMigrationRewrites,
  contractCarrierId,
  migrationBlockId,
  migrationPlaceKey,
  migrationPlanId,
  migrationWriter,
  parseToolResult,
  type MigrationRewritePlace,
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
