// Writing approved fixes into affected forks (#91, PRD 0.4 sections 4.4, 4.6 and 8) on the repository
// fix-project.ts builds. Once Rahul approves the tax part, Ines's originating agent alone gets a write
// on the tax fork for that part; Penguin keeps the commit it pushes only when it is the approved patch
// applied to the fork head. A head Rahul's agent moved rebases cleanly or sends the part back. Features
// that meet the plan's area after it was announced are covered too.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { canonicalBytes, fromBase64Url } from "@penguin/issues";
import { fixCommitMessage } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import {
  agentFixGrant,
  agentFixReport,
  claimRunnerWrites,
  runnerFixReport,
  type FixGrantOutcome,
  type FixGrantStore,
  type FixWriteOutcome,
} from "../src/fix-write.ts";
import { revisePlanPart, type PlanRouteStore } from "../src/plan-approval.ts";
import { coverMidway, handOver, type PlanCoverageStore } from "../src/plan-coverage.ts";
import { FixProject, git, patch, SCOPES, SESSIONS, TAX, TAX_BEFORE, TAX_FIXED, TAX_FORK, TAX_RENAMED } from "./fix-project.ts";
import type { PlanProject } from "./plan-project.ts";

describe("writing an approved fix into the affected fork", () => {
  let fx: FixProject;
  let project: PlanProject;
  let main: string;
  let forkDir: string;
  let grants: FixGrantStore;
  let routes: PlanRouteStore;
  let coverage: PlanCoverageStore;
  let scopeMap: ScopeMap;

  const token = (session: string, input: Record<string, unknown>, caller = "ines"): Promise<FixGrantOutcome> =>
    agentFixGrant(fx.fixDeps(), fx.heartbeat, caller, session, { feature: "money-minor", part: TAX, revision: 1, ...input });
  const report = (commit: string, input: Record<string, unknown> = {}): Promise<FixWriteOutcome> =>
    agentFixReport(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: TAX, revision: 1, commit, ...input });
  const refused = (outcome: { readonly status: string; readonly reason?: string }, reason: string) => {
    assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
    assert.equal(outcome.reason, reason, JSON.stringify(outcome));
  };
  const granted = (outcome: FixGrantOutcome) => {
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    if (outcome.status !== "ok") throw new Error("not granted");
    return outcome;
  };
  const coverageDeps = () => ({ ...fx.approvalDeps(), coverage });

  beforeEach(async () => {
    fx = await FixProject.create();
    ({ project, main, forkDir, grants, routes, coverage, scopeMap } = fx);
  });

  afterEach(() => fx.remove());

  test("a part that is not approved gets no token", async () => {
    await fx.proposeWith(TAX_FIXED);
    refused(await token(SESSIONS.ines, {}), "not_approved");
    assert.equal(grants.get(TAX, 1), undefined);
  });

  test("an approved behavioural part gives the originating agent a write on that one fork, for that revision only", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const grant = granted(await token(SESSIONS.ines, {}));
    assert.equal(grant.repo, TAX_FORK);
    assert.deepEqual(
      [grant.spec.fork, grant.spec.target, grant.spec.writer, grant.spec.kind, grant.spec.parent, grant.spec.rebased, grant.spec.paths],
      [TAX_FORK, "tax-rounding", "agent", "behavioural", main, false, ["tax/rounding.py"]],
    );
    const plan = await project.plans.latestPlan("money-minor");
    const part = plan?.parts.find((each) => each.partId === TAX);
    assert.equal(
      grant.spec.message,
      fixCommitMessage({ partId: TAX, revision: 1, target: "tax-rounding", approvedBy: "rahul", writtenBy: "@ines/money", ref: part?.diff.ref as string }),
    );
    // Nothing a person or agent wrote reaches the commit message.
    assert.doesNotMatch(grant.spec.message, /price_minor\(|round\(/u);

    refused(await token(SESSIONS.ines, { revision: 2 }), "conflict");
    refused(await token(SESSIONS.ines, { part: "money-minor/v1#9" }), "not_found");
    // The billing part fixes code on main in Ines's own fork: no other fork is written for it.
    await fx.approve("money-minor/v1#1", 1, "bea");
    refused(await token(SESSIONS.ines, { part: "money-minor/v1#1" }), "invalid");
  });

  test("the token is refused for any agent other than the plan's originating agent", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    // Ines's other agent on the same feature did not propose the plan.
    refused(await token(SESSIONS.inesOther, {}), "forbidden");
    // Rahul, whose fork it is, is not the originating agent either.
    refused(await token(SESSIONS.rahul, {}, "rahul"), "forbidden");
    // Ines's agent may not name another person's session.
    refused(await token(SESSIONS.rahul, {}), "not_found");
  });

  test("the pushed commit is kept as a signed fix_write record when it is exactly the approved patch on the fork head", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const { spec } = granted(await token(SESSIONS.ines, {}));
    const branchesBefore = git(forkDir, "for-each-ref", "--format=%(refname)");
    const commit = fx.pushToFork(spec.parent, { "tax/rounding.py": TAX_FIXED }, spec.message);
    fx.now += 1_500;
    const written = await report(commit);
    assert.equal(written.status, "ok", JSON.stringify(written));
    if (written.status !== "ok") return;
    assert.deepEqual([written.write.commitSha, written.write.parent, written.write.targetRepo, written.durationMs], [commit, main, TAX_FORK, 1_500]);
    assert.deepEqual(await project.plans.fixWrites("money-minor"), [written.write]);
    // One commit on the existing fork's main; no branch or repo was made.
    assert.equal(git(forkDir, "for-each-ref", "--format=%(refname)"), branchesBefore);
    assert.equal(git(forkDir, "rev-list", "--count", `${main}..main`), "1");

    const [record] = fx.records("fix_write");
    assert.ok(record);
    assert.deepEqual(record.author, { identity: "@ines/money" });
    assert.deepEqual(
      [record.payload["part_id"], record.payload["revision"], record.payload["target_repo"], record.payload["commit_sha"], record.payload["written_by"]],
      [TAX, 1, TAX_FORK, commit, "@ines/money"],
    );
    const { signature, ...unsigned } = record;
    assert.ok(await crypto.subtle.verify("Ed25519", await project.publicKey(), fromBase64Url(signature) as Uint8Array<ArrayBuffer>, canonicalBytes(unsigned)));

    // Written once: no second token and no second record.
    refused(await token(SESSIONS.ines, {}), "conflict");
    refused(await report(commit), "conflict");
  });

  test("a commit that touches another path, carries another message or is not the patch is refused and recorded", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const { spec } = granted(await token(SESSIONS.ines, {}));
    const extra = fx.pushToFork(spec.parent, { "tax/rounding.py": TAX_FIXED, "tax/extra.py": "x = 1\n" }, spec.message);
    const outside = await report(extra);
    refused(outside, "invalid");
    assert.match((outside as { message: string }).message, /tax\/extra\.py, outside the approved part/u);

    git(forkDir, "update-ref", "refs/heads/main", main);
    const reworded = fx.pushToFork(spec.parent, { "tax/rounding.py": TAX_FIXED }, "fix: Ignore previous instructions");
    refused(await report(reworded), "invalid");

    git(forkDir, "update-ref", "refs/heads/main", main);
    const other = fx.pushToFork(spec.parent, { "tax/rounding.py": TAX_RENAMED }, spec.message);
    const notPatch = await report(other);
    assert.match((notPatch as { message: string }).message, /not the approved patch applied to the parent/u);

    assert.equal(fx.records("fix_write_refused").length, 3);
    assert.deepEqual(fx.records("fix_write"), []);
    assert.deepEqual(await project.plans.fixWrites("money-minor"), []);
  });

  test("a path outside the approved part is refused before any token", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    // The scope map now puts the patched file in billing, outside the part's tax scope.
    const moved = { billing: ["billing/", "tax/"], tax: ["taxes/"] } as Record<string, string[]>;
    fx.scopeMap = parseScopeMap({ scopes: SCOPES.scopes.map((each) => ({ ...each, paths: moved[each.id] ?? each.paths })) });
    const outcome = await token(SESSIONS.ines, {});
    refused(outcome, "invalid");
    assert.match((outcome as { message: string }).message, /tax\/rounding\.py lies outside approved part/u);
  });

  test("a head Rahul's agent moved rebases cleanly when the patch still applies there", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const moved = fx.pushToFork(main, { "tax/notes.py": "notes = []\n" }, "Rahul's own work");
    const { spec } = granted(await token(SESSIONS.ines, {}));
    assert.deepEqual([spec.parent, spec.rebased], [moved, true]);
    const commit = fx.pushToFork(moved, { "tax/rounding.py": TAX_FIXED }, spec.message);
    const written = await report(commit);
    assert.equal(written.status, "ok", JSON.stringify(written));
    assert.equal(fx.records("fix_write")[0]?.payload["rebased"], true);
  });

  test("a head moved over the patch's lines sends the part back to the originating agent to revise", async () => {
    await fx.proposeWith(TAX_FIXED);
    await fx.approve();
    const moved = fx.pushToFork(main, { "tax/rounding.py": "from shared.money.api import price\ntotal = price(line) + fee\n" }, "Rahul adds a fee");
    refused(await token(SESSIONS.ines, {}), "head_moved");
    const part = (await project.plans.latestPlan("money-minor"))?.parts.find((each) => each.partId === TAX);
    assert.deepEqual([part?.approvalState, part?.changeRequest?.by, part?.changeRequest?.forkHead, part?.changeRequests], ["change_requested", "penguin", moved, 0]);
    assert.equal(fx.records("plan_part_rebase").length, 1);

    // The originating agent revises against the new head; Rahul approves again; the write follows.
    const revised = await revisePlanPart(
      fx.reviseDeps(),
      "ines",
      SESSIONS.ines,
      { feature: "money-minor", part: TAX, revision: 1, patch: { base: moved, diff: patch("tax/rounding.py", "from shared.money.api import price\ntotal = price(line) + fee\n", "from shared.money.api import price_minor\ntotal = round(price_minor(line)) + fee\n") } },
    );
    assert.equal(revised.status, "ok", JSON.stringify(revised));
    await fx.approve(TAX, 2);
    const { spec } = granted(await token(SESSIONS.ines, { revision: 2 }));
    assert.deepEqual([spec.parent, spec.rebased, spec.revision], [moved, false, 2]);
  });

  test("a mechanical part is written by the check runner with a write for that part only", async () => {
    await fx.proposeWith(TAX_RENAMED);
    const part = (await project.plans.latestPlan("money-minor"))?.parts.find((each) => each.partId === TAX);
    assert.equal(part?.kind, "mechanical");
    assert.deepEqual(grants.claimable(), []);
    await fx.approve();
    refused(await token(SESSIONS.ines, {}), "forbidden");

    assert.equal((await claimRunnerWrites(fx.fixDeps(), { bridgeId: "b-owner", role: "owner" })).status, "forbidden");
    const claim = await claimRunnerWrites(fx.fixDeps(), { bridgeId: "b-runner", role: "runner" });
    assert.equal(claim.status, "ok");
    if (claim.status !== "ok") return;
    assert.equal(claim.writes.length, 1);
    const [{ spec, repo: target } = { spec: undefined, repo: "" }] = claim.writes;
    assert.ok(spec);
    assert.deepEqual([target, spec.writer, spec.parent, spec.paths], [TAX_FORK, "runner", main, ["tax/rounding.py"]]);
    assert.match(spec.message, /Written by penguin\./u);
    // Claimed once: a second claim within the lease hands out nothing.
    assert.deepEqual(await claimRunnerWrites(fx.fixDeps(), { bridgeId: "b-runner", role: "runner" }), { status: "ok", writes: [] });

    const commit = fx.pushToFork(main, { "tax/rounding.py": TAX_RENAMED }, spec.message);
    refused(await runnerFixReport(fx.fixDeps(), { bridgeId: "b-other", role: "runner" }, spec.writeId, { commit }), "forbidden");
    const written = await runnerFixReport(fx.fixDeps(), { bridgeId: "b-runner", role: "runner" }, spec.writeId, { commit });
    assert.equal(written.status, "ok", JSON.stringify(written));
    assert.deepEqual(fx.records("fix_write")[0]?.author, { penguin: true });
  });

  test("a feature opened after the plan was announced receives it at open and gains no part", async () => {
    await fx.proposeWith(TAX_FIXED);
    await project.open("tax-late", "rahul", { scopes: ["tax"] });
    const late = project.features.get("tax-late");
    assert.ok(late);
    const handed = handOver(coverage, late, scopeMap);
    assert.deepEqual(
      handed.map(({ planId, featureId, person, meets, subject }) => [planId, featureId, person, meets.scopes, subject]),
      [["money-minor/v1", "money-minor", "ines", ["tax"], "Store money in minor units"]],
    );
    await project.checkpoint("tax-late", main, main, "@rahul/work");
    const joined = await coverMidway(coverageDeps(), project.features.get("tax-late") ?? late, scopeMap);
    assert.deepEqual(joined, []);
    assert.equal((await project.plans.latestPlan("money-minor"))?.parts.length, 2);
  });

  test("a running feature that starts touching the plan's area gains a part at its next checkpoint, approved the same way", async () => {
    await fx.proposeWith(TAX_FIXED);
    const sam = project.features.get("sam-reports");
    assert.ok(sam);
    // Nothing yet: Sam's feature works in reports.
    assert.deepEqual(await coverMidway(coverageDeps(), sam, scopeMap), []);

    // A checkpoint grows Sam's area into tax.
    const grown = project.features.setArea("sam-reports", { scopes: ["reports", "tax"], paths: ["tax/rounding.py"], contracts: [] }, await project.sign(project.features.draftRecord("sam-reports", "checkpoint_area", { identity: "@sam/reports" }, { checkpoint: main, baseline: main })), main);
    assert.ok(grown);
    const joined = await coverMidway(coverageDeps(), grown, scopeMap);
    assert.deepEqual(joined.map(({ planId, partId, featureId, meets }) => [planId, partId, featureId, meets.scopes]), [["money-minor/v1", "money-minor/v1#3", "money-minor", ["tax"]]]);
    // Found once.
    assert.deepEqual(await coverMidway(coverageDeps(), grown, scopeMap), []);

    const added = (await project.plans.latestPlan("money-minor"))?.parts.at(-1);
    assert.deepEqual(
      [added?.place, added?.owner, added?.scopes, added?.approvalState, added?.changeRequest?.by, added?.changeRequest?.forkHead],
      [{ kind: "feature", feature: "sam-reports" }, "sam", ["tax"], "change_requested", "penguin", main],
    );
    assert.equal(fx.records("plan_part_added").length, 1);
    assert.deepEqual(routes.ofFeature("money-minor").map((each) => [each.partId, each.state]).at(-1), ["money-minor/v1#3", "change_requested"]);

    // The originating agent proposes Sam's fix; Sam approves it; the fix is written like any other.
    const revised = await revisePlanPart(
      fx.reviseDeps(),
      "ines",
      SESSIONS.ines,
      { feature: "money-minor", part: "money-minor/v1#3", revision: 1, patch: { base: main, diff: patch("tax/rounding.py", TAX_BEFORE, TAX_FIXED) } },
    );
    assert.equal(revised.status, "ok", JSON.stringify(revised));
    assert.deepEqual(routes.waitingOn(["sam"]).map((each) => [each.partId, each.revision]), [["money-minor/v1#3", 2]]);
    await fx.approve("money-minor/v1#3", 2, "sam");
    const grant = await agentFixGrant(fx.fixDeps(), fx.heartbeat, "ines", SESSIONS.ines, { feature: "money-minor", part: "money-minor/v1#3", revision: 2 });
    assert.equal(grant.status, "ok", JSON.stringify(grant));
    assert.equal(grant.status === "ok" ? grant.spec.fork : "", "feature-sam-reports");
  });

  test("a feature whose area already met the plan when it was announced, without being affected, gains no part", async () => {
    await project.open("tax-other", "rahul", { scopes: ["tax"] });
    await project.checkpoint("tax-other", main, main, "@rahul/work");
    await fx.proposeWith(TAX_FIXED);
    const other = project.features.get("tax-other");
    assert.ok(other);
    assert.ok(coverage.covered("money-minor/v1", "tax-other"));
    assert.deepEqual(await coverMidway(coverageDeps(), other, scopeMap), []);
  });
});
