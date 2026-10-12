// Combined runs, tool-run checks and plan facts runs target features, not people (#104), on the
// money-minor-units fixture: fourteen people run forty features, so a person's features are
// separate forks and each one is a target of its own (PRD 0.4 section 1).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { PLAN_MAIN_TARGET } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { otherForks } from "../src/agent-tool-runner.ts";
import { CombinedRunStore, scheduleCombinedRuns } from "../src/combined-run-schedule.ts";
import type { Feature } from "../src/feature-store.ts";
import { factsRequest } from "../src/plan-facts.ts";
import { gitHistory } from "./huddle-project.ts";
import { sqlite } from "./issues-repo.ts";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const MONEY = join(REPO_ROOT, "examples", "money-minor-units");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
const ORIGIN = "money-minor-units";

/** The 23 readers and Noor's midway feature: the features in the nine scopes that read money. */
const READERS = [
  "basket-size", "business-accounts", "bottle-deposit", "cart-sync", "cohort-ltv", "credit-notes", "instant-payouts",
  "japan-launch", "order-history", "order-shipped", "pagination", "partial-refunds", "pdf-layout", "refund-email",
  "reorder", "saved-carts", "split-shipments", "store-credit", "store-league", "substitutions", "tax-exempt",
  "tip-jar", "weekly-digest", "weekly-statements",
].sort();

let root: string;
let repo: string;
let scopeMap: ScopeMap;
let features: Feature[];
let checkpoint: (id: string) => string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "penguin-money-targets-")));
  repo = join(root, "larder");
  execFileSync(PYTHON, [join(MONEY, "build.py"), repo]);
  const pins = JSON.parse(readFileSync(join(MONEY, "pins.json"), "utf8")) as { branches: Record<string, string>; tags: Record<string, string> };
  checkpoint = (id) => pins.tags[`feature-${id}-checkpoint`] as string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  scopeMap = parseScopeMap(JSON.parse(git("show", `${pins.branches["main"]}:penguin/scopes.json`)));
  const data = JSON.parse(readFileSync(join(MONEY, "larder.json"), "utf8")) as { features: { id: string; owner: string; role: string }[] };
  // The features running when Ines opened the one-block attempt: not the later waves or the late starter.
  const running = data.features.filter((feature) => feature.role !== "wave" && feature.role !== "late-starter");
  // Each feature's area is what its checkpoint touched, as a checkpoint report records it.
  features = running.map(({ id, owner }, index) => ({
    id,
    personId: owner,
    repo: `feature-${id}`,
    area: { scopes: [], paths: git("diff", "--name-only", `${checkpoint(id)}^`, checkpoint(id)).trim().split("\n"), contracts: [] },
    state: "building",
    openedAt: new Date(index * 1_000).toISOString(),
    latestCheckpointSha: checkpoint(id),
    updatedAt: new Date(index * 1_000).toISOString(),
  }));
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("the money fixture's thirty-nine features running beside the one-block attempt", () => {
  test("an agent's check on Ines's feature merges onto each of the 38 other features, not one per person", () => {
    const forks = otherForks(features, ORIGIN);
    assert.equal(features.length, 39);
    assert.equal(forks.length, 38);
    assert.equal(new Set(forks.map((fork) => fork.feature)).size, 38);
    // Thirteen people besides Ines, whose one feature is the origin, run the 38.
    assert.equal(new Set(forks.map((fork) => fork.person)).size, 13);
    assert.deepEqual(
      forks.filter((fork) => fork.person === "priya").map(({ feature, fork, checkpoint: sha }) => [feature, fork, sha]),
      ["japan-launch", "saved-carts", "tip-jar"].map((id) => [id, `feature-${id}`, checkpoint(id)]),
    );
  });

  test("a checkpoint of shared/money schedules one combined run per feature that reads money", async () => {
    const runs = new CombinedRunStore(sqlite().sql);
    const history = gitHistory(repo);
    const outcome = await scheduleCombinedRuns(
      { scopeMap, fork: history, base: history, latestCheckpoint: () => undefined, features: () => features, runs },
      "ines",
      checkpoint(ORIGIN),
    );
    assert.deepEqual(outcome.changedScopes, ["money"]);
    assert.deepEqual(outcome.withoutCheckpoint, []);
    assert.deepEqual(outcome.scheduled.map((run) => run.target).sort(), READERS);
    for (const run of outcome.scheduled) {
      const feature = features.find((each) => each.id === run.target) as Feature;
      assert.deepEqual([run.fork, run.ownerId, run.ownerCheckpoint], [`feature-${feature.id}`, feature.personId, checkpoint(feature.id)]);
    }
    // Priya's three features are three runs, each with its own checkpoint and checkout's tests.
    const priya = outcome.scheduled.filter((run) => run.ownerId === "priya");
    assert.deepEqual(priya.map((run) => [run.target, run.commandIds]), [
      ["japan-launch", ["test:checkout"]],
      ["saved-carts", ["test:checkout"]],
      ["tip-jar", ["test:checkout"]],
    ]);

    // A report completes each feature's run on its own: one fails, its siblings pass.
    const results = priya.map((run, index) => ({
      target: run.target,
      ownerId: "priya",
      scopeId: "checkout",
      commandId: "test:checkout",
      status: index === 0 ? ("failed" as const) : ("passed" as const),
      ownerCheckpoint: run.ownerCheckpoint,
      fingerprint: { id: "1".repeat(64), commit: "e".repeat(40), lockfileHash: "f".repeat(64), commandId: "test:checkout" },
      failingTests: index === 0 ? [{ nodeId: "checkout/tests/test_japan.py::test_yen_charged_at_face_value", testId: "test_japan::yen_charged_at_face_value" }] : [],
    }));
    const event = { trigger: priya[0]?.trigger as NonNullable<(typeof priya)[0]>["trigger"], changedScopes: ["money"], unmapped: [], results };
    assert.deepEqual(runs.complete(event).map((run) => [run.target, run.status]), [
      ["japan-launch", "failed"],
      ["saved-carts", "passed"],
      ["tip-jar", "passed"],
    ]);
    // A feature's failures stay with its run; Huddles take owner forks' results only.
    assert.deepEqual(runs.ownerForkResults(event).results, []);
  });

  test("the plan facts run lists each reading feature as a target with its person", () => {
    const origin = features.find((feature) => feature.id === ORIGIN) as Feature;
    const request = factsRequest(origin, "b".repeat(40), scopeMap, features, []);
    const [main, ...others] = request.targets;
    assert.deepEqual([main?.id, main?.person], [PLAN_MAIN_TARGET, null]);
    assert.deepEqual(others.map((target) => target.id).sort(), READERS);
    for (const target of others) assert.equal(target.person, features.find((feature) => feature.id === target.id)?.personId);
  });
});

