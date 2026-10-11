import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  MAX_OPERATION_FILE_BYTES,
  OPERATION_SCHEMA,
  OPERATION_TYPES,
  PAYLOAD_SCHEMAS,
  authorSegment,
  checkSchema,
  formatOpId,
  operationPath,
  parseOperationFile,
  validateOperation,
} from "../src/index.ts";

const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../tests/contracts/issue-ops/vector.json"), "utf8"),
);
const review = vector.operation;

function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...structuredClone(review), [field]: value };
}

function rejects(value: unknown, pathFragment?: string): void {
  const result = validateOperation(value);
  assert.equal(result.ok, false, `expected rejection of ${JSON.stringify(value)}`);
  if (pathFragment !== undefined && !result.ok) {
    assert.ok(
      result.errors.some((error) => error.path.includes(pathFragment)),
      JSON.stringify(result.errors),
    );
  }
}

describe("operation schema", () => {
  test("the PRD example operation validates and maps to issues/33/ops/jun-0007.json", () => {
    assert.deepEqual(validateOperation(review), { ok: true, operation: review });
    assert.equal(operationPath(review), "issues/33/ops/jun-0007.json");
  });

  test("every operation type has a payload schema in the document", () => {
    const defs = OPERATION_SCHEMA.$defs as Record<string, unknown>;
    for (const type of OPERATION_TYPES) {
      assert.ok(PAYLOAD_SCHEMAS[type], type);
      assert.equal(defs[`payload_${type}`], PAYLOAD_SCHEMAS[type]);
    }
  });

  test("the schema is plain JSON", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(OPERATION_SCHEMA)), OPERATION_SCHEMA);
  });

  test("unknown fields are rejected in the envelope, the author and the payload", () => {
    rejects(withField("extra", 1), "/extra");
    rejects(withField("author", { person: "jun", role: "owner" }), "/author");
    rejects(withField("payload", { ...review.payload, extra: true }), "/payload");
    rejects(withField("__proto__", {}), "/__proto__");
  });

  test("every envelope field is required", () => {
    for (const field of Object.keys(review)) {
      const copy = structuredClone(review);
      delete copy[field];
      rejects(copy);
    }
  });

  test("the schema version must be 1", () => {
    rejects(withField("schema_version", 2), "/schema_version");
  });

  test("the payload must match the schema of its type", () => {
    rejects(withField("type", "comment"), "/payload");
    rejects(withField("type", "delete"), "/type");
    rejects(withField("payload", { verdict: "request_changes", commit: "owner-priya@9b2f10" }), "/payload");
    assert.equal(
      validateOperation(withField("payload", { verdict: "approve", commit: "owner-priya@9b2f10" })).ok,
      true,
    );
  });

  test("op_id and author segments outside [a-z0-9.-] are rejected", () => {
    const badOpIds = ["../jun-0007", "jun/../-0007", "Jun-0007", "jun_x-0007", "jun-0007.json", "jun-0007/x", "..-0007"];
    for (const opId of badOpIds) {
      rejects(withField("op_id", opId), "/op_id");
    }
    for (const person of ["../jun", "Jun", "jun/x", "jun.x", "jun_x", "", "-jun", "penguin"]) {
      rejects(withField("author", { person }), "/author");
    }
    for (const handle of ["@jun/../x", "@jun/x/y", "jun/x", "@Jun/x", "@jun.x/y"]) {
      rejects(withField("author", { identity: handle }), "/author");
    }
  });

  test("the op_id must begin with the author's segment and use the canonical sequence spelling", () => {
    rejects(withField("op_id", "sam-0007"), "/op_id");
    for (const opId of ["jun-7", "jun-00007", "jun-0000"]) rejects(withField("op_id", opId), "/op_id");
    assert.equal(validateOperation(withField("op_id", "jun-12345")).ok, true);
  });

  test("an issue ID is a positive integer or a create operation's op_id, never a path", () => {
    for (const issue of [0, -1, 1.5, "33", "..", "../33", "a/b", "jun-0001/..", ""]) {
      rejects(withField("issue", issue), "/issue");
    }
    const offline = withField("issue", "jun-0001");
    assert.equal(validateOperation(offline).ok, true);
    assert.equal(operationPath(offline as { issue: string; op_id: string }), "issues/jun-0001/ops/jun-0007.json");
  });

  test("the path function refuses unsafe segments even without schema validation", () => {
    assert.throws(() => operationPath({ issue: "..", op_id: "jun-0007" }), RangeError);
    assert.throws(() => operationPath({ issue: 33, op_id: "../../x-0001" }), RangeError);
    assert.throws(() => operationPath({ issue: 0, op_id: "jun-0007" }), RangeError);
  });

  test("operation files above the size cap are rejected before parsing", () => {
    const padded = JSON.stringify(review).padEnd(MAX_OPERATION_FILE_BYTES + 1, " ");
    const result = parseOperationFile(new TextEncoder().encode(padded));
    assert.equal(result.ok, false);
    assert.equal(parseOperationFile(new TextEncoder().encode(JSON.stringify(review))).ok, true);
    assert.equal(parseOperationFile(new Uint8Array([0xff, 0xfe])).ok, false);
    assert.equal(parseOperationFile(new TextEncoder().encode("{")).ok, false);
  });

  test("the signature must be 64 bytes of unpadded base64url", () => {
    rejects(withField("signature", "…"), "/signature");
    rejects(withField("signature", `${review.signature}==`), "/signature");
  });
});

describe("author segments and op_ids", () => {
  test("a person, an identity and Penguin each have a segment", () => {
    assert.equal(authorSegment({ person: "jun" }), "jun");
    assert.equal(authorSegment({ identity: "@priya/merge-rules" }), "priya.merge-rules");
    assert.equal(authorSegment({ penguin: true }), "penguin");
  });

  test("formatOpId pads the sequence to four digits", () => {
    assert.equal(formatOpId({ person: "jun" }, 7), "jun-0007");
    assert.equal(formatOpId({ identity: "@priya/merge-rules" }, 12345), "priya.merge-rules-12345");
    assert.throws(() => formatOpId({ person: "jun" }, 0), RangeError);
    assert.throws(() => formatOpId({ person: "../x" }, 1), RangeError);
  });
});

describe("schema checker", () => {
  test("an unsupported keyword throws rather than passing silently", () => {
    assert.throws(() => checkSchema({ format: "email" }, "x"), /unsupported schema keyword/);
  });

  test("string length counts code points", () => {
    assert.equal(checkSchema({ type: "string", maxLength: 1 }, "🐧").length, 0);
  });
});
