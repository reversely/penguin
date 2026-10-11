import assert from "node:assert/strict";
import { test } from "node:test";

import type { InboxEntry } from "@penguin/protocol";

import { CLOSED_WINDOW, INBOX_GROUPS, groupInbox, itemKey, markedRead, newest, REASON_TAG, unreadCount } from "../src/inbox-view.ts";

function entry(issueId: string, reason: InboxEntry["reason"], read = false): InboxEntry {
  const raisedAt = "2026-10-10T12:00:00.000Z";
  return { issueId, reason, read, raisedAt, title: `Issue ${issueId}`, state: "open", assigneeHandles: [] };
}

const keys = (items: readonly InboxEntry[]) => items.map(itemKey);

test("the inbox has the five lists in the PRD's order, under noun headings", () => {
  assert.deepEqual(
    INBOX_GROUPS.map((group) => group.label),
    ["Review requests", "Assignments", "Mentions", "Threads", "Closed issues"],
  );
});

test("each item goes to its reason's list, keeping the inbox's newest-first order", () => {
  const items = [
    entry("42", "closed"),
    entry("43", "review_requested"),
    entry("41", "start_session"),
    entry("40", "mentioned"),
    entry("41", "assigned", true),
    entry("40", "assigned"),
  ];
  const groups = groupInbox(items);
  assert.deepEqual(keys(groups.assigned), ["start_session:41", "assigned:41", "assigned:40"]);
  assert.deepEqual(keys(groups.mentioned), ["mentioned:40"]);
  assert.deepEqual(keys(groups.closed), ["closed:42"]);
  assert.deepEqual(keys(groups.review), ["review_requested:43"]);
  // No reason fills the threads list yet; it shows with its heading and no items.
  assert.deepEqual(groups.threads, []);
});

test("an item with an unknown reason is left out of every list", () => {
  const unknown = { ...entry("40", "assigned"), reason: "toString" } as unknown as InboxEntry;
  const groups = groupInbox([unknown, entry("41", "mentioned")]);
  assert.deepEqual(Object.values(groups).flat().map(itemKey), ["mentioned:41"]);
});

test("only a session request carries a tag of its reason", () => {
  assert.equal(REASON_TAG.start_session, "Start a session");
  for (const reason of ["assigned", "mentioned", "closed"] as const) assert.equal(REASON_TAG[reason], undefined);
});

test("the unread count counts unread items; marking one read changes only that item", () => {
  const items = [entry("40", "assigned"), entry("40", "closed"), entry("41", "mentioned", true)];
  assert.equal(unreadCount(items), 2);
  const after = markedRead(items, itemKey(entry("40", "closed")));
  assert.equal(unreadCount(after), 1);
  assert.deepEqual(
    after.map((item) => [itemKey(item), item.read]),
    [
      ["assigned:40", false],
      ["closed:40", true],
      ["mentioned:41", true],
    ],
  );
  assert.equal(items[1]?.read, false, "the list it came from is unchanged");
});

test("a list shows its newest items up to the window, or every item on request", () => {
  const closed = Array.from({ length: CLOSED_WINDOW + 2 }, (_, n) => entry(String(50 - n), "closed"));
  assert.equal(CLOSED_WINDOW, 10);
  assert.deepEqual(keys(newest(closed, CLOSED_WINDOW, false)), keys(closed.slice(0, CLOSED_WINDOW)));
  assert.deepEqual(keys(newest(closed, CLOSED_WINDOW, true)), keys(closed));
  assert.deepEqual(keys(newest(closed.slice(0, 3), CLOSED_WINDOW, false)), keys(closed.slice(0, 3)));
});
