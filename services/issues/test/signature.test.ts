import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { Operation, UnsignedOperation } from "@penguin/protocol";

import {
  canonicalJson,
  fromBase64Url,
  generateSigningKeyPair,
  signOperation,
  signingBytes,
  verifyOperation,
} from "../src/index.ts";

const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../tests/contracts/issue-ops/vector.json"), "utf8"),
);

function unsigned(operation: Operation): UnsignedOperation {
  const { signature: _ignored, ...rest } = operation;
  return rest;
}

/** Every JSON leaf in `value`, as a path of keys and indexes. */
function leafPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child, [...prefix, Array.isArray(value) ? Number(key) : key]),
    );
  }
  return [prefix];
}

/** A copy of `operation` with the leaf at `path` changed by one character or one unit. */
function tamper(operation: Operation, path: (string | number)[]): Operation {
  const copy = structuredClone(operation) as unknown as Record<string | number, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  const leaf = parent[last];
  if (typeof leaf === "string") {
    const code = leaf.charCodeAt(leaf.length - 1);
    parent[last] = leaf.slice(0, -1) + String.fromCharCode(code ^ 1);
  } else if (typeof leaf === "number") {
    parent[last] = leaf + 1;
  } else if (typeof leaf === "boolean") {
    parent[last] = !leaf;
  } else {
    throw new Error(`unexpected leaf at ${path.join("/")}`);
  }
  return copy as unknown as Operation;
}

describe("canonical JSON", () => {
  test("sorts keys at every depth and drops whitespace", () => {
    assert.equal(canonicalJson({ b: [{ z: 1, a: "x" }], a: null }), '{"a":null,"b":[{"a":"x","z":1}]}');
  });

  test("sorts keys by UTF-16 code units, as RFC 8785 requires", () => {
    // RFC 8785 section 3.2.3 sorts "€" (euro sign) before "😀" (an emoji) and "\r" first.
    assert.equal(canonicalJson({ "😀": 1, "€": 2, "\r": 3, "1": 4 }), '{"\\r":3,"1":4,"€":2,"😀":1}');
  });

  test("refuses values that JSON cannot hold", () => {
    assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError);
    assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  });

  test("the signing bytes leave out only the signature", () => {
    const text = new TextDecoder().decode(signingBytes(vector.operation));
    assert.equal(text, vector.signing_input);
    assert.ok(!text.includes("signature"));
  });
});

describe("sign and verify", () => {
  test("a signed operation verifies with its key and fails with another", async () => {
    const keys = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const signed = await signOperation(unsigned(vector.operation), keys.privateKey);
    assert.equal(await verifyOperation(signed, keys.publicKey), true);
    assert.equal(await verifyOperation(signed, other.publicKey), false);
  });

  test("field order and file whitespace do not change the signature", async () => {
    const keys = await generateSigningKeyPair();
    const signed = await signOperation(unsigned(vector.operation), keys.privateKey);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()), null, 4));
    assert.equal(await verifyOperation(reordered, keys.publicKey), true);
  });

  test("changing any leaf of any field except signature makes verify return false", async () => {
    const keys = await generateSigningKeyPair();
    const signed = await signOperation(unsigned(vector.operation), keys.privateKey);
    const paths = leafPaths(unsigned(signed));
    assert.ok(paths.length >= 9);
    for (const path of paths) {
      assert.equal(await verifyOperation(tamper(signed, path), keys.publicKey), false, path.join("/"));
    }
  });

  test("adding or removing a field makes verify return false", async () => {
    const keys = await generateSigningKeyPair();
    const signed = await signOperation(unsigned(vector.operation), keys.privateKey);
    assert.equal(await verifyOperation({ ...signed, extra: 1 } as Operation, keys.publicKey), false);
    const { reason: _dropped, ...payload } = signed.payload;
    assert.equal(await verifyOperation({ ...signed, payload }, keys.publicKey), false);
  });

  test("a malformed signature makes verify return false instead of throwing", async () => {
    const keys = await generateSigningKeyPair();
    for (const signature of ["", "…", "AAAA", `${vector.signature}A`, vector.signature.slice(0, -1) + "h"]) {
      assert.equal(await verifyOperation({ ...vector.operation, signature }, keys.publicKey), false, signature);
    }
  });

  test("base64url decoding accepts only the canonical spelling", () => {
    assert.deepEqual(fromBase64Url("AQI"), new Uint8Array([1, 2]));
    assert.equal(fromBase64Url("AQJ"), null);
    assert.equal(fromBase64Url("AQI="), null);
    assert.equal(fromBase64Url("A"), null);
  });

  test("time to sign and verify one thousand operations", async (t) => {
    const keys = await generateSigningKeyPair();
    const base = unsigned(vector.operation);
    const operations = Array.from({ length: 1000 }, (_, i) => ({ ...base, base_version: i }));
    const start = performance.now();
    const signed = await Promise.all(operations.map((operation) => signOperation(operation, keys.privateKey)));
    const signedAt = performance.now();
    const results = await Promise.all(signed.map((operation) => verifyOperation(operation, keys.publicKey)));
    const verifiedAt = performance.now();
    assert.ok(results.every(Boolean));
    t.diagnostic(
      `sign 1000: ${(signedAt - start).toFixed(1)} ms; verify 1000: ${(verifiedAt - signedAt).toFixed(1)} ms`,
    );
  });
});
