import assert from "node:assert/strict";
import { test } from "node:test";

import { McpTokenStore } from "../src/mcp-tokens.ts";
import { sqlite } from "./issues-repo.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");

test("an issued MCP token authenticates its owner until it is revoked", async () => {
  const store = new McpTokenStore(sqlite().sql, () => NOW);
  const issued = await store.issue("jun");
  assert.equal(issued.ownerId, "jun");
  assert.equal(issued.issuedAt, "2026-10-10T12:00:00.000Z");
  assert.match(issued.token, /^pgm_[A-Za-z0-9_-]{43}$/);

  assert.deepEqual(await store.authenticate(issued.token), { tokenId: issued.tokenId, ownerId: "jun" });
  assert.equal(store.revoke(issued.tokenId), true);
  assert.equal(await store.authenticate(issued.token), undefined);
  assert.equal(store.revoke(issued.tokenId), false);
  assert.equal(store.revoke("mt_unknown"), false);
});

test("an owner's tokens are independent, and another owner's token names that owner", async () => {
  const store = new McpTokenStore(sqlite().sql, () => NOW);
  const [first, second, priya] = [await store.issue("jun"), await store.issue("jun"), await store.issue("priya")];
  assert.notEqual(first.token, second.token);
  store.revoke(first.tokenId);
  assert.equal((await store.authenticate(second.token))?.ownerId, "jun");
  assert.equal((await store.authenticate(priya.token))?.ownerId, "priya");
});

test("a wrong, truncated or unprefixed token authenticates no one", async () => {
  const store = new McpTokenStore(sqlite().sql, () => NOW);
  const { token } = await store.issue("jun");
  for (const wrong of ["", "pgm_", token.slice(0, -1), `${token}x`, token.slice(4), `pgb_${token.slice(4)}`]) {
    assert.equal(await store.authenticate(wrong), undefined, wrong);
  }
});

test("the store keeps only the token's SHA-256 hash", async () => {
  const { db, sql } = sqlite();
  const store = new McpTokenStore(sql, () => NOW);
  const { token } = await store.issue("jun");
  const rows = db.prepare(`SELECT * FROM McpToken`).all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  const stored = JSON.stringify(rows);
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(token.slice(4)), false);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  assert.equal(rows[0]?.["token_hash"], Buffer.from(digest).toString("hex"));
});

test("a task token names its task, lasts until its claim ends and is revoked with the task", async () => {
  const { db, sql } = sqlite();
  let now = NOW;
  const store = new McpTokenStore(sql, () => now);
  const owner = await store.issue("jun");
  const first = await store.issueTask("jun", 7, NOW + 60_000);
  assert.match(first.token, /^pgt_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.expiresAt, new Date(NOW + 60_000).toISOString());
  assert.deepEqual((await store.authenticate(first.token))?.task, { taskId: 7 });
  // An owner token names no task, and the task token's hash is all the store keeps.
  assert.equal((await store.authenticate(owner.token))?.task, undefined);
  assert.equal(JSON.stringify(db.prepare(`SELECT * FROM McpTaskToken`).all()).includes(first.token.slice(4)), false);
  // A second claim of the task replaces its token.
  const second = await store.issueTask("jun", 7, NOW + 60_000);
  assert.equal(await store.authenticate(first.token), undefined);
  assert.equal((await store.authenticate(second.token))?.ownerId, "jun");
  assert.equal(store.revokeTask(7), 1);
  assert.equal(await store.authenticate(second.token), undefined);
  const third = await store.issueTask("jun", 8, NOW + 60_000);
  now = NOW + 60_000;
  assert.equal(await store.authenticate(third.token), undefined);
});
