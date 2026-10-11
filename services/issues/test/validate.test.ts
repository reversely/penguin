import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import {
  formatOpId,
  MAX_OPERATION_FILE_BYTES,
  parseOpId,
  WEB_WRITER_TAG,
  type Author,
  type Operation,
  type UnsignedOperation,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import {
  generateSigningKeyPair,
  signOperation,
  validate,
  type CharterIdentity,
  type IdentityLookup,
  type IssueState,
  type ValidationContext,
  type Verdict,
} from "../src/index.ts";

const scopeMap = parseScopeMap(
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"), "utf8"),
  ),
);

let service: CryptoKeyPair;
let junBridge: CryptoKeyPair;
let priyaBridge: CryptoKeyPair;
let stranger: CryptoKeyPair;

before(async () => {
  [service, junBridge, priyaBridge, stranger] = await Promise.all([
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    generateSigningKeyPair(),
  ]);
});

const noIdentities: IdentityLookup = { identity: () => undefined, assigningOwner: () => undefined };

function context(
  issue: IssueState | undefined,
  applied: Iterable<string> = [],
  identities: IdentityLookup = noIdentities,
): ValidationContext {
  return {
    identities,
    bridges: [
      { bridgeId: "bridge-priya-laptop", ownerId: "priya", publicKey: priyaBridge.publicKey },
      { bridgeId: "bridge-jun-laptop", ownerId: "jun", publicKey: junBridge.publicKey },
    ],
    serviceKey: service.publicKey,
    issue,
    appliedOpIds: new Set(applied),
    scopeMap,
  };
}

const seqs = new Map<string, number>();

/** A fresh unsigned operation on issue 33 at `base_version`, with the author's next op_id. */
function draft(author: Author, type: Operation["type"], payload: Record<string, unknown>, base = 3): UnsignedOperation {
  const key = JSON.stringify(author);
  const seq = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, seq);
  return {
    schema_version: 1,
    op_id: formatOpId(author, BRIDGE_TAG, seq),
    issue: 33,
    type,
    author,
    base_version: base,
    payload,
  };
}

/** The writer tag the test bridges number under. */
const BRIDGE_TAG = "b3f2";

/**
 * Signs `unsigned` with `key`, numbered under the writer that holds the key: the Worker's tag for
 * the service key, a bridge's tag for any other key.
 */
function sign(unsigned: UnsignedOperation, key: CryptoKey): Promise<Operation> {
  const writer = key === service.privateKey ? WEB_WRITER_TAG : BRIDGE_TAG;
  const seq = parseOpId(unsigned.op_id)?.seq ?? assert.fail(unsigned.op_id);
  return signOperation({ ...unsigned, op_id: formatOpId(unsigned.author, writer, seq) }, key);
}

const comment = (author: Author, base = 3): UnsignedOperation => draft(author, "comment", { body: "Looks right." }, base);
const issue33: IssueState = { version: 3, labels: ["scope:identity-map", "scope:analytics"] };

function expectRejected(verdict: Verdict, reason: string): void {
  assert.equal(verdict.status, "rejected", JSON.stringify(verdict));
  assert.equal(verdict.status === "rejected" && verdict.reason, reason, JSON.stringify(verdict));
}

