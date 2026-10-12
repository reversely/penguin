// Two plans writing into the same fork take turns (#133, design.md Build step 4) on the repository
// fix-project.ts builds. Ines's money-minor plan and a second plan of hers, money-display, each carry a
// part for Rahul's running tax-rounding feature. Rahul approves money-minor's part first. Its write
// goes first; the second write waits, is tried again on the head the first left, then is written or
// goes back to its originating agent with the conflict. The block targets then hold both fixes.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { PART_TRIAL_SCHEMA_VERSION, type PartTrialReport } from "@penguin/protocol";

import { blockTargets } from "../src/block-land.ts";
import { retrialReported, retryWaitingWrites } from "../src/fix-retrial.ts";
import { agentFixGrant, agentFixReport, claimRunnerWrites, type FixGrantOutcome, type FixWriteDeps } from "../src/fix-write.ts";
import { PartTrialStore, queueTrialOn, type StoredPartTrial } from "../src/part-trial.ts";
import { approvePlanPart } from "../src/plan-approval.ts";
import type { ReviewStore } from "../src/review-submit.ts";
import { FixProject, git, patch, SESSIONS, TAX, TAX_BEFORE, TAX_FIXED, TAX_RENAMED } from "./fix-project.ts";

const DISPLAY = "money-display";
const DISPLAY_TAX = `${DISPLAY}/v1#2`;
const DISPLAY_SESSION = "s-ines-display";
/** A new file in Rahul's tax scope: it applies on any head of the fork. */
const RATES = "--- /dev/null\n+++ b/tax/rates.py\n@@ -0,0 +1 @@\n+RATE = 0.2\n";
const RUNNER = { bridgeId: "b-runner", role: "runner" } as const;

