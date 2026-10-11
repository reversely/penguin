// Contract checks over the fixed issue-operation fixtures in issue-ops/. The Worker tests reuse the
// same vector.json and examples/ later, so a change here is a change to the wire format.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, test } from "node:test";

import { importPrivateKey, importPublicKey, signOperation, signingBytes, verifyOperation } from "@penguin/issues";
import {
  OPERATION_TYPES,
  type Operation,
  operationPath,
  parseOperationFile,
  parseOpId,
  WEB_WRITER_TAG,
} from "@penguin/protocol";

const fixtures = join(import.meta.dirname, "issue-ops");
const vector = JSON.parse(readFileSync(join(fixtures, "vector.json"), "utf8"));
const examplesRoot = join(fixtures, "examples");
const exampleFiles = readdirSync(examplesRoot, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".json"))
  .map((name) => join(examplesRoot, name));

describe("issue operation test vector", () => {
  test("the fixed signature verifies in Node", async () => {
    const publicKey = await importPublicKey(vector.public_key_jwk);
    assert.equal(vector.operation.signature, vector.signature);
    assert.equal(await verifyOperation(vector.operation, publicKey), true);
    assert.equal(new TextDecoder().decode(signingBytes(vector.operation)), vector.signing_input);
  });

  test("re-signing with the test private key reproduces the fixed signature", async () => {
    const privateKey = await importPrivateKey(vector.private_key_jwk);
    const { signature: _ignored, ...unsigned } = vector.operation as Operation;
    assert.equal((await signOperation(unsigned, privateKey)).signature, vector.signature);
  });

  test("the vector operation is valid and sits at its PRD path", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(vector.operation));
    assert.equal(parseOperationFile(bytes).ok, true);
    assert.equal(operationPath(vector.operation), "issues/33/ops/jun-b3f2-0007.json");
    assert.equal(vector.path, "issues/33/ops/jun-b3f2-0007.json");
  });
});

describe("issue operation examples", () => {
  test("every operation type has exactly one example", () => {
    const types = exampleFiles.map((file) => JSON.parse(readFileSync(file, "utf8")).type).sort();
    assert.deepEqual(types, [...OPERATION_TYPES].sort());
  });

  for (const file of exampleFiles) {
    const name = relative(examplesRoot, file).split(sep).join("/");
    test(`${name} is valid, signed by the test key and stored at its own path`, async () => {
      const result = parseOperationFile(readFileSync(file));
      assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
      assert.equal(operationPath(result.operation), name);
      // Every op_id carries a writer tag: the Worker's, or a bridge's four hex digits.
      const writer = parseOpId(result.operation.op_id)?.writer ?? "";
      assert.ok(writer === WEB_WRITER_TAG || /^[0-9a-f]{4}$/.test(writer), result.operation.op_id);
      const publicKey = await importPublicKey(vector.public_key_jwk);
      assert.equal(await verifyOperation(result.operation, publicKey), true);
    });
  }
});
