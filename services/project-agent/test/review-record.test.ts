// The check runner's claim and record of reviews (#101): the lease, the first report winning, a table
// from before the runner's columns, and routing derived from the stored form rather than the runner.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { REVIEW_SCHEMA_VERSION, SIDE_BY_SIDE_COMMAND_ID, SIDE_BY_SIDE_TOOL, type ReviewRecord } from "@penguin/protocol";

import { claimReviews, recordReview } from "../src/review-record.ts";
import { REVIEW_LEASE_MS, ReviewStore, type StoredReview } from "../src/review-submit.ts";
import { sqlite } from "./issues-repo.ts";

const BASE = "a".repeat(40);
const FORK = "b".repeat(40);
const TABLET = "tablet-patrons-separate";
const DAU = "analytics/models.py::daily_active_users";
const RUNNER = { bridgeId: "br_runner", role: "runner" } as const;
const OTHER_RUNNER = { bridgeId: "br_spare", role: "runner" } as const;

function store(now: { value: number }): ReviewStore {
  return new ReviewStore(sqlite().sql, () => now.value);
}

function pending(reviews: ReviewStore, verdict: "holds" | "breaks" = "holds"): StoredReview {
  return reviews.insert({
    featureId: "person-id",
    scopeId: "analytics",
    ownerId: "jun",
    reviewer: "@jun/agent",
    forkSha: FORK,
    baseSha: BASE,
    form: { rows: [{ invariant: TABLET, verdict, evidence: ["analytics/tests/test_dau.py::test_x"], storedData: "None" }], riskyInputs: [], storedDataMarker: null },
    invariants: [{ id: TABLET, scopeId: "analytics", statement: "Patrons on one tablet stay separate", protected: true }],
    state: "pending",
    refusals: [],
  });
}

/** A record of the review whose one example differs, claiming no exceptions of its own. */
function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    base: BASE,
    fork: FORK,
    scope: "analytics",
    state: "accepted",
    refusals: [],
    invariants: [],
    storedShapes: null,
    sideBySide: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      tool: SIDE_BY_SIDE_TOOL,
      commandId: SIDE_BY_SIDE_COMMAND_ID,
      base: BASE,
      fork: FORK,
      scope: "analytics",
      sets: [
        {
          source: "examples",
          file: "analytics/examples/dau.json",
          contract: DAU,
          invariants: [TABLET],
          inputs: ["three patrons on one tablet"],
          differing: [{ name: "three patrons on one tablet", args: {}, main: { status: "returned", value: 3 }, fork: { status: "returned", value: 1 } }],
          invalid: [],
          mainMs: 0.4,
          forkMs: 0.5,
        },
      ],
      totals: { inputs: 1, differing: 1, invalid: 0 },
      timings: { mainMs: 100, forkMs: 110, totalMs: 220 },
    },
    exceptions: [],
    timings: { impactMs: 0, sideBySideMs: 220, totalMs: 230 },
    ...overrides,
  };
}

describe("review claims and records", () => {
  test("a claimed review stays with its runner until the lease runs out", () => {
    const now = { value: 1_000 };
    const reviews = store(now);
    const review = pending(reviews);
    const first = claimReviews(reviews, RUNNER);
    assert.deepEqual(first.status === "ok" ? first.reviews.map((claim) => [claim.reviewId, claim.fork, claim.base, claim.forkSha]) : first, [
      [review.id, "feature-person-id", BASE, FORK],
    ]);
    assert.deepEqual(claimReviews(reviews, OTHER_RUNNER), { status: "ok", reviews: [] });
    now.value += REVIEW_LEASE_MS;
    const again = claimReviews(reviews, OTHER_RUNNER);
    assert.equal(again.status === "ok" ? again.reviews.length : 0, 1);
    assert.equal(reviews.get(review.id)?.claimedBy, OTHER_RUNNER.bridgeId);
    assert.equal(claimReviews(reviews, { bridgeId: "br_jun", role: "owner" }).status, "forbidden");
  });

  test("the first report wins, and routing comes from the stored form, not the runner's list", async () => {
    const reviews = store({ value: 1_000 });
    const review = pending(reviews, "breaks");
    const routed: string[] = [];
    const deps = { reviews, routeToOwner: (ownerId: string, stored: StoredReview) => void routed.push(`${ownerId} ${stored.featureId}/${stored.scopeId}`) };
    const outcome = await recordReview(deps, RUNNER, review.id, record());
    assert.equal(outcome.status, "recorded");
    const stored = reviews.get(review.id);
    assert.equal(stored?.state, "accepted");
    assert.deepEqual(stored?.exceptions, [
      { kind: "broken_invariant", invariant: TABLET, scope: "analytics" },
      { kind: "protected_difference", invariant: TABLET, scope: "analytics", contract: DAU, differing: 1 },
    ]);
    assert.deepEqual(routed, ["jun person-id/analytics"]);
    assert.match(stored?.sideBySideRef ?? "", /^sha256:[0-9a-f]{64}$/);

    const second = await recordReview(deps, RUNNER, review.id, record({ state: "refused" }));
    assert.deepEqual(second.status === "rejected" ? second.reason : second.status, "conflict");
    assert.equal(reviews.get(review.id)?.state, "accepted");
  });

  test("a record of other commits, a malformed record and a non-runner are refused", async () => {
    const reviews = store({ value: 1_000 });
    const review = pending(reviews);
    const deps = { reviews, routeToOwner: () => assert.fail("nothing is routed") };
    const elsewhere = record({ fork: BASE, sideBySide: { ...record().sideBySide, fork: BASE } });
    const reason = async (caller: typeof RUNNER | { bridgeId: string; role: "owner" }, body: unknown) => {
      const outcome = await recordReview(deps, caller, review.id, body);
      return outcome.status === "rejected" ? outcome.reason : outcome.status;
    };
    assert.equal(await reason(RUNNER, elsewhere), "invalid");
    assert.equal(await reason(RUNNER, { ...record(), sideBySide: { ...record().sideBySide, scope: "messaging" } }), "invalid");
    assert.equal(await reason(RUNNER, { ...record(), extra: "<script>" }), "invalid");
    assert.equal(await reason(RUNNER, { ...record(), refusals: [{ code: "made_up", message: "x" }] }), "invalid");
    assert.equal(await reason({ bridgeId: "br_jun", role: "owner" }, record()), "forbidden");
    assert.equal(reviews.get(review.id)?.state, "pending");
  });

  test("a FeatureReview table from before the runner's columns gains them and keeps its rows", () => {
    const { sql } = sqlite();
    sql.exec(`CREATE TABLE FeatureReview (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      reviewer TEXT NOT NULL, fork_sha TEXT NOT NULL, form TEXT NOT NULL, validation_state TEXT NOT NULL,
      refusals TEXT NOT NULL, side_by_side_ref TEXT, created_at INTEGER NOT NULL)`);
    sql.exec(
      `INSERT INTO FeatureReview (feature_id, scope_id, reviewer, fork_sha, form, validation_state, refusals, created_at)
       VALUES ('person-id', 'analytics', '@jun/agent', ?, '{"rows":[],"riskyInputs":[],"storedDataMarker":null}', 'accepted', '[]', 1)`,
      FORK,
    );
    const reviews = new ReviewStore(sql);
    const [old] = reviews.list("person-id");
    assert.deepEqual([old?.state, old?.ownerId, old?.baseSha, old?.record, old?.exceptions], ["accepted", null, null, null, []]);
    // A review accepted before the runner existed has no baseline, so it is never claimed.
    assert.deepEqual(claimReviews(reviews, RUNNER), { status: "ok", reviews: [] });
  });
});
