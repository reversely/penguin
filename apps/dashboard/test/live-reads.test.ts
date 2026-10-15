// A page reads its data again at most once per burst of live messages, one request per endpoint it
// shows, and never starts a read already in flight (#217). The org page's shell hooks are modelled by
// the endpoints they read and the revisions their effects depend on (app.tsx, approvals.tsx,
// team-page.tsx); the burst, the revisions and the shared reads are the dashboard's own.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { applyMessages, FIRST_REVISIONS, type LiveMessage, type LiveRevisions } from "../src/live-changes.ts";
import { createBurst, LIVE_BURST_MS, readShared, singleFlight } from "../src/live-reads.ts";

/** A read that answers when told to, counting its requests. */
function endpoint() {
  const pending: (() => void)[] = [];
  const read = () => {
    calls.count += 1;
    return new Promise<number>((resolve) => pending.push(() => resolve(calls.count)));
  };
  const calls = { count: 0, read, answer: () => pending.splice(0).forEach((resolve) => resolve()) };
  return calls;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The org page's reads: each hook's endpoints and the revision its effect depends on. */
function orgPage() {
  const endpoints = { overlaps: endpoint(), planParts: endpoint(), team: endpoint(), board: endpoint(), identities: endpoint(), policy: endpoint() };
  const hooks: { key: (live: LiveRevisions) => string; reads: (() => Promise<number>)[] }[] = [
    { key: (live) => `${live.inboxRevision}:${live.revision}:${live.featuresRevision}`, reads: [endpoints.overlaps.read, endpoints.planParts.read] },
    ...[endpoints.team, endpoints.board, endpoints.identities].map((read) => ({
      key: (live: LiveRevisions) => `${live.revision}:${live.inboxRevision}:${live.identitiesRevision}:${live.featuresRevision}`,
      reads: [read.read],
    })),
    { key: (live) => `${live.featuresRevision}`, reads: [endpoints.policy.read] },
  ];
  let live = FIRST_REVISIONS;
  /** One render: every hook whose revision changed runs its effect. */
  const render = (next: LiveRevisions, readEndpoint: (read: () => Promise<number>) => Promise<number>) => {
    for (const hook of hooks) if (hook.key(next) !== hook.key(live)) for (const read of hook.reads) void readEndpoint(read);
    live = next;
  };
  return { endpoints, render, live: () => live };
}

const burstOfTen: LiveMessage[] = [
  ...Array.from({ length: 7 }, (_, index): LiveMessage => ({ kind: "index", issues: [`issue-${index}`] })),
  { kind: "inbox" },
  { kind: "features" },
  { kind: "identities" },
];

test("ten live messages within one second cause one read per endpoint the page shows", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const page = orgPage();
    const burst = createBurst<LiveMessage>(LIVE_BURST_MS, (messages) => page.render(applyMessages(page.live(), messages), readShared));
    for (const message of burstOfTen) {
      burst.add(message);
      mock.timers.tick(90);
    }
    assert.deepEqual(Object.values(page.endpoints).map((calls) => calls.count), [0, 0, 0, 0, 0, 0], "nothing is read inside the burst");
    mock.timers.tick(LIVE_BURST_MS);
    assert.deepEqual(
      Object.fromEntries(Object.entries(page.endpoints).map(([name, calls]) => [name, calls.count])),
      { overlaps: 1, planParts: 1, team: 1, board: 1, identities: 1, policy: 1 },
    );
    assert.equal(page.live().revision, 1, "the seven index messages move the revision once");
    assert.equal(page.live().changed.get("issue-6"), 1, "every issue the burst named is marked changed");
  } finally {
    mock.timers.reset();
  }
});

test("without the burst, ten messages read each endpoint up to ten times", () => {
  // The measure the change replaces: a revision per message, a request per hook per message.
  const page = orgPage();
  for (const message of burstOfTen) page.render(applyMessages(page.live(), [message]), (read) => read());
  assert.deepEqual(
    Object.fromEntries(Object.entries(page.endpoints).map(([name, calls]) => [name, calls.count])),
    { overlaps: 9, planParts: 9, team: 10, board: 10, identities: 10, policy: 1 },
  );
});

test("hooks reading one endpoint in one render share one request", async () => {
  const board = endpoint();
  const shared = singleFlight(board.read);
  const answers = [shared(), shared(), shared()];
  board.answer();
  assert.deepEqual(await Promise.all(answers), [1, 1, 1]);
  assert.equal(board.count, 1);
});

test("a read in flight is not started again; one read follows it for the calls made meanwhile", async () => {
  const board = endpoint();
  const shared = singleFlight(board.read);
  const first = shared();
  await settle();
  const later = Array.from({ length: 5 }, () => shared());
  assert.equal(board.count, 1, "no second request while the first is in flight");
  board.answer();
  assert.equal(await first, 1);
  await settle();
  assert.equal(board.count, 2, "one follow-up request for the five calls");
  board.answer();
  assert.deepEqual(await Promise.all(later), [2, 2, 2, 2, 2], "the calls get the answer read after them");
  await settle();
  assert.equal(board.count, 2);
});

test("a burst with only inbox messages reads only what depends on the inbox", () => {
  const next = applyMessages(FIRST_REVISIONS, [{ kind: "inbox" }, { kind: "inbox" }]);
  assert.deepEqual([next.revision, next.inboxRevision, next.identitiesRevision, next.featuresRevision], [0, 1, 0, 0]);
  assert.equal(next.changed, FIRST_REVISIONS.changed);
});
