import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { consumePushEvents, parsePushEvent, type IssuesPushEvent, type QueueMessage } from "../src/push-events.ts";

const target = { namespace: "penguin", repoName: "issues" };
const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);

/** A `cf.artifacts.repo.pushed` event shaped like the Artifacts event-subscriptions guide's example. */
type EventOverrides = { repoName?: string; namespace?: string; ref?: string; before?: string; after?: string };

function pushed(overrides: EventOverrides = {}) {
  return {
    type: "cf.artifacts.repo.pushed",
    source: {
      type: "artifacts.repo",
      namespace: overrides.namespace ?? "penguin",
      repoName: overrides.repoName ?? "issues",
    },
    payload: {
      ref: overrides.ref ?? "refs/heads/main",
      before: overrides.before ?? BEFORE,
      after: overrides.after ?? AFTER,
      commits: [{ id: AFTER, message: "ops", parents: [BEFORE] }],
      totalCommitsCount: 1,
      commitsTruncated: false,
    },
    metadata: { eventSchemaVersion: 1, eventTimestamp: "2026-10-10T12:00:00.000Z" },
  };
}

class FakeMessage implements QueueMessage {
  state: "pending" | "acked" | "retried" = "pending";
  readonly attempts = 1;
  readonly id: string;
  readonly body: unknown;
  constructor(id: string, body: unknown) {
    this.id = id;
    this.body = body;
  }
  ack(): void {
    this.state = "acked";
  }
  retry(): void {
    this.state = "retried";
  }
}

const quiet = { info: () => undefined, error: () => undefined };

describe("parsePushEvent", () => {
  test("accepts a push to the issues repo's main branch and keeps only the two SHAs", () => {
    assert.deepEqual(parsePushEvent(pushed(), target), { ok: true, push: { before: BEFORE, after: AFTER } });
  });

  test("ignores events from other repos, namespaces, refs and event types", () => {
    for (const body of [
      pushed({ repoName: "base" }),
      pushed({ repoName: "owner-jun" }),
      pushed({ namespace: "elsewhere" }),
      pushed({ ref: "refs/heads/side" }),
      { ...pushed(), type: "cf.artifacts.repo.fetched" },
      { ...pushed(), source: { type: "artifacts", namespace: "penguin", repoName: "issues" } },
      "not an event",
      null,
    ]) {
      assert.equal(parsePushEvent(body, target).ok, false, JSON.stringify(body));
    }
  });

  test("ignores malformed SHAs and branch deletions; accepts a branch's first push", () => {
    assert.equal(parsePushEvent(pushed({ after: "HEAD" }), target).ok, false);
    assert.equal(parsePushEvent(pushed({ after: "B".repeat(40) }), target).ok, false);
    assert.equal(parsePushEvent(pushed({ after: "0".repeat(40) }), target).ok, false);
    assert.equal(parsePushEvent(pushed({ before: "0".repeat(40) }), target).ok, true);
  });
});

describe("consumePushEvents", () => {
  test("acknowledges a push only after the ingest resolves, and hands over only the SHAs", async () => {
    const message = new FakeMessage("m1", pushed());
    const seen: IssuesPushEvent[] = [];
    let stateDuringIngest: string | undefined;
    await consumePushEvents([message], target, async (push) => {
      stateDuringIngest = message.state;
      seen.push(push);
      return { commits: 1 };
    }, quiet);

    assert.equal(stateDuringIngest, "pending");
    assert.equal(message.state, "acked");
    assert.deepEqual(seen, [{ before: BEFORE, after: AFTER }]);
  });

  test("an event from any repo other than issues is acknowledged and ignored", async () => {
    const message = new FakeMessage("m1", pushed({ repoName: "owner-priya" }));
    let ingested = 0;
    await consumePushEvents([message], target, async () => (ingested += 1), quiet);
    assert.equal(message.state, "acked");
    assert.equal(ingested, 0);
  });

  test("a failed ingest retries that message and the rest of the batch still runs, in order", async () => {
    const failing = new FakeMessage("m1", pushed({ after: "c".repeat(40) }));
    const ok = new FakeMessage("m2", pushed());
    const order: string[] = [];
    const errors: Record<string, unknown>[] = [];
    await consumePushEvents(
      [failing, ok],
      target,
      async (push) => {
        order.push(push.after);
        if (push.after === "c".repeat(40)) throw new Error("PENGUIN_OP_SIGNING_KEY is not set");
      },
      { info: () => undefined, error: (entry) => errors.push(entry) },
    );

    assert.deepEqual(order, ["c".repeat(40), AFTER]);
    assert.equal(failing.state, "retried");
    assert.equal(ok.state, "acked");
    assert.match(String(errors[0]?.["error"]), /PENGUIN_OP_SIGNING_KEY/);
  });

  test("logs the time from the push event to the acknowledgement", async () => {
    const entries: Record<string, unknown>[] = [];
    await consumePushEvents(
      [new FakeMessage("m1", pushed())],
      target,
      async () => ({}),
      { info: (entry) => entries.push(entry), error: () => undefined },
      () => Date.parse("2026-10-10T12:00:01.250Z"),
    );
    assert.equal(entries[0]?.["sincePushMs"], 1250);
  });
});
