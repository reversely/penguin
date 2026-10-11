import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair } from "@penguin/issues";

import { BridgeRegistry } from "../src/bridge-registry.ts";
import type { SqlDatabase } from "../src/issue-index.ts";

function sqlite(): { db: DatabaseSync; sql: SqlDatabase } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = {
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as Record<string, string | number | null>[],
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sql };
}

async function publicJwk(): Promise<JsonWebKey> {
  const pair = await generateSigningKeyPair();
  return crypto.subtle.exportKey("jwk", pair.publicKey);
}

function registry(clock = { now: 1_800_000_000_000 }) {
  const { db, sql } = sqlite();
  return { db, clock, bridges: new BridgeRegistry(sql, () => clock.now) };
}

test("a registration code registers one bridge for its owner and role", async () => {
  const { bridges } = registry();
  const code = await bridges.issueCode("jun", "owner", 900);
  assert.equal(code.ownerId, "jun");
  assert.match(code.code, /^pgr_[A-Za-z0-9_-]{43}$/);

  const outcome = await bridges.register(code.code, await publicJwk());
  assert.equal(outcome.status, "registered");
  if (outcome.status !== "registered") return;
  assert.equal(outcome.bridge.ownerId, "jun");
  assert.equal(outcome.bridge.role, "owner");
  assert.match(outcome.bridge.bridgeToken, /^pgb_[A-Za-z0-9_-]{43}$/);

  const identity = await bridges.authenticate(outcome.bridge.bridgeToken);
  assert.deepEqual(identity, { bridgeId: outcome.bridge.bridgeId, ownerId: "jun", role: "owner" });

  // The code works once.
  assert.deepEqual(await bridges.register(code.code, await publicJwk()), { status: "invalid_code" });
});

test("an expired or unknown code registers nothing", async () => {
  const { bridges, clock } = registry();
  const code = await bridges.issueCode("jun", "owner", 900);
  clock.now += 900_000;
  assert.deepEqual(await bridges.register(code.code, await publicJwk()), { status: "invalid_code" });
  assert.deepEqual(await bridges.register("pgr_unknown", await publicJwk()), { status: "invalid_code" });
});

test("a refused key leaves the code unspent", async () => {
  const { bridges } = registry();
  const code = await bridges.issueCode("priya", "runner", 900);
  const pair = await generateSigningKeyPair();
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  for (const key of [undefined, { kty: "RSA" }, privateJwk, { kty: "OKP", crv: "Ed25519", x: "short" }]) {
    const outcome = await bridges.register(code.code, key);
    assert.equal(outcome.status, "invalid_key", JSON.stringify(key));
  }
  const outcome = await bridges.register(code.code, await publicJwk());
  assert.equal(outcome.status, "registered");
  if (outcome.status === "registered") assert.equal(outcome.bridge.role, "runner");
});

test("codes and bridge tokens are stored only as hashes", async () => {
  const { bridges, db } = registry();
  const code = await bridges.issueCode("jun", "owner", 900);
  const outcome = await bridges.register(code.code, await publicJwk());
  assert.equal(outcome.status, "registered");
  if (outcome.status !== "registered") return;

  const stored = JSON.stringify([
    db.prepare("SELECT * FROM BridgeRegistrationCode").all(),
    db.prepare("SELECT * FROM Bridge").all(),
  ]);
  assert.ok(!stored.includes(code.code.slice(4)), "the code's plaintext is stored");
  assert.ok(!stored.includes(outcome.bridge.bridgeToken.slice(4)), "the bridge token's plaintext is stored");
  assert.match(stored, /"token_hash":"[0-9a-f]{64}"/);
});

test("a revoked bridge no longer authenticates and its key leaves the key list", async () => {
  const { bridges } = registry();
  const registered = [];
  for (const owner of ["jun", "priya"]) {
    const outcome = await bridges.register((await bridges.issueCode(owner, "owner", 900)).code, await publicJwk());
    assert.equal(outcome.status, "registered");
    if (outcome.status === "registered") registered.push(outcome.bridge);
  }
  const [jun, priya] = registered;
  assert.ok(jun && priya);
  assert.deepEqual((await bridges.bridgeKeys()).map((key) => key.ownerId).sort(), ["jun", "priya"]);

  assert.equal(bridges.revoke(jun.bridgeId), true);
  assert.equal(bridges.revoke(jun.bridgeId), false);
  assert.equal(await bridges.authenticate(jun.bridgeToken), undefined);
  assert.ok(await bridges.authenticate(priya.bridgeToken));
  assert.deepEqual((await bridges.bridgeKeys()).map((key) => key.bridgeId), [priya.bridgeId]);
  assert.equal(await bridges.authenticate("pgb_not-a-registered-token"), undefined);
  assert.equal(await bridges.authenticate(""), undefined);
});
