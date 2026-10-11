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
  bridgeWriterTag,
  checkSchema,
  formatOpId,
  operationPath,
  parseOperationFile,
  parseOpId,
  validateOperation,
  WEB_WRITER_TAG,
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
  test("the PRD example operation validates and maps to issues/33/ops/jun-b3f2-0007.json", () => {
    assert.deepEqual(validateOperation(review), { ok: true, operation: review });
    assert.equal(operationPath(review), "issues/33/ops/jun-b3f2-0007.json");
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

  test("a close may name its resolution; no other state change may", () => {
    const stateChange = (payload: Record<string, unknown>) => ({ ...withField("type", "change_state"), payload });
    for (const resolution of ["approved", "cancelled"]) {
      assert.equal(validateOperation(stateChange({ state: "closed", reason: "Done.", resolution })).ok, true);
    }
    rejects(stateChange({ state: "closed", reason: "Done.", resolution: "merged" }), "/payload/resolution");
    rejects(stateChange({ state: "fixing", reason: "Back to work.", resolution: "cancelled" }), "/payload/state");
    const link = { ...withField("type", "link_commit"), payload: { commit: "huddle-031@9b2f10", kind: "approved" } };
    assert.equal(validateOperation(link).ok, true);
  });

  test("op_id and author segments outside [a-z0-9.-] are rejected", () => {
    const badOpIds = [
      "../jun-web-0007",
      "jun/../-web-0007",
      "Jun-web-0007",
      "jun_x-web-0007",
      "jun-web-0007.json",
      "jun-web-0007/x",
      "..-web-0007",
      "jun-WEB-0007",
      "jun-b3.f2-0007",
      "jun-b3_f2-0007",
    ];
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

  test("the op_id is the author's segment, a writer tag and the canonical sequence spelling", () => {
    rejects(withField("op_id", "sam-b3f2-0007"), "/op_id");
    for (const opId of ["jun-web-7", "jun-web-00007", "jun-web-0000"]) rejects(withField("op_id", opId), "/op_id");
    assert.equal(validateOperation(withField("op_id", "jun-web-12345")).ok, true);
    assert.equal(validateOperation(withField("op_id", "jun-b3f2-0007")).ok, true);
  });

  test("the op_id needs a writer tag: the old <author>-<seq> form is rejected", () => {
    rejects(withField("op_id", "jun-0007"), "/op_id");
    rejects(withField("op_id", "jun--0007"), "/op_id");
    rejects(withField("op_id", "jun-abcdefghijklmnopq-0007"), "/op_id");
  });

  test("an author segment with hyphens still splits from the right", () => {
    const author = { person: "jun-two" };
    assert.equal(validateOperation({ ...withField("author", author), op_id: "jun-two-web-0001" }).ok, true);
    // "jun-web-0001" belongs to author jun and "jun-two-web-0001" to author jun-two, never the other way.
    rejects({ ...withField("author", author), op_id: "jun-web-0001" }, "/op_id");
    rejects(withField("op_id", "jun-two-web-0001"), "/op_id");
  });

  test("an issue ID is a positive integer or a create operation's op_id, never a path", () => {
    for (const issue of [0, -1, 1.5, "33", "..", "../33", "a/b", "jun-b3f2-0001/..", "jun-0001", ""]) {
      rejects(withField("issue", issue), "/issue");
    }
    const offline = withField("issue", "jun-b3f2-0001");
    assert.equal(validateOperation(offline).ok, true);
    assert.equal(
      operationPath(offline as { issue: string; op_id: string }),
      "issues/jun-b3f2-0001/ops/jun-b3f2-0007.json",
    );
  });

  test("the path function refuses unsafe segments even without schema validation", () => {
    assert.throws(() => operationPath({ issue: "..", op_id: "jun-web-0007" }), RangeError);
    assert.throws(() => operationPath({ issue: 33, op_id: "../../x-web-0001" }), RangeError);
    assert.throws(() => operationPath({ issue: 33, op_id: "jun-0007" }), RangeError);
    assert.throws(() => operationPath({ issue: 0, op_id: "jun-web-0007" }), RangeError);
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

  test("formatOpId joins the author segment, the writer tag and the sequence padded to four digits", () => {
    assert.equal(formatOpId({ person: "jun" }, WEB_WRITER_TAG, 7), "jun-web-0007");
    assert.equal(formatOpId({ person: "jun" }, "b3f2", 5), "jun-b3f2-0005");
    assert.equal(formatOpId({ identity: "@priya/merge-rules" }, "web", 12345), "priya.merge-rules-web-12345");
    assert.throws(() => formatOpId({ person: "jun" }, "web", 0), RangeError);
    assert.throws(() => formatOpId({ person: "../x" }, "web", 1), RangeError);
    for (const writer of ["", "b3-f2", "B3F2", "b3.f2", "a".repeat(17)]) {
      assert.throws(() => formatOpId({ person: "jun" }, writer, 1), RangeError, writer);
    }
  });

  test("parseOpId splits an op_id from the right", () => {
    assert.deepEqual(parseOpId("jun-b3f2-0005"), { segment: "jun", writer: "b3f2", seq: 5 });
    assert.deepEqual(parseOpId("jun-two-web-12345"), { segment: "jun-two", writer: "web", seq: 12345 });
    assert.deepEqual(parseOpId("priya.merge-rules-web-0001"), { segment: "priya.merge-rules", writer: "web", seq: 1 });
    for (const opId of ["jun-0005", "jun-web-5", "../jun-web-0005", ""]) assert.equal(parseOpId(opId), undefined, opId);
  });

  test("a bridge's writer tag is four hex digits of its bridge ID's hash and never the Worker's", async () => {
    const tag = await bridgeWriterTag("br_AbCdEfGhIjKl");
    assert.match(tag, /^[0-9a-f]{4}$/);
    assert.equal(await bridgeWriterTag("br_AbCdEfGhIjKl"), tag, "the same bridge ID gives the same tag");
    assert.notEqual(await bridgeWriterTag("br_AbCdEfGhIjKm"), tag);
    assert.notEqual(tag, WEB_WRITER_TAG);
    assert.equal(formatOpId({ person: "jun" }, tag, 5), `jun-${tag}-0005`);
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
