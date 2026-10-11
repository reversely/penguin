import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewThreadAnchor } from "@penguin/protocol";

import { segmentPerson, threadPeople, threadResolveRight, type ThreadRecord } from "../src/thread-rights.ts";

const reviewers = new Map([["jun-web-0007", "jun"]]);
const reviewerOf = (opId: string) => reviewers.get(opId);

/** The thread Penguin opened for Jun's request for changes, which needs Priya. */
const reviewThread: ThreadRecord = {
  anchor: reviewThreadAnchor("jun-web-0007"),
  participants: ["penguin"],
  needsPersonIds: ["priya"],
};

test("a thread's people are those it needs, its participants' people and the reviewer it answers", () => {
  assert.deepEqual(threadPeople(reviewThread, reviewerOf), ["priya", "jun"]);
  const replied = { ...reviewThread, participants: ["penguin", "priya.merge-rules", "lee"] };
  assert.deepEqual(threadPeople(replied, reviewerOf), ["priya", "lee", "jun"]);
  // An anchor that names no review, or a review not on the issue, adds nobody.
  assert.deepEqual(threadPeople({ ...reviewThread, anchor: "ingestion/merge.py:40" }, reviewerOf), ["priya"]);
  assert.deepEqual(threadPeople({ ...reviewThread, anchor: reviewThreadAnchor("sam-web-0001") }, reviewerOf), ["priya"]);
});

test("only a person among the thread's people may resolve it", () => {
  assert.deepEqual(threadResolveRight({ person: "jun" }, reviewThread, reviewerOf), { allowed: true });
  assert.deepEqual(threadResolveRight({ person: "priya" }, reviewThread, reviewerOf), { allowed: true });
  const sam = threadResolveRight({ person: "sam" }, reviewThread, reviewerOf);
  assert.equal(sam.allowed, false);
  assert.match(sam.allowed ? "" : sam.message, /sam takes no part in the thread; .*\(priya, jun\)/u);
  // Priya's agent replies in the thread; Priya decides with Jun when it is done.
  const agent = threadResolveRight({ identity: "@priya/merge-rules" }, reviewThread, reviewerOf);
  assert.equal(agent.allowed, false);
  assert.equal(threadResolveRight({ penguin: true }, reviewThread, reviewerOf).allowed, false);
});

test("an author segment's person is the person or an identity's owner half; Penguin is none", () => {
  assert.equal(segmentPerson("jun"), "jun");
  assert.equal(segmentPerson("priya.merge-rules"), "priya");
  assert.equal(segmentPerson("penguin"), undefined);
});