describe("validate: signature and author", () => {
  test("a valid bridge-signed operation is accepted", async () => {
    const operation = await sign(comment({ person: "jun" }), junBridge.privateKey);
    const verdict = await validate(new TextEncoder().encode(JSON.stringify(operation)), context(issue33));
    assert.equal(verdict.status, "accepted");
    assert.deepEqual(verdict.status === "accepted" && verdict.signer, {
      kind: "bridge",
      bridgeId: "bridge-jun-laptop",
      ownerId: "jun",
    });
  });

  test("changing one byte of the payload yields the bad-signature reason", async () => {
    const operation = await sign(comment({ person: "jun" }), junBridge.privateKey);
    const bytes = new TextEncoder().encode(JSON.stringify(operation));
    const at = new TextDecoder().decode(bytes).indexOf("Looks right.");
    bytes[at] ^= 0x20; // "L" becomes "l"
    expectRejected(await validate(bytes, context(issue33)), "bad_signature");
  });

  test("every single-byte change inside the payload is caught", async () => {
    const operation = await sign(comment({ person: "jun" }), junBridge.privateKey);
    const text = JSON.stringify(operation);
    const body = text.indexOf("Looks right.");
    for (let at = body; at < body + "Looks right.".length; at += 1) {
      const bytes = new TextEncoder().encode(text);
      bytes[at] ^= 0x01;
      const verdict = await validate(bytes, context(issue33));
      assert.equal(verdict.status, "rejected", `byte ${at}`);
    }
  });

  test("a missing or malformed signature yields the bad-signature reason", async () => {
    const { signature: _dropped, ...unsigned } = await sign(comment({ person: "jun" }), junBridge.privateKey);
    expectRejected(await validate(unsigned, context(issue33)), "bad_signature");
    expectRejected(await validate({ ...unsigned, signature: "not-a-signature" }, context(issue33)), "bad_signature");
  });

  test("a signature by an unregistered key yields the bad-signature reason", async () => {
    const operation = await sign(comment({ person: "jun" }), stranger.privateKey);
    expectRejected(await validate(operation, context(issue33)), "bad_signature");
  });

  test("an operation signed by Jun's bridge with author priya is rejected with the author reason", async () => {
    const operation = await sign(comment({ person: "priya" }), junBridge.privateKey);
    const verdict = await validate(operation, context(issue33));
    expectRejected(verdict, "author_not_bound");
    assert.match(verdict.status === "rejected" ? verdict.message : "", /bridge-jun-laptop of jun.*priya/u);
  });

  test("a bridge writes as its owner's identities but not as another owner's or as Penguin", async () => {
    const own = await sign(comment({ identity: "@jun/reports" }), junBridge.privateKey);
    assert.equal((await validate(own, context(issue33))).status, "accepted");
    const other = await sign(comment({ identity: "@priya/merge-rules" }), junBridge.privateKey);
    expectRejected(await validate(other, context(issue33)), "author_not_bound");
    const penguin = await sign(comment({ penguin: true }), junBridge.privateKey);
    expectRejected(await validate(penguin, context(issue33)), "author_not_bound");
  });

  test("only the service key numbers under the writer tag web, and it numbers under no other", async () => {
    const jun = comment({ person: "jun" });
    const asWeb = await signOperation({ ...jun, op_id: formatOpId(jun.author, WEB_WRITER_TAG, 41) }, junBridge.privateKey);
    const fromBridge = await validate(asWeb, context(issue33));
    expectRejected(fromBridge, "author_not_bound");
    assert.match(fromBridge.status === "rejected" ? fromBridge.message : "", /bridge-jun-laptop.*writer tag web/u);

    const asBridge = await signOperation({ ...jun, op_id: formatOpId(jun.author, BRIDGE_TAG, 42) }, service.privateKey);
    const fromService = await validate(asBridge, context(issue33));
    expectRejected(fromService, "author_not_bound");
    assert.match(fromService.status === "rejected" ? fromService.message : "", /service key.*writer tag web/u);
  });

  test("the service key writes as any person, identity or Penguin", async () => {
    for (const author of [{ person: "sam" }, { identity: "@sam/campaigns" }, { penguin: true }] as const) {
      const operation = await sign(comment(author), service.privateKey);
      const verdict = await validate(operation, context(issue33));
      assert.equal(verdict.status, "accepted", JSON.stringify(verdict));
      assert.deepEqual(verdict.status === "accepted" && verdict.signer, { kind: "service" });
    }
  });
});

/** Apply operations in order the way the ProjectAgent does: accepted ones advance the version. */
async function applyInOrder(operations: Operation[], start: IssueState): Promise<{ verdicts: Verdict[]; records: string[] }> {
  let issue = start;
  const applied = new Set<string>();
  const records: string[] = [];
  const verdicts: Verdict[] = [];
  for (const operation of operations) {
    const verdict = await validate(operation, context(issue, applied));
    verdicts.push(verdict);
    if (verdict.status === "duplicate") continue;
    applied.add(operation.op_id);
    records.push(operation.op_id);
    if (verdict.status === "accepted") issue = { ...issue, version: issue.version + 1 };
  }
  return { verdicts, records };
}

