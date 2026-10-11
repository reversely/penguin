import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { generateSigningKeyPair, signOperation } from "@penguin/issues";
import {
  formatOpId,
  operationPath,
  WEB_WRITER_TAG,
  type Author,
  type IssueId,
  type Operation,
} from "@penguin/protocol";
import { parseScopeMap } from "@penguin/scope-map";

import {
  IDENTITY_LIMITS,
  IdentityStore,
  type Identity,
  type IdentityInput,
  type IdentityOutcome,
} from "../src/identity-store.ts";
import { IssueIndex, type ApplyOutcome, type OperationKeys, type SqlDatabase } from "../src/issue-index.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";

const fixture = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin");
const scopeMap = parseScopeMap(JSON.parse(readFileSync(join(fixture, "scopes.json"), "utf8")));

/** The seed identities in the fixture's documented format. */
interface SeedIdentity {
  readonly handle: string;
  readonly owner: string;
  readonly vendor: string;
  readonly job: string;
  readonly charter_scopes: string[];
}
const seeds = (JSON.parse(readFileSync(join(fixture, "identities.json"), "utf8")) as { identities: SeedIdentity[] })
  .identities;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

let service: ServiceKey;
let junBridge: CryptoKeyPair;
let priyaBridge: CryptoKeyPair;
/** The keys without identities; each test supplies its own identity store. */
let keys: Omit<OperationKeys, "identities">;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  [junBridge, priyaBridge] = await Promise.all([generateSigningKeyPair(), generateSigningKeyPair()]);
  keys = {
    bridges: [
      { bridgeId: "bridge-jun", ownerId: "jun", publicKey: junBridge.publicKey },
      { bridgeId: "bridge-priya", ownerId: "priya", publicKey: priyaBridge.publicKey },
    ],
    serviceKey: service.publicKey,
    scopeMap,
  };
});

function sqlite(): { db: DatabaseSync; sql: SqlDatabase; store: IdentityStore } {
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
  let next = 0;
  return { db, sql, store: new IdentityStore(sql, () => `identity-${++next}`) };
}

function ok(outcome: IdentityOutcome): Identity {
  assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  return (outcome as { identity: Identity }).identity;
}

function rejected(outcome: IdentityOutcome, reason: string, message?: RegExp): void {
  assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
  if (outcome.status !== "rejected") return;
  assert.equal(outcome.reason, reason, outcome.message);
  if (message !== undefined) assert.match(outcome.message, message);
}

const reportsInput: IdentityInput = {
  handle: "@jun/reports",
  name: "Reports",
  avatar: { mediaType: "image/png", data: PNG },
  job: "Build a retention dashboard keyed on user_id",
  charterScopes: ["analytics"],
  charterPaths: ["docs/metrics/"],
  charterRules: ["Never change a metric's definition without a cutover marker."],
  autoAccept: true,
};

