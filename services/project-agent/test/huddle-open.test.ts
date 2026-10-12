import assert from "node:assert/strict";
import net from "node:net";
import { describe, test } from "node:test";

import type { CombinedRunEvent } from "@penguin/protocol";

import type { HuddleOpenDeps } from "../src/huddle-open.ts";
import { HuddleProject } from "./huddle-project.ts";

// Distinct full SHAs and fingerprints, spelled out so each reads as what it stands for.
const TRIGGER = "a".repeat(40);
const BASELINE = "b".repeat(40);
const JUN_CHECKPOINT = "c".repeat(40);
const SAM_CHECKPOINT = "d".repeat(40);
const JUN_FINGERPRINT = "1".repeat(64);
const SAM_FINGERPRINT = "2".repeat(64);

function fingerprint(id: string, commandId: string) {
  return { id, commit: "e".repeat(40), lockfileHash: "f".repeat(64), commandId };
}

/** Priya's checkpoint merged with Jun's and Sam's fails the fixture's three tests. */
function failingRun(overrides: Partial<CombinedRunEvent> = {}): CombinedRunEvent {
  return {
    trigger: { ownerId: "priya", sha: TRIGGER, baselineSha: BASELINE },
    changedScopes: ["identity-map"],
    unmapped: [],
    results: [
      {
        target: "jun",
        ownerId: "jun",
        scopeId: "analytics",
        commandId: "test:analytics",
        status: "failed",
        ownerCheckpoint: JUN_CHECKPOINT,
        fingerprint: fingerprint(JUN_FINGERPRINT, "test:analytics"),
        failingTests: [
          { nodeId: "analytics/tests/test_identity.py::test_shared_device_split", testId: "test_identity::shared_device_split" },
          { nodeId: "analytics/tests/test_retention.py::test_dau_stable", testId: "test_retention::dau_stable" },
        ],
      },
      {
        target: "sam",
        ownerId: "sam",
        scopeId: "messaging",
        commandId: "test:messaging",
        status: "failed",
        ownerCheckpoint: SAM_CHECKPOINT,
        fingerprint: fingerprint(SAM_FINGERPRINT, "test:messaging"),
        failingTests: [
          { nodeId: "messaging/tests/test_consent.py::test_unsubscribe_survives", testId: "test_consent::unsubscribe_survives" },
        ],
      },
    ],
    ...overrides,
  };
}

function published(): HuddleProject {
  const project = new HuddleProject();
  project.publish("priya", TRIGGER);
  return project;
}

/**
 * Runs `body` with outbound sockets and `fetch` replaced by recorders that refuse, and returns what
 * was attempted. A model call needs the network, so an empty list means none was made.
 */
async function withoutNetwork<T>(body: () => Promise<T>): Promise<{ value: T; attempts: string[] }> {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    attempts.push(`connect ${JSON.stringify(args[0])}`);
    throw new Error("network access while opening a Huddle");
  } as typeof connect;
  globalThis.fetch = (input) => {
    attempts.push(`fetch ${String(input)}`);
    return Promise.reject(new Error("network access while opening a Huddle"));
  };
  try {
    return { value: await body(), attempts };
  } finally {
    net.Socket.prototype.connect = connect;
    globalThis.fetch = originalFetch;
  }
}

