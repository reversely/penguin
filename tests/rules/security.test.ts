// PRD 0.5 section 8 (security and permissions): records are signed and a changed record fails its
// signature; a bridge gets write only where its person may write; a viewer sees changed lines only
// when the plan concerns them; a dashboard session can be neither forged nor kept past its expiry; the
// review policy changes only by a team lead's signed record (#175).

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { canonicalBytes } from "@penguin/issues";
import { APPROVAL_TYPES, policyInForce, policyRoute, PRESET_POLICIES, REVIEW_PRESETS, type ReviewPolicy } from "@penguin/protocol";
import { parseScopeMap, parseTeams } from "@penguin/scope-map";

import { allowedScope, isPermitted } from "../../apps/worker/src/tokens.ts";
import { decodeSession, encodeSession, sessionKey } from "../../apps/worker/src/session.ts";
import { mayReadPartLines } from "../../services/project-agent/src/dashboard-views.ts";
import { FeatureStore, signFeatureRecord, verifyFeatureRecord, type UnsignedFeatureRecord } from "../../services/project-agent/src/feature-store.ts";
import type { SqlDatabase } from "../../services/project-agent/src/issue-index.ts";
import { changeReviewPolicy, PROJECT_RECORDS, readReviewPolicy } from "../../services/project-agent/src/review-policy.ts";

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

// Issue #175: the sandbox's review policy. Only a team lead changes it, never while admin mode locks it;
// a record whose signature fails, or that names another person than its author, is refused; and no
// policy lets Penguin approve a part whose tests have not passed.

/** One in-memory SQLite database with the ProjectAgent's SQL surface. */
function memorySql(): SqlDatabase {
  const db = new DatabaseSync(":memory:");
  return { exec: (query, ...bindings) => db.prepare(query).all(...(bindings as never[])) as Record<string, string | number | null>[], transaction: (body) => body() };
}

async function policyDeps(adminMode = false) {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const features = new FeatureStore(memorySql());
  const current = () => readReviewPolicy(features.records(PROJECT_RECORDS), (record) => verifyFeatureRecord(record, keys.publicKey));
  return { keys, features, current, deps: { features, scopeMap: async () => scopeMap, sign: (draft: UnsignedFeatureRecord) => signFeatureRecord(draft, keys.privateKey), current, adminMode } };
}

test("only a team lead changes the review policy; admin mode refuses every change and stays Production", async () => {
  const { deps, current } = await policyDeps();
  const localDevelopment = PRESET_POLICIES.local_development;
  assert.equal((await changeReviewPolicy(deps, "jun", localDevelopment)).status, "rejected", "jun is a member, not the lead");
  assert.equal((await current()).policy.preset, "central_development");
  assert.equal((await changeReviewPolicy(deps, "priya", { ...localDevelopment, changed_by: "jun" })).status, "rejected", "a field beyond preset and rows is refused");
  assert.equal((await changeReviewPolicy(deps, "priya", localDevelopment)).status, "ok");
  assert.equal((await current()).policy.preset, "local_development");
  const locked = await changeReviewPolicy({ ...deps, adminMode: true }, "priya", PRESET_POLICIES.central_development);
  assert.deepEqual([locked.status, locked.status === "rejected" ? locked.reason : null], ["rejected", "locked"]);
  assert.deepEqual(policyInForce((await current()).policy, true), { policy: PRESET_POLICIES.production, locked: true });
});

test("a forged review_policy_changed record, or one naming someone other than its author, is refused", async () => {
  const { keys, features, current } = await policyDeps();
  const forger = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const draft = (payload: Record<string, unknown>, person: string) => features.draftRecord(PROJECT_RECORDS, "review_policy_changed", { person }, payload);
  features.addRecord(await signFeatureRecord(draft({ old: PRESET_POLICIES.central_development, new: PRESET_POLICIES.local_development, changed_by: "priya" }, "priya"), forger.privateKey));
  assert.equal((await current()).policy.preset, "central_development", "a record signed with another key is refused");
  features.addRecord(await signFeatureRecord(draft({ old: PRESET_POLICIES.central_development, new: PRESET_POLICIES.local_development, changed_by: "jun" }, "priya"), keys.privateKey));
  assert.equal((await current()).policy.preset, "central_development", "a record naming another person than its author is refused");
});

test("no review policy lets Penguin approve a part whose tests have not passed", () => {
  const failing = { inPerson: true, reasons: [{ kind: "tests", scope: "analytics", status: "failed", breaks: 1 }] } as const;
  for (const preset of REVIEW_PRESETS) {
    for (let bits = 0; bits < 2 ** APPROVAL_TYPES.length; bits += 1) {
      const rows = Object.fromEntries(APPROVAL_TYPES.map((type, index) => [type, bits & (1 << index) ? "penguin" : "person"])) as ReviewPolicy["rows"];
      assert.notEqual(policyRoute(policyInForce({ preset, rows }, false), failing).decider, "penguin", `${preset} ${bits}`);
    }
  }
});

// Issue #177: the presets took the release pipeline's stage names. A policy #175 signed under an old
// name, with its overlapping_starts row, reads as the new name.
test("a review_policy_changed record signed under an old preset name reads as its new name", async () => {
  const { keys, features, current } = await policyDeps();
  const rows = (decider: string) => ({ ...Object.fromEntries(APPROVAL_TYPES.map((type) => [type, decider])), overlapping_starts: decider });
  for (const [old, renamed, decider] of [["throwaway", "local_development", "penguin"], ["dev", "central_development", "person"], ["production", "production", "person"]] as const) {
    const draft = features.draftRecord(PROJECT_RECORDS, "review_policy_changed", { person: "priya" }, { old: null, new: { preset: old, rows: rows(decider) }, changed_by: "priya" });
    features.addRecord(await signFeatureRecord(draft, keys.privateKey));
    assert.deepEqual((await current()).policy, PRESET_POLICIES[renamed], old);
  }
});