describe("validate: base version and duplicates", () => {
  test("a base version lower than the issue's current version is superseded", async () => {
    const operation = await sign(comment({ person: "jun" }, 2), junBridge.privateKey);
    const verdict = await validate(operation, context(issue33));
    expectRejected(verdict, "superseded_version");
    assert.match(verdict.status === "rejected" ? verdict.message : "", /version 2; the issue is at version 3/u);
  });

  test("a base version higher than the issue's current version is rejected", async () => {
    const operation = await sign(comment({ person: "jun" }, 9), junBridge.privateKey);
    expectRejected(await validate(operation, context(issue33)), "unknown_version");
  });

  test("of two assigns on the same base version, the first is accepted and the second is superseded", async () => {
    const first = await sign(
      draft({ person: "jun" }, "assign", { assignee: { identity: "@jun/reports" } }),
      junBridge.privateKey,
    );
    const second = await sign(
      draft({ person: "priya" }, "assign", { assignee: { identity: "@priya/merge-rules" } }),
      priyaBridge.privateKey,
    );
    const { verdicts } = await applyInOrder([first, second], issue33);
    assert.equal(verdicts[0].status, "accepted");
    expectRejected(verdicts[1], "superseded_version");
  });

  test("an operation ID already applied is a duplicate and produces no second record", async () => {
    const operation = await sign(comment({ person: "jun" }), junBridge.privateKey);
    const { verdicts, records } = await applyInOrder([operation, operation], issue33);
    assert.equal(verdicts[0].status, "accepted");
    assert.deepEqual(verdicts[1], { status: "duplicate", opId: operation.op_id });
    assert.deepEqual(records, [operation.op_id]);
  });

  test("a create on an issue the index lacks carries base version 0", async () => {
    const create = { ...draft({ person: "jun" }, "create", { title: "Retention drops" }, 0) };
    const offline = await sign({ ...create, issue: create.op_id }, junBridge.privateKey);
    assert.equal((await validate(offline, context(undefined))).status, "accepted");
  });

  test("an operation stored at another issue's path is rejected", async () => {
    const operation = await sign(comment({ person: "jun" }), junBridge.privateKey);
    const wrong = { ...context(issue33), path: `issues/34/ops/${operation.op_id}.json` };
    expectRejected(await validate(operation, wrong), "wrong_path");
    const right = { ...context(issue33), path: `issues/33/ops/${operation.op_id}.json` };
    assert.equal((await validate(operation, right)).status, "accepted");
  });
});

describe("validate: review rights", () => {
  const review = (author: Author): UnsignedOperation =>
    draft(author, "review", { verdict: "approve", commit: "owner-priya@9b2f10" });

  test("a review from the owner of a labelled scope is accepted", async () => {
    const operation = await sign(review({ person: "priya" }), priyaBridge.privateKey);
    assert.equal((await validate(operation, context(issue33))).status, "accepted");
  });

  test("a review from an owner of no labelled scope is rejected with the rights reason", async () => {
    const operation = await sign(review({ person: "sam" }), service.privateKey);
    const verdict = await validate(operation, context(issue33));
    expectRejected(verdict, "no_right");
    assert.match(verdict.status === "rejected" ? verdict.message : "", /sam owns no scope labelled/u);
  });

  test("a review from an identity is rejected with the rights reason", async () => {
    const operation = await sign(review({ identity: "@priya/merge-rules" }), priyaBridge.privateKey);
    expectRejected(await validate(operation, context(issue33)), "no_right");
  });
});