describe("opening a Huddle issue from a failing combined run", () => {
  test("opens one Huddle issue with a fix sub-issue per failing test and the evidence attached", async () => {
    const project = published();
    const outcome = await project.open(failingRun());
    assert.equal(outcome.status, "opened", JSON.stringify(outcome));
    assert.ok(outcome.status === "opened");

    assert.deepEqual(project.huddleIssues(), ["1"]);
    const huddle = project.index.issue("1");
    assert.ok(huddle);
    assert.equal(huddle.title, "identity-map change breaks analytics and messaging");
    assert.equal(huddle.state, "fixing");
    assert.deepEqual(huddle.labels, ["huddle", "scope:analytics", "scope:identity-map", "scope:messaging"]);
    assert.deepEqual(
      [...huddle.linkedCommits.values()].map((link) => [link.kind, link.repo, link.sha]),
      [["trigger", "owner-priya", TRIGGER]],
    );
    assert.deepEqual(
      [...huddle.checks.values()].map((check) => [check.commandId, check.test, check.result, check.fingerprint]),
      [
        ["test:analytics", "test_identity::shared_device_split", "fail", JUN_FINGERPRINT],
        ["test:analytics", "test_retention::dau_stable", "fail", JUN_FINGERPRINT],
        ["test:messaging", "test_consent::unsubscribe_survives", "fail", SAM_FINGERPRINT],
      ],
    );
    assert.deepEqual(project.fixes("1"), [
      `@jun/reports test_identity::shared_device_split ${JUN_FINGERPRINT}`,
      `@jun/reports test_retention::dau_stable ${JUN_FINGERPRINT}`,
      `@sam/campaigns test_consent::unsubscribe_survives ${SAM_FINGERPRINT}`,
    ]);
    const sub = project.index.issue("3");
    assert.ok(sub);
    assert.equal(sub.title, "Fix test_retention::dau_stable after the identity-map change");
    assert.deepEqual(sub.labels, ["scope:analytics"]);
    assert.deepEqual(
      [...sub.linkedCommits.values()].map((link) => `${link.kind} ${link.repo}@${link.sha}`),
      [`related owner-jun@${JUN_CHECKPOINT}`],
    );

    // The immutable initiating revision is recorded with the Huddle.
    assert.equal(outcome.huddle.triggerCommit, `owner-priya@${TRIGGER}`);
    assert.equal(outcome.huddle.baselineSha, BASELINE);
    assert.equal(outcome.huddle.issueId, "1");
    assert.equal(outcome.huddle.status, "open");
    assert.equal(outcome.huddle.huddleRepo, null);
    assert.equal(outcome.operations, project.appliedCount());
  });

  test("the state starts at DETECTED and moves to FIXING once the sub-issues exist, through operations", async () => {
    const project = published();
    await project.open(failingRun());
    const { timeline } = project.index.read("1");
    const states = timeline.filter((entry) => entry.type === "change_state").map((entry) => entry.payload);
    assert.deepEqual(
      states.map((payload) => (payload as { state: string }).state),
      ["detected", "fixing"],
    );
    const lastSubIssue = timeline.findLastIndex((entry) => entry.type === "open_sub_issue");
    const fixing = timeline.findIndex((entry) => (entry.payload as { state?: string }).state === "fixing");
    assert.ok(lastSubIssue < fixing);
    assert.ok(timeline.every((entry) => entry.status === "applied" && entry.author === "penguin"));
  });

  test("only the owners involved get inbox items; an unrelated owner gets none", async () => {
    const project = published();
    await project.open(failingRun());
    const items = (person: string) =>
      project.inbox
        .items(person)
        .map((item) => `${item.reason} #${item.issueId}`)
        .sort();
    assert.deepEqual(items("priya"), ["mentioned #1"]);
    // No session of the assigned identity runs, so the router also asks the owner to start one.
    assert.deepEqual(items("jun"), ["assigned #2", "assigned #3", "mentioned #1", "start_session #2", "start_session #3"]);
    assert.deepEqual(items("sam"), ["assigned #4", "mentioned #1", "start_session #4"]);
    assert.deepEqual(items("lee"), []);
  });

  test("a second combined run on the same trigger opens nothing and writes no operation", async () => {
    const project = published();
    const first = await project.open(failingRun());
    assert.equal(first.status, "opened");
    const applied = project.appliedCount();
    const ids = project.index.ids();

    const second = await project.open(failingRun());
    assert.equal(second.status, "existing");
    assert.equal(project.appliedCount(), applied);
    assert.deepEqual(project.index.ids(), ids);
    assert.deepEqual(project.huddleIssues(), ["1"]);
  });

  test("a fix goes to the session that reported the failing checkpoint, else a chartered identity, else the owner", async () => {
    const project = published();
    project.identity("jun", "@jun/dashboards", ["analytics"]);
    const session = project.sessions.register("jun", {
      identity: "@jun/dashboards",
      vendor: "codex",
      worktreeId: "wt_0123456789abcdef",
      branch: "retention",
    });
    assert.equal(session.status, "ok");
    assert.ok(session.status === "ok");
    // Jun's checkpoint was reported by the @jun/dashboards session; Sam's by Sam's bridge.
    project.publish("jun", JUN_CHECKPOINT, session.session.id);
    project.publish("sam", SAM_CHECKPOINT);
    await project.open(failingRun());
    assert.deepEqual(
      project.fixes("1").map((fix) => fix.split(" ")[0]),
      ["@jun/dashboards", "@jun/dashboards", "@sam/campaigns"],
    );

    const bare = new HuddleProject({ seedIdentities: false });
    bare.publish("priya", TRIGGER);
    await bare.open(failingRun());
    assert.deepEqual(
      bare.fixes("1").map((fix) => fix.split(" ")[0]),
      ["jun", "jun", "sam"],
    );
  });

  test("changed files in no scope show as unassigned impact with a thread asking the owners for a scope", async () => {
    const project = published();
    await project.open(failingRun({ unmapped: ["scripts/backfill.py"] }));
    const huddle = project.index.issue("1");
    assert.ok(huddle);
    const threads = [...huddle.threads.values()];
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.anchor, "unassigned-impact");
    assert.match(threads[0]?.body ?? "", /- scripts\/backfill\.py/u);
    assert.deepEqual(threads[0]?.needsPersonIds, ["jun", "lee", "priya", "sam"]);
    assert.equal(huddle.state, "fixing");
  });

  test("an opening interrupted part way resumes from the event that began it", async () => {
    const project = published();
    let calls = 0;
    const deps = await project.deps();
    const failing: Partial<HuddleOpenDeps> = {
      submit: async (operation) => {
        calls += 1;
        if (calls === 12) return { status: "rejected", reason: "superseded_version", message: "the issue moved on" };
        return deps.submit(operation);
      },
    };
    const interrupted = await project.open(failingRun(), failing);
    assert.equal(interrupted.status, "rejected");
    assert.ok(interrupted.status === "rejected");
    assert.equal(interrupted.reason, "operation_rejected");
    assert.equal(project.huddles.get(`owner-priya@${TRIGGER}`)?.status, "opening");

    // The retry carries a different event; the opening follows the stored one.
    const resumed = await project.open(failingRun({ unmapped: ["scripts/backfill.py"] }));
    assert.equal(resumed.status, "opened");
    assert.deepEqual(project.huddleIssues(), ["1"]);
    assert.deepEqual(project.index.ids(), ["1", "2", "3", "4"]);
    assert.equal(project.fixes("1").length, 3);
    assert.equal(project.index.issue("1")?.threads.size, 0);
    assert.equal(project.index.issue("1")?.state, "fixing");
  });

  test("an issue number taken by another writer moves the Huddle to the next one", async () => {
    const project = published();
    const deps = await project.deps();
    await deps.submit({ issue: 1, type: "create", base_version: 0, payload: { title: "Unrelated" } });
    let stale = true;
    const outcome = await project.open(failingRun(), {
      // The first read misses issue 1, as when a person creates it between the read and Penguin's create.
      issueIds: () => {
        if (!stale) return project.index.ids();
        stale = false;
        return [];
      },
    });
    assert.equal(outcome.status, "opened");
    assert.deepEqual(project.huddleIssues(), ["2"]);
  });

  test("an unpublished trigger, an invalid event and a run with no failures open nothing", async () => {
    const project = new HuddleProject();
    const unpublished = await project.open(failingRun());
    assert.deepEqual(unpublished.status === "rejected" && unpublished.reason, "unpublished");
    project.publish("priya", TRIGGER);

    const invalid = await project.open({ ...failingRun(), trigger: { ownerId: "priya", sha: "7c41e2" } });
    assert.ok(invalid.status === "rejected");
    assert.equal(invalid.reason, "invalid");
    assert.match(invalid.message, /trigger\.sha/u);

    const passing = failingRun({
      results: [
        {
          target: "jun",
          ownerId: "jun",
          scopeId: "analytics",
          commandId: "test:analytics",
          status: "passed",
          ownerCheckpoint: JUN_CHECKPOINT,
          fingerprint: fingerprint(JUN_FINGERPRINT, "test:analytics"),
          failingTests: [],
        },
      ],
    });
    assert.equal((await project.open(passing)).status, "no_failures");
    assert.equal(project.appliedCount(), 0);
    assert.equal(project.huddles.get(`owner-priya@${TRIGGER}`), undefined);
  });

  test("no model call is made on this path", async () => {
    const project = published();
    const { value, attempts } = await withoutNetwork(() => project.open(failingRun({ unmapped: ["README.md"] })));
    assert.equal(value.status, "opened");
    assert.deepEqual(attempts, []);
  });
});
