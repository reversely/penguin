import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { parseOwnersFile, parseScopeFile } from "../src/scope-file.ts";

describe("parseScopeFile", () => {
  test("reads the fixture's scope file", () => {
    const penguin = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin");
    const scopes = parseScopeFile(readFileSync(join(penguin, "scopes.json")), readFileSync(join(penguin, "teams.json")));
    assert.ok(scopes.scopes.size > 0);
    assert.equal(scopes.scopes.get("analytics")?.teamId, "data");
  });

  test("a base repo without a scope file has no scopes", () => {
    assert.equal(parseScopeFile(null).scopes.size, 0);
  });

  test("an unreadable scope file throws so operations are retried", () => {
    assert.throws(() => parseScopeFile(new TextEncoder().encode("not json")), /penguin\/scopes\.json/);
    assert.throws(() => parseScopeFile(new TextEncoder().encode(`{"scopes": "none"}`)), /penguin\/scopes\.json/);
  });
});

describe("parseOwnersFile", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  test("the fixture's owners name no delegate", () => {
    const file = readFileSync(
      join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/owners.json"),
    );
    assert.deepEqual(parseOwnersFile(file), new Map());
  });

  test("each owner that names a delegate other than itself maps to it", () => {
    const owners = [
      { id: "priya", display_name: "Priya", delegate_owner_id: "lee", role: "owner" },
      { id: "jun", display_name: "Jun", delegate_owner_id: null, role: "owner" },
      { id: "sam", display_name: "Sam", delegate_owner_id: "sam", role: "owner" },
    ];
    assert.deepEqual(parseOwnersFile(encode({ owners })), new Map([["priya", "lee"]]));
  });

  test("a base repo without an owners file names no delegate", () => {
    assert.deepEqual(parseOwnersFile(null), new Map());
  });

  test("an unreadable owners file throws so operations are retried", () => {
    assert.throws(() => parseOwnersFile(new TextEncoder().encode("not json")), /penguin\/owners\.json/);
    assert.throws(() => parseOwnersFile(encode({ owners: "none" })), /penguin\/owners\.json: owners must be an array/);
    assert.throws(() => parseOwnersFile(encode({ owners: [{ delegate_owner_id: "lee" }] })), /owners\[0\]\.id/);
    assert.throws(() => parseOwnersFile(encode({ owners: [{ id: "priya", delegate_owner_id: 7 }] })), /delegate_owner_id/);
  });
});