describe("two plans writing into one fork", () => {
  let fx: FixProject;
  let trials: PartTrialStore;
  const noReviews = { list: () => [] } as unknown as ReviewStore;

  /** The fix-write deps as the ProjectAgent wires them: a kept write asks the re-trials of the fork's waiting writes. */
  const deps = (): FixWriteDeps => {
    const wired: FixWriteDeps = {
      ...fx.fixDeps(),
      written: async (grant, commit) => {
        await retryWaitingWrites({ ...wired, queueTrial: (plan, part, head) => queueTrialOn({ trials, reviews: noReviews }, plan, part, head)?.id ?? null }, grant, commit);
      },
    };
    return wired;
  };
  const token = (feature: string, part: string, session: string): Promise<FixGrantOutcome> =>
    agentFixGrant(deps(), fx.heartbeat, "ines", session, { feature, part, revision: 1 });
  const granted = (outcome: FixGrantOutcome) => {
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    if (outcome.status !== "ok") throw new Error("not granted");
    return outcome.spec;
  };
  const waits = (outcome: FixGrantOutcome, pattern: RegExp) => {
    assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
    assert.equal(outcome.status === "rejected" ? outcome.reason : "", "waiting");
    assert.match(outcome.status === "rejected" ? outcome.message : "", pattern);
  };
  const approve = async (feature: string, part: string) => {
    const decided = await approvePlanPart(fx.approvalDeps(), "rahul", { feature, part, revision: 1 });
    assert.equal(decided.status, "ok", JSON.stringify(decided));
  };
  /** The runner's report of `trial`: built with every test passed, or a conflict with no tree. */
  const report = (trial: StoredPartTrial, built: boolean): PartTrialReport => ({
    schemaVersion: PART_TRIAL_SCHEMA_VERSION,
    trialId: trial.id,
    partId: trial.partId,
    revision: trial.revision,
    checkpoint: trial.checkpoint,
    target: trial.request.target.sha,
    status: built ? "built" : "conflict",
    tree: built ? "1".repeat(40) : null,
    reason: built ? null : "tax/rounding.py: hunk 1 does not match at line 1",
    tests: trial.request.commandIds.map((commandId) => ({
      scopeId: commandId.slice("test:".length),
      commandId,
      status: built ? "passed" : "conflict",
      breaks: [],
      reason: built ? null : "the trial tree was not built",
      durationMs: 1,
    })),
    reviews: [],
    durationMs: 1,
  });
  /** Writes money-minor's tax fix as its originating agent; answers the kept commit. */
  const writeMinor = async (): Promise<string> => {
    const spec = granted(await token("money-minor", TAX, SESSIONS.ines));
    const commit = fx.pushToFork(spec.parent, { "tax/rounding.py": TAX_FIXED }, spec.message);
    const written = await agentFixReport(deps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1, commit });
    assert.equal(written.status, "ok", JSON.stringify(written));
    return commit;
  };

  beforeEach(async () => {
    fx = await FixProject.create();
    trials = new PartTrialStore(fx.project.sql, () => fx.now);
    await fx.project.open(DISPLAY, "ines", { scopes: ["money"] }, { id: DISPLAY_SESSION, handle: "@ines/display" });
    await fx.project.checkpoint(DISPLAY, fx.checkpoint, fx.main, "@ines/display");
  });

  afterEach(() => fx.remove());

  test("the second write waits for the first, is tried again on the new head, then is written on top of it", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.proposeFor(DISPLAY, DISPLAY_SESSION, RATES);
    await approve("money-minor", TAX);
    await approve(DISPLAY, DISPLAY_TAX);

    // Approval order: money-minor's part goes first, and while its write holds the fork the second waits.
    waits(await token(DISPLAY, DISPLAY_TAX, DISPLAY_SESSION), /money-minor\/v1#2 revision 1 was approved earlier/u);
    const first = granted(await token("money-minor", TAX, SESSIONS.ines));
    waits(await token(DISPLAY, DISPLAY_TAX, DISPLAY_SESSION), /holds feature tax-rounding's fork/u);
    const minor = fx.pushToFork(first.parent, { "tax/rounding.py": TAX_FIXED }, first.message);
    const written = await agentFixReport(deps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1, commit: minor });
    assert.equal(written.status, "ok", JSON.stringify(written));

    // The first write moved the fork: the second part is tried again on that head before its write.
    const retrial = trials.ofPart(DISPLAY, DISPLAY_TAX);
    assert.ok(retrial);
    assert.deepEqual([retrial.state, retrial.request.target.id, retrial.request.target.sha], ["pending", "tax-rounding", minor]);
    waits(await token(DISPLAY, DISPLAY_TAX, DISPLAY_SESSION), new RegExp(`tried again on feature tax-rounding's fork head ${minor}`, "u"));

    trials.record(retrial.id, report(retrial, true));
    assert.equal(await retrialReported(deps(), trials.get(retrial.id) as StoredPartTrial), "passed");
    const [record] = fx.project.records(DISPLAY, "plan_part_retrial");
    assert.deepEqual([record?.payload["result"], record?.payload["fork_head"], record?.payload["after_part"]], ["passed", minor, TAX]);

    // Its turn: the write goes on top of the first fix, and both are under the fork's head.
    const second = granted(await token(DISPLAY, DISPLAY_TAX, DISPLAY_SESSION));
    assert.deepEqual([second.parent, second.rebased], [minor, true]);
    const display = fx.pushToFork(second.parent, { "tax/rates.py": "RATE = 0.2\n" }, second.message);
    const kept = await agentFixReport(deps(), fx.heartbeat, "ines", DISPLAY_SESSION, { feature: DISPLAY, part: DISPLAY_TAX, revision: 1, commit: display });
    assert.equal(kept.status, "ok", JSON.stringify(kept));
    assert.equal(git(fx.forkDir, "rev-list", "--count", `${fx.main}..main`), "2");

    // Each plan's block merges onto the fork head that holds every fix written so far.
    for (const own of ["money-minor", DISPLAY]) {
      const targets = await blockTargets({ features: fx.project.features, readRepo: fx.readFork }, own);
      assert.equal(targets.find((target) => target.feature === "tax-rounding")?.sha, display, own);
    }
    assert.deepEqual(fx.grants.writtenSince(["tax-rounding"], 0).map((grant) => grant.partId), [TAX, DISPLAY_TAX]);
  });

  test("a second write whose trial on the new head fails goes back to its originating agent with the conflict", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.proposeFor(DISPLAY, DISPLAY_SESSION, patch("tax/rounding.py", TAX_BEFORE, TAX_RENAMED));
    await approve("money-minor", TAX);
    await approve(DISPLAY, DISPLAY_TAX);
    const display = (await fx.project.plans.latestPlan(DISPLAY))?.parts.find((part) => part.partId === DISPLAY_TAX);
    assert.equal(display?.kind, "mechanical");

    // The check runner's write waits behind the part approved earlier: nothing is claimed.
    const claim = await claimRunnerWrites(deps(), RUNNER);
    assert.deepEqual(claim.status === "ok" ? claim.writes : null, []);
    const minor = await writeMinor();

    const retrial = trials.ofPart(DISPLAY, DISPLAY_TAX);
    assert.equal(retrial?.request.target.sha, minor);
    trials.record(retrial?.id as number, report(retrial as StoredPartTrial, false));
    assert.equal(await retrialReported(deps(), trials.get(retrial?.id as number) as StoredPartTrial), "returned");

    const part = (await fx.project.plans.latestPlan(DISPLAY))?.parts.find((each) => each.partId === DISPLAY_TAX);
    assert.deepEqual([part?.approvalState, part?.changeRequest?.by, part?.changeRequest?.forkHead], ["change_requested", "penguin", minor]);
    assert.match(part?.changeRequest?.text ?? "", /the fix of part money-minor\/v1#2 was written into it/u);
    assert.match(part?.changeRequest?.text ?? "", /does not build there/u);
    assert.equal(fx.grants.get(DISPLAY_TAX, 1)?.state, "withdrawn");
    assert.deepEqual(fx.project.records(DISPLAY, "plan_part_retrial").map((record) => record.payload["result"]), ["returned"]);
    // Nothing more is written into the fork for it.
    const after = await claimRunnerWrites(deps(), RUNNER);
    assert.deepEqual(after.status === "ok" ? after.writes : null, []);
    assert.equal(git(fx.forkDir, "rev-parse", "main"), minor);
    assert.deepEqual(fx.grants.openOn("tax-rounding"), []);
  });

  test("an earlier write whose feature landed gives up its place in the fork's order", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.proposeFor(DISPLAY, DISPLAY_SESSION, RATES);
    await approve("money-minor", TAX);
    await approve(DISPLAY, DISPLAY_TAX);
    // Money-minor reaches main before its fix is written: its plan writes no fix any more.
    fx.project.features.setState("money-minor", ["opening", "building", "landing"], "landed");
    const spec = granted(await token(DISPLAY, DISPLAY_TAX, DISPLAY_SESSION));
    assert.equal(spec.parent, fx.main);
    assert.equal(fx.grants.get(TAX, 1)?.state, "withdrawn");
  });
});