describe("identities: create and read", () => {
  test("an owner creates an identity with every field and reads it back", () => {
    const { store } = sqlite();
    const created = ok(store.create("jun", reportsInput, scopeMap));
    const expected: Identity = {
      id: "identity-1",
      handle: "@jun/reports",
      ownerId: "jun",
      teamOwners: [],
      name: "Reports",
      avatar: { mediaType: "image/png", data: PNG },
      job: "Build a retention dashboard keyed on user_id",
      charterScopes: ["analytics"],
      charterPaths: ["docs/metrics"],
      charterRules: ["Never change a metric's definition without a cutover marker."],
      autoAccept: true,
      duplicatedFrom: null,
    };
    assert.deepEqual(created, expected);
    assert.deepEqual(store.get("identity-1"), expected);
    assert.deepEqual(store.byHandle("@jun/reports"), expected);
    assert.equal(store.get("identity-9"), undefined);
  });

  test("each seed identity in the fixture is created by its owner", () => {
    const { store } = sqlite();
    for (const seed of seeds) {
      const name = seed.handle.slice(seed.handle.indexOf("/") + 1);
      const identity = ok(
        store.create(seed.owner, { handle: seed.handle, name, job: seed.job, charterScopes: seed.charter_scopes }, scopeMap),
      );
      assert.deepEqual(store.byHandle(seed.handle), identity);
      assert.equal(identity.ownerId, seed.owner);
      assert.equal(identity.autoAccept, false);
      assert.equal(identity.avatar, null);
    }
  });

  test("a handle must be @<caller>/<name>", () => {
    const { store } = sqlite();
    rejected(store.create("priya", reportsInput, scopeMap), "invalid", /must begin with the caller, @priya\//u);
    for (const handle of ["jun/reports", "@Jun/reports", "@jun/re.ports", "@jun/", "@jun/a/b", `@jun/${"a".repeat(80)}`]) {
      rejected(store.create("jun", { ...reportsInput, handle }, scopeMap), "invalid", /handle must match/u);
    }
    rejected(store.create("penguin", { ...reportsInput, handle: "@penguin/x" }, scopeMap), "invalid", /caller/u);
  });

  test("a handle is taken once", () => {
    const { store } = sqlite();
    ok(store.create("jun", reportsInput, scopeMap));
    rejected(store.create("jun", reportsInput, scopeMap), "handle_taken");
  });

  test("text fields are length-capped and refuse control characters", () => {
    const { store } = sqlite();
    const cases: [Partial<IdentityInput>, RegExp][] = [
      [{ name: "x".repeat(IDENTITY_LIMITS.nameLength + 1) }, /name is longer than 80/u],
      [{ name: "  " }, /name must be non-empty/u],
      [{ name: "Re\u0000ports" }, /name contains a control character/u],
      [{ job: "x".repeat(IDENTITY_LIMITS.jobLength + 1) }, /job is longer/u],
      [{ charterRules: ["x".repeat(IDENTITY_LIMITS.ruleLength + 1)] }, /charterRules\[0\] is longer/u],
      [{ charterRules: Array.from({ length: IDENTITY_LIMITS.rules + 1 }, () => "rule") }, /more than 32/u],
      [{ charterPaths: ["../ingestion"] }, /charterPaths\[0\]/u],
      [{ charterPaths: ["x".repeat(IDENTITY_LIMITS.pathLength + 1)] }, /charterPaths\[0\] must be a path/u],
      [{ autoAccept: "yes" as unknown as boolean }, /autoAccept/u],
    ];
    for (const [change, message] of cases) rejected(store.create("jun", { ...reportsInput, ...change }, scopeMap), "invalid", message);
  });

  test("text is stored with bound parameters, byte for byte", () => {
    const { db, store } = sqlite();
    const name = "Robert'); DROP TABLE Identity;--";
    const identity = ok(store.create("jun", { ...reportsInput, name, job: `"; DELETE FROM Identity; --\nline two` }, scopeMap));
    assert.equal(store.get(identity.id)?.name, name);
    assert.equal(store.get(identity.id)?.job, `"; DELETE FROM Identity; --\nline two`);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM Identity`).get()?.["n"], 1);
  });

  test("an avatar is a PNG, JPEG, GIF or WebP image within the size cap", () => {
    const { store } = sqlite();
    const big = new Uint8Array(IDENTITY_LIMITS.avatarBytes + 1);
    big.set(PNG);
    const cases: [unknown, RegExp][] = [
      [{ mediaType: "image/png", data: big }, /larger than 65536 bytes/u],
      [{ mediaType: "image/svg+xml", data: new TextEncoder().encode("<svg/>") }, /avatar must be one of/u],
      [{ mediaType: "image/jpeg", data: PNG }, /not a image\/jpeg image/u],
      [{ mediaType: "image/png", data: "iVBORw0KGgo=" }, /avatar data must be bytes/u],
      [{ mediaType: "__proto__", data: PNG }, /avatar must be one of/u],
    ];
    for (const [avatar, message] of cases) {
      rejected(store.create("jun", { ...reportsInput, avatar: avatar as IdentityInput["avatar"] }, scopeMap), "invalid", message);
    }
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    ok(store.create("jun", { ...reportsInput, avatar: { mediaType: "image/webp", data: webp } }, scopeMap));
  });

  test("a charter scope must exist and belong to the identity's owner", () => {
    const { store } = sqlite();
    rejected(store.create("jun", { ...reportsInput, charterScopes: ["ghost"] }, scopeMap), "invalid", /not in the scope map/u);
    rejected(
      store.create("jun", { ...reportsInput, charterScopes: ["identity-map"] }, scopeMap),
      "invalid",
      /identity-map belongs to priya, not to jun/u,
    );
  });
});

describe("identities: edit", () => {
  test("only an identity's owner can edit it", () => {
    const { store } = sqlite();
    const identity = ok(store.create("jun", reportsInput, scopeMap));
    rejected(store.edit("priya", identity.id, { name: "Mine now" }, scopeMap), "forbidden", /only @jun\/reports's owner \(jun\)/u);
    const edited = ok(store.edit("jun", identity.id, { name: "Weekly reports", autoAccept: false, avatar: null }, scopeMap));
    assert.equal(edited.name, "Weekly reports");
    assert.equal(edited.autoAccept, false);
    assert.equal(edited.avatar, null);
    assert.deepEqual(store.get(identity.id), edited);
    rejected(store.edit("jun", "identity-9", { name: "x" }, scopeMap), "not_found");
  });

  test("an edit applies the same caps and charter checks as a create", () => {
    const { store } = sqlite();
    const identity = ok(store.create("jun", reportsInput, scopeMap));
    rejected(store.edit("jun", identity.id, { charterScopes: ["messaging"] }, scopeMap), "invalid", /belongs to sam/u);
    rejected(store.edit("jun", identity.id, { job: "x".repeat(IDENTITY_LIMITS.jobLength + 1) }, scopeMap), "invalid");
    assert.deepEqual(store.get(identity.id), identity);
  });
});

describe("identities: duplicate", () => {
  test("a duplicate has a new id, an equal charter and duplicated_from set", () => {
    const { store } = sqlite();
    const original = ok(store.create("jun", reportsInput, scopeMap));
    const copy = ok(store.duplicate("jun", original.id, { handle: "@jun/reports-mobile", name: "Mobile reports" }));
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.duplicatedFrom, original.id);
    assert.equal(copy.handle, "@jun/reports-mobile");
    assert.equal(copy.name, "Mobile reports");
    assert.deepEqual(
      [copy.charterScopes, copy.charterPaths, copy.charterRules, copy.autoAccept],
      [original.charterScopes, original.charterPaths, original.charterRules, original.autoAccept],
    );
    assert.deepEqual(store.get(copy.id), copy);
    assert.deepEqual(store.get(original.id), original);
  });

  test("the original's issue history is not copied", async () => {
    const { db, sql, store } = sqlite();
    const index = new IssueIndex(sql);
    const original = ok(store.create("jun", reportsInput, scopeMap));
    const writer = new Writer(index, store);
    applied(await writer.apply({ person: "jun" }, "create", { title: "Retention drops" }, 40));
    applied(await writer.apply({ person: "jun" }, "assign", { assignee: { identity: "@jun/reports" } }, 40));
    applied(await writer.apply({ identity: "@jun/reports" }, "comment", { body: "Looking" }, 40));

    const copy = ok(store.duplicate("jun", original.id, { handle: "@jun/reports-mobile" }));
    assert.deepEqual([...(index.issue("40")?.assignments.keys() ?? [])], ["identity:@jun/reports"]);
    const authors = db.prepare(`SELECT DISTINCT author FROM AppliedOp ORDER BY author`).all().map((row) => row["author"]);
    assert.deepEqual(authors, ["jun", "jun.reports"]);
    assert.equal(copy.duplicatedFrom, original.id);
  });

  test("only the owner duplicates, under a free handle of the caller's own", () => {
    const { store } = sqlite();
    const original = ok(store.create("jun", reportsInput, scopeMap));
    rejected(store.duplicate("priya", original.id, { handle: "@priya/reports" }), "forbidden");
    rejected(store.duplicate("jun", original.id, { handle: "@jun/reports" }), "handle_taken");
    rejected(store.duplicate("jun", original.id, { handle: "@priya/reports-2" }), "invalid");
    rejected(store.duplicate("jun", "identity-9", { handle: "@jun/x" }), "not_found");
  });
});

describe("identities: team identities", () => {
  const pairInput = {
    handle: "@jun/data-pair",
    name: "Data pair",
    job: "Keep person_id and the retention models in step",
    charterScopes: ["analytics", "identity-map"],
    owners: ["jun", "priya"],
  };

  test("a team identity serves several owners and any of them may edit it", () => {
    const { store } = sqlite();
    const team = ok(store.createTeam("jun", pairInput, scopeMap));
    assert.equal(team.ownerId, null);
    assert.deepEqual(team.teamOwners, ["jun", "priya"]);
    assert.deepEqual(store.get(team.id), team);
    ok(store.edit("priya", team.id, { autoAccept: true }, scopeMap));
    rejected(store.edit("sam", team.id, { autoAccept: false }, scopeMap), "forbidden", /\(jun, priya\)/u);
    const copy = ok(store.duplicate("priya", team.id, { handle: "@priya/data-pair" }));
    assert.deepEqual([copy.ownerId, copy.teamOwners, copy.autoAccept], [null, ["jun", "priya"], true]);
  });

  test("a team identity needs two owners, the caller among them, and scopes those owners own", () => {
    const { store } = sqlite();
    rejected(store.createTeam("jun", { ...pairInput, owners: ["jun"] }, scopeMap), "invalid", /at least two owners/u);
    rejected(store.createTeam("jun", { ...pairInput, owners: ["priya", "sam"] }, scopeMap), "invalid", /must be one of/u);
    rejected(store.createTeam("jun", { ...pairInput, owners: ["jun", "penguin"] }, scopeMap), "invalid", /owners\[1\]/u);
    rejected(
      store.createTeam("jun", { ...pairInput, charterScopes: ["messaging"] }, scopeMap),
      "invalid",
      /belongs to sam, not to jun or priya/u,
    );
  });
});

describe("identities: the charter on the issue", () => {
  test("an operation from @jun/reports naming a scope outside its charter is rejected and the issue shows it", async () => {
    const { sql, store } = sqlite();
    const index = new IssueIndex(sql);
    ok(store.create("jun", reportsInput, scopeMap));
    const writer = new Writer(index, store);
    applied(await writer.apply({ person: "jun" }, "create", { title: "Retention drops" }, 40));

    const outside = await writer.apply({ identity: "@jun/reports" }, "add_label", { label: "scope:identity-map" }, 40);
    rejectedFor(outside, "outside_charter");
    applied(await writer.apply({ identity: "@jun/reports" }, "add_label", { label: "scope:analytics" }, 40));

    const rejections = index.read("40").timeline.filter((entry) => entry.status === "rejected");
    assert.deepEqual(
      rejections.map((entry) => [entry.opId, entry.author, entry.rejectReason, entry.message]),
      [
        [
          "jun.reports-b3f2-0001",
          "jun.reports",
          "outside_charter",
          "@jun/reports acts outside its charter (scopes: analytics; paths: docs/metrics): the operation names scope identity-map",
        ],
      ],
    );
    assert.deepEqual(index.issue("40")?.labels, ["scope:analytics"]);
  });

  test("a submission over MCP outside the charter goes back to the session", async () => {
    const { sql, store } = sqlite();
    const index = new IssueIndex(sql);
    ok(store.create("jun", reportsInput, scopeMap));
    const submit = (operation: unknown, author: Author) =>
      index.submit({ operation, author, source: "mcp", signingKey: service.privateKey, keys: { ...keys, identities: store } });
    assert.equal((await submit({ issue: 40, type: "create", base_version: 0, payload: { title: "x" } }, { person: "jun" })).status, "applied");
    const outcome = await submit(
      { issue: 40, type: "add_label", base_version: 1, payload: { label: "scope:messaging" } },
      { identity: "@jun/reports" },
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.status === "rejected" && outcome.reason, "outside_charter");
  });

  test("a team identity assigned by Jun is refused an operation in Priya's scope", async () => {
    const { sql, store } = sqlite();
    const index = new IssueIndex(sql);
    ok(
      store.createTeam(
        "jun",
        { handle: "@jun/data-pair", name: "Data pair", job: "Pair", charterScopes: ["analytics", "identity-map"], owners: ["jun", "priya"] },
        scopeMap,
      ),
    );
    const pair: Author = { identity: "@jun/data-pair" };
    const writer = new Writer(index, store);
    applied(await writer.apply({ person: "jun" }, "create", { title: "Retention drops" }, 40));
    // Unassigned, the team identity works in no one's scope.
    rejectedFor(await writer.apply(pair, "add_label", { label: "scope:analytics" }, 40, service.privateKey), "outside_charter");

    applied(await writer.apply({ person: "jun" }, "assign", { assignee: pair }, 40));
    // A second assign while Jun's stands changes nothing: Jun remains the assigning owner.
    applied(await writer.apply({ person: "priya" }, "assign", { assignee: pair }, 40));
    const refused = await writer.apply(pair, "add_label", { label: "scope:identity-map" }, 40, service.privateKey);
    rejectedFor(refused, "outside_charter");
    assert.match(refused.status === "rejected" ? refused.message : "", /assigned by jun, it works only within jun's scopes/u);
    applied(await writer.apply(pair, "add_label", { label: "scope:analytics" }, 40, service.privateKey));

    // Reassigned by Priya, it works in Priya's scope instead.
    applied(await writer.apply({ person: "jun" }, "unassign", { assignee: pair }, 40));
    applied(await writer.apply({ person: "priya" }, "assign", { assignee: pair }, 40));
    applied(await writer.apply(pair, "add_label", { label: "scope:identity-map" }, 40, service.privateKey));
    rejectedFor(await writer.apply(pair, "remove_label", { label: "scope:analytics" }, 40, service.privateKey), "outside_charter");
  });
});

/** Signs each author's next operation at the issue's current version and applies it as a pushed file. */
class Writer {
  readonly #index: IssueIndex;
  readonly #identities: IdentityStore;
  readonly #seqs = new Map<string, number>();
  readonly #versions = new Map<string, number>();

  constructor(index: IssueIndex, identities: IdentityStore) {
    this.#index = index;
    this.#identities = identities;
  }

  async apply(
    author: Author,
    type: Operation["type"],
    payload: Record<string, unknown>,
    issue: IssueId,
    key?: CryptoKey,
  ): Promise<ApplyOutcome> {
    const seqKey = JSON.stringify(author);
    const seq = (this.#seqs.get(seqKey) ?? 0) + 1;
    this.#seqs.set(seqKey, seq);
    const signer = key ?? bridgeKey(author);
    const operation = await signOperation(
      {
        schema_version: 1,
        op_id: formatOpId(author, signer === service.privateKey ? WEB_WRITER_TAG : BRIDGE_TAG, seq),
        issue,
        type,
        author,
        base_version: this.#versions.get(String(issue)) ?? 0,
        payload,
      },
      signer,
    );
    const outcome = await this.#index.apply({
      file: new TextEncoder().encode(JSON.stringify(operation)),
      gitCommit: "c0ffee",
      path: operationPath(operation),
      keys: { ...keys, identities: this.#identities },
    });
    if (outcome.status === "applied") this.#versions.set(outcome.issueId, outcome.version);
    return outcome;
  }
}

/** The writer tag the test bridges number their operations under. */
const BRIDGE_TAG = "b3f2";

function bridgeKey(author: Author): CryptoKey {
  if ("penguin" in author) return service.privateKey;
  const owner = "person" in author ? author.person : author.identity.slice(1, author.identity.indexOf("/"));
  return owner === "jun" ? junBridge.privateKey : priyaBridge.privateKey;
}

function applied(outcome: ApplyOutcome): void {
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

function rejectedFor(outcome: ApplyOutcome, reason: string): void {
  assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
  assert.equal(outcome.status === "rejected" && outcome.reason, reason, JSON.stringify(outcome));
}