describe("migrating a CombinedRun table keyed by owner", () => {
  test("each old run becomes its owner fork's run, and scheduling goes on by target", () => {
    const { sql } = sqlite();
    sql.exec(`CREATE TABLE CombinedRun (
      run_id TEXT PRIMARY KEY, trigger_owner TEXT NOT NULL, trigger_sha TEXT NOT NULL, baseline_sha TEXT NOT NULL,
      owner_id TEXT NOT NULL, owner_checkpoint TEXT NOT NULL, command_ids TEXT NOT NULL, status TEXT NOT NULL,
      claimed_by TEXT, claimed_at INTEGER, completed_at INTEGER, scheduled_at INTEGER NOT NULL,
      UNIQUE (trigger_owner, trigger_sha, owner_id, owner_checkpoint))`);
    sql.exec(
      `INSERT INTO CombinedRun VALUES ('run_1', 'priya', ?, ?, 'jun', ?, '["test:analytics"]', 'passed', NULL, NULL, 2, 1)`,
      "a".repeat(40),
      "b".repeat(40),
      "c".repeat(40),
    );
    const runs = new CombinedRunStore(sql);
    const [old] = runs.byTrigger("priya", "a".repeat(40));
    assert.deepEqual([old?.target, old?.fork, old?.ownerId, old?.status], ["jun", "owner-jun", "jun", "passed"]);
    const trigger = { ownerId: "priya", sha: "a".repeat(40), baselineSha: "b".repeat(40) };
    const added = runs.schedule({ trigger, target: "weekly-report", fork: "feature-weekly-report", ownerId: "jun", ownerCheckpoint: "d".repeat(40), commandIds: ["test:analytics"] });
    assert.equal(added?.target, "weekly-report");
    assert.equal(runs.byTrigger("priya", "a".repeat(40)).length, 2);
  });
});
