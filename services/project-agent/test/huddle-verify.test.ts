import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CombinedRunEvent, VerificationReport } from "@penguin/protocol";

import { HuddleProject } from "./huddle-project.ts";

// Distinct full SHAs, spelled out so each reads as what it stands for.
const TRIGGER = "a".repeat(40);
const BASELINE = "b".repeat(40);
const JUN_CHECKPOINT = "c".repeat(40);
const SAM_CHECKPOINT = "d".repeat(40);
const PRIYA_FIX = "1".repeat(40);
const PRIYA_LATER_FIX = "2".repeat(40);
const JUN_FIX = "3".repeat(40);
const REVISION = "4".repeat(40);
const LATER_REVISION = "5".repeat(40);

const COMMANDS = ["test:analytics", "test:identity-map", "test:messaging"];

function failingRun(): CombinedRunEvent {
  const fingerprint = (commandId: string) => ({ id: "9".repeat(64), commit: "e".repeat(40), lockfileHash: "f".repeat(64), commandId });
  return {
    trigger: { ownerId: "priya", sha: TRIGGER, baselineSha: BASELINE },
    changedScopes: ["identity-map"],
    unmapped: [],
    results: [
      {
        ownerId: "jun",
        scopeId: "analytics",
        commandId: "test:analytics",
        status: "failed",
        ownerCheckpoint: JUN_CHECKPOINT,
        fingerprint: fingerprint("test:analytics"),
        failingTests: [{ nodeId: "analytics/tests/test_retention.py::test_dau_stable", testId: "test_retention::dau_stable" }],
      },
      {
        ownerId: "sam",
        scopeId: "messaging",
        commandId: "test:messaging",
        status: "failed",
        ownerCheckpoint: SAM_CHECKPOINT,
        fingerprint: fingerprint("test:messaging"),
        failingTests: [
          { nodeId: "messaging/tests/test_consent.py::test_unsubscribe_survives", testId: "test_consent::unsubscribe_survives" },
        ],
      },
    ],
  };
}

/** A tested report for `revision`: every command passes except those named in `failing`. */
function tested(revision: string, failing: Record<string, string[]> = {}): VerificationReport {
  return {
    status: "tested",
    revision,
    results: COMMANDS.map((commandId, index) => {
      const tests = failing[commandId];
      const fingerprint = { id: String(index + 6).repeat(64), commit: revision, lockfileHash: "f".repeat(64), commandId };
      if (tests === undefined) return { commandId, status: "passed", fingerprint, failingTests: [] };
      return {
        commandId,
        status: "failed",
        fingerprint,
        failingTests: tests.map((testId) => ({ nodeId: `x/${testId}`, testId })),
      };
    }),
  };
}

async function openedHuddle(): Promise<HuddleProject> {
  const project = new HuddleProject();
  project.publish("priya", TRIGGER);
  project.publish("jun", JUN_CHECKPOINT);
  project.publish("sam", SAM_CHECKPOINT);
  const opened = await project.open(failingRun());
  assert.equal(opened.status, "opened", JSON.stringify(opened));
  project.huddles.setRepo(`owner-priya@${TRIGGER}`, "huddle-001");
  return project;
}

function huddle(project: HuddleProject) {
  const issue = project.index.issue("1");
  assert.ok(issue);
  return issue;
}

/** Each check on the Huddle issue as "<command> <test> <result> <repo>@<short sha> [superseded]". */
function checks(project: HuddleProject): string[] {
  return [...huddle(project).checks.values()].map(
    (c) => `${c.commandId} ${c.test ?? "-"} ${c.result} ${c.repo}@${c.sha.slice(0, 4)}${c.supersededBy === null ? "" : " superseded"}`,
  );
}

function specs(project: HuddleProject) {
  return project.verificationSpecs();
}

describe("scheduling verification", () => {
  test("a checkpoint the Huddle opened on schedules nothing", async () => {
    const project = await openedHuddle();
    assert.deepEqual(await project.checkpoint("jun", JUN_CHECKPOINT), [{ status: "unchanged", issueId: "1" }]);
    assert.deepEqual(specs(project), []);
    assert.equal(huddle(project).state, "fixing");
  });

  test("an unrelated owner's checkpoint schedules nothing", async () => {
    const project = await openedHuddle();
    assert.deepEqual(await project.checkpoint("lee", PRIYA_FIX), []);
  });

  test("a fix checkpoint schedules one run of every owner's latest checkpoint and every affected scope", async () => {
    const project = await openedHuddle();
    const [outcome] = await project.checkpoint("priya", PRIYA_FIX);
    assert.equal(outcome?.status, "scheduled");

    assert.deepEqual(specs(project), [
      {
        runId: "1",
        issueId: "1",
        huddleRepo: "huddle-001",
        baseSha: BASELINE,
        checkpoints: [
          { ownerId: "priya", repo: "owner-priya", sha: PRIYA_FIX },
          { ownerId: "jun", repo: "owner-jun", sha: JUN_CHECKPOINT },
          { ownerId: "sam", repo: "owner-sam", sha: SAM_CHECKPOINT },
        ],
        commands: [
          { scopeId: "analytics", commandId: "test:analytics" },
          { scopeId: "identity-map", commandId: "test:identity-map" },
          { scopeId: "messaging", commandId: "test:messaging" },
        ],
      },
    ]);
    const issue = huddle(project);
    assert.equal(issue.state, "verifying");
    const fixLinks = [...issue.linkedCommits.values()].filter((link) => link.kind === "fix");
    assert.deepEqual(fixLinks.map((link) => `${link.repo}@${link.sha}`), [`owner-priya@${PRIYA_FIX}`]);
    // The opening's failing checks applied to the trigger revision; the fix supersedes them.
    assert.ok([...issue.checks.values()].every((check) => check.supersededBy === fixLinks[0]?.opId));
  });

  test("a second report of the same checkpoint writes nothing and keeps one run", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    const applied = project.appliedCount();
    const [again] = await project.checkpoint("priya", PRIYA_FIX);
    assert.deepEqual(again, { status: "scheduled", issueId: "1", runId: "1" });
    assert.equal(project.appliedCount(), applied);
    assert.equal(specs(project).length, 1);
  });

  test("a newer checkpoint before the report supersedes the pending run", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    await project.checkpoint("jun", JUN_FIX);
    assert.deepEqual(specs(project).map((spec) => spec.runId), ["2"]);
    assert.equal(project.verificationRuns.get("1")?.status, "superseded");

    const late = await project.reportVerification("1", tested(REVISION));
    assert.equal(late.status, "superseded");
    assert.equal(huddle(project).state, "verifying");
  });

  test("a Huddle whose repo is not forked yet waits off the runner's list", async () => {
    const project = new HuddleProject();
    project.publish("priya", TRIGGER);
    await project.open(failingRun());
    await project.checkpoint("priya", PRIYA_FIX);
    assert.deepEqual(specs(project), []);
    project.huddles.setRepo(`owner-priya@${TRIGGER}`, "huddle-001");
    assert.equal(specs(project).length, 1);
  });
});

