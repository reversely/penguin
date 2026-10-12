import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  dropProjectVerificationTable,
  huddleIssueOfRun,
  runIdBaseOf,
  RUNS_PER_HUDDLE,
  VerificationStore,
} from "../src/verification-store.ts";
import { sqlite } from "./issues-repo.ts";

const CHECKPOINTS = [{ ownerId: "priya", repo: "owner-priya", sha: "1".repeat(40) }];
const COMMANDS = [{ scopeId: "analytics", commandId: "test:analytics" }];

describe("run IDs of each Huddle's FeatureAgent", () => {
  test("a Huddle numbers its runs in its issue's range, and the run ID names the Huddle", () => {
    const runs = new VerificationStore(sqlite().sql, { runIdBase: runIdBaseOf("31") });
    const first = runs.schedule("owner-priya@a", CHECKPOINTS, COMMANDS);
    const second = runs.schedule("owner-priya@a", CHECKPOINTS, COMMANDS);
    assert.deepEqual([first.runId, second.runId], ["31000001", "31000002"]);
    assert.equal(runs.get("31000001")?.status, "superseded");
    assert.equal(huddleIssueOfRun(second.runId), "31");
  });

  test("two Huddles' runs never share an ID", () => {
    const one = new VerificationStore(sqlite().sql, { runIdBase: runIdBaseOf("1") });
    const two = new VerificationStore(sqlite().sql, { runIdBase: runIdBaseOf("2") });
    const a = one.schedule("owner-priya@a", CHECKPOINTS, COMMANDS);
    const b = two.schedule("owner-jun@b", CHECKPOINTS, COMMANDS);
    assert.notEqual(a.runId, b.runId);
    assert.deepEqual([huddleIssueOfRun(a.runId), huddleIssueOfRun(b.runId)], ["1", "2"]);
  });

  test("an ID below every range, or not a number, names no Huddle", () => {
    assert.equal(huddleIssueOfRun("7"), undefined);
    assert.equal(huddleIssueOfRun(String(RUNS_PER_HUDDLE - 1)), undefined);
    assert.equal(huddleIssueOfRun("12a"), undefined);
    assert.throws(() => runIdBaseOf("tmp-1"));
  });
});

describe("the ProjectAgent's VerificationRun table from before the move", () => {
  test("an empty table is dropped, and a missing one is left alone", () => {
    const { sql } = sqlite();
    new VerificationStore(sql);
    assert.equal(dropProjectVerificationTable(sql), "dropped");
    assert.equal(dropProjectVerificationTable(sql), "absent");
  });

  test("a table that holds runs is kept", () => {
    const { sql } = sqlite();
    new VerificationStore(sql).schedule("owner-priya@a", CHECKPOINTS, COMMANDS);
    assert.equal(dropProjectVerificationTable(sql), "kept");
    assert.equal(new VerificationStore(sql).get("1")?.status, "pending");
  });
});