describe("validate: charter", () => {
  const reports: CharterIdentity = {
    handle: "@jun/reports",
    ownerId: "jun",
    teamOwners: [],
    charterScopes: ["analytics"],
    charterPaths: [],
  };
  const pair: CharterIdentity = {
    handle: "@jun/data-pair",
    ownerId: null,
    teamOwners: ["jun", "priya"],
    charterScopes: ["analytics", "identity-map"],
    charterPaths: [],
  };

  /** A lookup that holds `identities`, each assigned to issue 33 by the owner in `assigners`. */
  function lookup(identities: CharterIdentity[], assigners: Record<string, string> = {}): IdentityLookup {
    return {
      identity: (handle) => identities.find((identity) => identity.handle === handle),
      assigningOwner: (issue, handle) => (issue === "33" ? assigners[handle] : undefined),
    };
  }

  const label = (author: Author, name: string): UnsignedOperation => draft(author, "add_label", { label: name });

  test("an identity naming a scope outside its charter is rejected with a reason naming the charter", async () => {
    const operation = await sign(label({ identity: "@jun/reports" }, "scope:identity-map"), junBridge.privateKey);
    const verdict = await validate(operation, context(issue33, [], lookup([reports])));
    expectRejected(verdict, "outside_charter");
    assert.equal(
      verdict.status === "rejected" && verdict.message,
      "@jun/reports acts outside its charter (scopes: analytics; paths: none): the operation names scope identity-map",
    );
  });

  test("an identity naming a scope inside its charter is accepted", async () => {
    const operation = await sign(label({ identity: "@jun/reports" }, "scope:analytics"), junBridge.privateKey);
    assert.equal((await validate(operation, context(issue33, [], lookup([reports])))).status, "accepted");
  });

  test("an identity's operation that names no scope reads no identity", async () => {
    const throwing: IdentityLookup = {
      identity: () => assert.fail("read an identity"),
      assigningOwner: () => assert.fail("read an assigner"),
    };
    for (const unsigned of [label({ identity: "@jun/reports" }, "huddle"), comment({ identity: "@jun/reports" })]) {
      const operation = await sign(unsigned, junBridge.privateKey);
      assert.equal((await validate(operation, context(issue33, [], throwing))).status, "accepted");
    }
  });

  test("an identity with no stored record cannot name a scope", async () => {
    const operation = await sign(label({ identity: "@jun/ghost" }, "scope:analytics"), junBridge.privateKey);
    const verdict = await validate(operation, context(issue33, [], lookup([reports])));
    expectRejected(verdict, "outside_charter");
    assert.match(verdict.status === "rejected" ? verdict.message : "", /@jun\/ghost has no charter/u);
  });

  test("a person naming any scope is not charter-checked", async () => {
    const operation = await sign(label({ person: "jun" }, "scope:messaging"), junBridge.privateKey);
    assert.equal((await validate(operation, context(issue33))).status, "accepted");
  });

  test("a team identity assigned by Jun is refused an operation in Priya's scope", async () => {
    const operation = await sign(label({ identity: "@jun/data-pair" }, "scope:identity-map"), service.privateKey);
    const verdict = await validate(operation, context(issue33, [], lookup([pair], { "@jun/data-pair": "jun" })));
    expectRejected(verdict, "outside_charter");
    assert.match(
      verdict.status === "rejected" ? verdict.message : "",
      /^@jun\/data-pair acts outside its charter \(scopes: analytics, identity-map; paths: none\).*assigned by jun, it works only within jun's scopes$/u,
    );
    const own = await sign(label({ identity: "@jun/data-pair" }, "scope:analytics"), service.privateKey);
    assert.equal((await validate(own, context(issue33, [], lookup([pair], { "@jun/data-pair": "jun" })))).status, "accepted");
  });

  test("a team identity assigned by Priya works in Priya's scope only", async () => {
    const byPriya = lookup([pair], { "@jun/data-pair": "priya" });
    const priyaScope = await sign(label({ identity: "@jun/data-pair" }, "scope:identity-map"), service.privateKey);
    assert.equal((await validate(priyaScope, context(issue33, [], byPriya))).status, "accepted");
    const junScope = await sign(label({ identity: "@jun/data-pair" }, "scope:analytics"), service.privateKey);
    expectRejected(await validate(junScope, context(issue33, [], byPriya)), "outside_charter");
  });

  test("a team identity unassigned, or assigned by an owner it does not serve, changes no scope", async () => {
    for (const assigners of [{}, { "@jun/data-pair": "sam" }] as Record<string, string>[]) {
      const operation = await sign(label({ identity: "@jun/data-pair" }, "scope:analytics"), service.privateKey);
      expectRejected(await validate(operation, context(issue33, [], lookup([pair], assigners))), "outside_charter");
    }
  });
});

describe("validate: hostile input", () => {
  test("malformed JSON, oversized files, unknown fields and odd values are rejected, never thrown", async () => {
    const signed = await sign(comment({ person: "jun" }), junBridge.privateKey);
    const inputs: unknown[] = [
      new TextEncoder().encode("{not json"),
      new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
      new Uint8Array(MAX_OPERATION_FILE_BYTES + 1).fill(0x20),
      "[".repeat(MAX_OPERATION_FILE_BYTES - 1),
      { ...signed, extra: true },
      { ...signed, payload: { ...signed.payload, extra: true } },
      { ...signed, op_id: "../../evil-web-0001" },
      { ...signed, op_id: "jun-0001" },
      { ...signed, base_version: -1 },
      { ...signed, base_version: 1.5 },
      { ...signed, author: { person: "jun", penguin: true } },
      null,
      undefined,
      42,
      [],
      "",
      Object.create(null),
    ];
    for (const input of inputs) {
      const verdict = await validate(input, context(issue33));
      expectRejected(verdict, "malformed");
    }
  });

  test("the validator imports no file, process or network module", () => {
    for (const dir of ["../src", "../../../packages/policies/src", "../../../packages/protocol/src"]) {
      const folder = join(import.meta.dirname, dir);
      for (const name of readdirSync(folder)) {
        const source = readFileSync(join(folder, name), "utf8");
        assert.doesNotMatch(source, /from "node:|require\(|\bfetch\(|import\(/u, `${dir}/${name}`);
      }
    }
  });
});

test("validation time per operation", async (t) => {
  const operations = await Promise.all(
    Array.from({ length: 200 }, () => sign(comment({ person: "jun" }), junBridge.privateKey)),
  );
  const files = operations.map((operation) => new TextEncoder().encode(JSON.stringify(operation)));
  const started = performance.now();
  for (const file of files) assert.equal((await validate(file, context(issue33))).status, "accepted");
  const perOp = (performance.now() - started) / files.length;
  t.diagnostic(`validation time: ${perOp.toFixed(3)} ms per operation over ${files.length} bridge-signed operations`);
});
