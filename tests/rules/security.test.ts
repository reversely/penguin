// PRD 0.5 section 8 (security and permissions): records are signed and a changed record fails its
// signature; a bridge gets write only where its person may write; a viewer sees changed lines only
// when the plan concerns them; a dashboard session can be neither forged nor kept past its expiry.

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalBytes } from "@penguin/issues";
import { parseScopeMap, parseTeams } from "@penguin/scope-map";

import { allowedScope, isPermitted } from "../../apps/worker/src/tokens.ts";
import { decodeSession, encodeSession, sessionKey } from "../../apps/worker/src/session.ts";
import { mayReadPartLines } from "../../services/project-agent/src/dashboard-views.ts";
import { signFeatureRecord, type UnsignedFeatureRecord } from "../../services/project-agent/src/feature-store.ts";

const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

test("a signed record verifies, and any change to it fails verification", async () => {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const record = { schema_version: 1, record_id: "priya-penguin-1", feature: "utc-day-start", type: "promotion", author: { kind: "penguin" }, created_at: "2026-10-12T00:00:00Z", payload: { main: "a".repeat(40) } } as unknown as UnsignedFeatureRecord;
  const signed = await signFeatureRecord(record, keys.privateKey);
  const { signature, ...body } = signed;
  const verify = (value: unknown) => crypto.subtle.verify("Ed25519", keys.publicKey, fromBase64Url(signature), canonicalBytes(value));
  assert.equal(await verify(body), true);
  assert.equal(await verify({ ...body, payload: { main: "b".repeat(40) } }), false);
});

test("a person's bridge never gets write on main, the record repo or another person's feature", () => {
  const bridge = { bridgeId: "br-jun", ownerId: "jun", role: "owner" as const };
  for (const repo of [{ role: "base" as const }, { role: "record" as const }, { role: "feature" as const, featureId: "utc-day-start" }]) {
    assert.equal(isPermitted("write", allowedScope(bridge, repo)), false, repo.role);
    assert.equal(isPermitted("read", allowedScope(bridge, repo)), true, repo.role);
  }
});

const teams = parseTeams({ teams: [{ id: "data", name: "Data", lead: "priya", members: ["priya", "jun"] }] });
const scopeMap = parseScopeMap(
  { scopes: [{ id: "analytics", name: "Analytics", team: "data", dri: "jun", fallback: ["priya"], paths: ["analytics/"], contracts: [], test_command: "true", depends_on: [] }] },
  { teams },
);

test("changed lines are shown to the feature's person, the part's owner, their delegate and the scope's team only", () => {
  const plan = { person: "ines" };
  const part = { owner: "jun", scopes: ["analytics"] };
  const delegates = new Map([["jun", "kofi"]]);
  for (const viewer of ["ines", "jun", "kofi", "priya"]) assert.equal(mayReadPartLines(plan, part, viewer, delegates, scopeMap), true, viewer);
  assert.equal(mayReadPartLines(plan, part, "sam", delegates, scopeMap), false);
});

test("a dashboard session cookie cannot be altered and expires", async () => {
  const key = await sessionKey("client-secret-for-tests");
  const cookie = await encodeSession(key, { owner: "jun", login: "jun", expiresAt: 2_000 });
  assert.equal((await decodeSession(key, cookie, 1_000))?.owner, "jun");
  assert.equal(await decodeSession(key, cookie, 3_000), undefined);
  const tampered = `${cookie.slice(0, -2)}${cookie.endsWith("A") ? "B" : "A"}A`;
  assert.equal(await decodeSession(key, tampered, 1_000), undefined);
});