describe("recording a verification run", () => {
  test("passing tests attach one check per command on the integration revision and move the issue to review", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    const outcome = await project.reportVerification("1", tested(REVISION));
    assert.deepEqual(outcome, { status: "recorded", issueId: "1", state: "in_review", commit: `huddle-001@${REVISION}` });

    const current = checks(project).filter((line) => !line.endsWith("superseded"));
    assert.deepEqual(current, [
      "test:analytics - pass huddle-001@4444",
      "test:identity-map - pass huddle-001@4444",
      "test:messaging - pass huddle-001@4444",
    ]);
    const fingerprints = [...huddle(project).checks.values()].filter((c) => c.supersededBy === null).map((c) => c.fingerprint);
    assert.deepEqual(fingerprints, ["6".repeat(64), "7".repeat(64), "8".repeat(64)]);
    assert.equal(project.verificationRuns.get("1")?.status, "done");
    assert.equal(project.verificationRuns.get("1")?.runnerId, "runner-1");
    assert.deepEqual(specs(project), []);
  });

  test("a failing test on a clean merge keeps the issue out of review", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    const outcome = await project.reportVerification("1", tested(REVISION, { "test:analytics": ["test_identity::shared_device_split"] }));
    assert.equal(outcome.status, "recorded");
    const issue = huddle(project);
    assert.equal(issue.state, "fixing");
    assert.match(issue.stateReason ?? "", /test_identity::shared_device_split/u);
    assert.ok(checks(project).includes("test:analytics test_identity::shared_device_split fail huddle-001@4444"));
  });

  test("a newer checkpoint after a failing run supersedes its checks and schedules one new run", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    await project.reportVerification("1", tested(REVISION, { "test:analytics": ["test_identity::shared_device_split"] }));

    const [outcome] = await project.checkpoint("priya", PRIYA_LATER_FIX);
    assert.deepEqual(outcome, { status: "scheduled", issueId: "1", runId: "2" });
    assert.deepEqual(specs(project).map((spec) => spec.runId), ["2"]);
    assert.equal(huddle(project).state, "verifying");
    assert.ok(checks(project).every((line) => line.endsWith("superseded")), checks(project).join("\n"));

    await project.reportVerification("2", tested(LATER_REVISION));
    assert.equal(huddle(project).state, "in_review");
    assert.deepEqual(checks(project).filter((line) => !line.endsWith("superseded")).length, 3);
  });

  test("a repeated report writes nothing", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    await project.reportVerification("1", tested(REVISION));
    const applied = project.appliedCount();
    assert.deepEqual(await project.reportVerification("1", tested(REVISION)), { status: "existing", issueId: "1" });
    assert.equal(project.appliedCount(), applied);
  });

  test("a report that does not answer its run is refused", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    const missing = tested(REVISION);
    assert.equal(missing.status, "tested");
    const short = { ...missing, results: missing.results.slice(1) };
    assert.equal((await project.reportVerification("1", short)).status, "rejected");
    const foreign = { ...missing, results: missing.results.map((r) => ({ ...r, fingerprint: { ...r.fingerprint, commit: LATER_REVISION } })) };
    assert.equal((await project.reportVerification("1", foreign)).status, "rejected");
    assert.deepEqual(await project.reportVerification("9", missing), { status: "rejected", reason: "not_found", message: "no verification run 9" });
    assert.equal(project.verificationRuns.get("1")?.status, "pending");
  });

  test("a checkpoint that does not merge attaches an error check per command and returns the issue to fixing", async () => {
    const project = await openedHuddle();
    await project.checkpoint("priya", PRIYA_FIX);
    const outcome = await project.reportVerification("1", { status: "conflict", ownerId: "priya", sha: PRIYA_FIX, paths: ["identity/merge.py"] });
    assert.equal(outcome.status, "recorded");
    assert.equal(huddle(project).state, "fixing");
    assert.deepEqual(checks(project).filter((line) => !line.endsWith("superseded")), [
      "test:analytics - error owner-priya@1111",
      "test:identity-map - error owner-priya@1111",
      "test:messaging - error owner-priya@1111",
    ]);
  });
});
