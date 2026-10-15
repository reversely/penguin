// A session stays online while its own call runs (#216): the sweep passes over a session with a call
// in flight, and the call's answer refreshes its heartbeat, so a propose_plan that runs past the
// offline window leaves the session running and its next call is accepted. Only a call by the
// session's own owner holds it.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseScopeMap } from "@penguin/scope-map";

import { IdentityStore } from "../../services/project-agent/src/identity-store.ts";
import { IssueIndex, type SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { SESSION_OFFLINE_AFTER_MS, SessionStore } from "../../services/project-agent/src/session-store.ts";

/** Priya's @priya/ledger session, on a clock the test moves. */
function priyaSession() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[], transaction: (body) => body() };
  const scopeMap = parseScopeMap({ scopes: [{ id: "ledger", name: "Ledger", owner: "priya", paths: ["ledger/"], contracts: [], test_command: "true", depends_on: [] }] });
  const identities = new IdentityStore(sql);
  assert.equal(identities.create("priya", { handle: "@priya/ledger", name: "priya/ledger", job: "builds", charterScopes: ["ledger"], autoAccept: true }, scopeMap).status, "ok");
  new IssueIndex(sql);
  const clock = { now: 0 };
  const sessions = new SessionStore(sql, identities, { now: () => clock.now });
  const registered = sessions.register("priya", { identity: "@priya/ledger", vendor: "claude-code", worktreeId: "wt_ledger", branch: "feature-ledger" });
  if (registered.status !== "ok") throw new Error(registered.message);
  return { sessions, clock, id: registered.session.id };
}

test("a session whose call runs 120 s stays online and its next call is accepted", async () => {
  const { sessions, clock, id } = priyaSession();
  let answered = 0;
  await sessions.during(
    "priya",
    id,
    async () => {
      clock.now += 120_000;
      sessions.sweep();
      assert.equal(sessions.get(id)?.status, "running", "the sweep passes over a session with a call in flight");
    },
    () => answered++,
  );
  assert.equal(answered, 1);
  assert.equal(sessions.get(id)?.lastSeen, new Date(120_000).toISOString(), "the answer refreshes the heartbeat");
  clock.now += SESSION_OFFLINE_AFTER_MS - 1;
  assert.equal(sessions.heartbeat("priya", id).status, "ok", "the next call is accepted");
});

test("another owner's call on the session does not hold it online", async () => {
  const { sessions, clock, id } = priyaSession();
  await sessions.during("jun", id, async () => {
    clock.now += 120_000;
    assert.equal(sessions.get(id)?.status, "offline");
  });
  assert.equal(sessions.heartbeat("priya", id).status, "rejected");
});
