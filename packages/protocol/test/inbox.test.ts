import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkInbox, IDENTITY_HANDLE_SCHEMA, OPERATION_SCHEMA, type InboxEntry } from "../src/index.ts";

const entry: InboxEntry = {
  issueId: "40",
  reason: "assigned",
  read: false,
  raisedAt: "2026-10-10T12:00:00.000Z",
  title: "Board filter",
  state: "open",
  assigneeHandles: ["@jun/reports", "@sam/campaigns"],
};

const inboxWith = (fields: Record<string, unknown>) => ({ items: [{ ...entry, ...fields }] });

describe("inbox schema", () => {
  test("accepts an entry with assignee handles and one with none", () => {
    assert.deepEqual(checkInbox({ items: [entry] }), []);
    assert.deepEqual(checkInbox(inboxWith({ assigneeHandles: [] })), []);
    assert.deepEqual(checkInbox({ items: [] }), []);
  });

  test("checks handles with the operation schema's identity handle schema", () => {
    const defs = OPERATION_SCHEMA["$defs"] as Record<string, unknown>;
    assert.equal(defs["identity"], IDENTITY_HANDLE_SCHEMA);
  });

  test("rejects a malformed handle, markup included", () => {
    const malformed = ["<b>@jun/reports</b>", "@jun/<script>", "jun/reports", "@Jun/reports", "@jun/", "", 7, null];
    for (const handle of malformed) {
      const errors = checkInbox(inboxWith({ assigneeHandles: [handle] }));
      assert.ok(
        errors.some((error) => error.path === "/items/0/assigneeHandles/0"),
        `${JSON.stringify(handle)}: ${JSON.stringify(errors)}`,
      );
    }
    assert.notDeepEqual(checkInbox(inboxWith({ assigneeHandles: [`@jun/${"a".repeat(80)}`] })), []);
    assert.notDeepEqual(checkInbox(inboxWith({ assigneeHandles: ["@jun/reports", "@jun/reports"] })), []);
  });

  test("rejects an entry without its handles, or with a field it does not define", () => {
    const { assigneeHandles: _, ...withoutHandles } = entry;
    assert.notDeepEqual(checkInbox({ items: [withoutHandles] }), []);
    assert.notDeepEqual(checkInbox(inboxWith({ assigneeHandles: "@jun/reports" })), []);
    assert.notDeepEqual(checkInbox(inboxWith({ personId: "jun" })), []);
    assert.notDeepEqual(checkInbox(inboxWith({ state: "toString" })), []);
  });

  test("passes markup in a title through as text", () => {
    assert.deepEqual(checkInbox(inboxWith({ title: '<img src=x onerror="alert(1)">' })), []);
  });
});
