import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { parseScopeFile } from "../src/scope-file.ts";

describe("parseScopeFile", () => {
  test("reads the fixture's scope file", () => {
    const file = readFileSync(
      join(import.meta.dirname, "../../../examples/identity-unification/base/penguin/scopes.json"),
    );
    assert.ok(parseScopeFile(file).scopes.size > 0);
  });

  test("a base repo without a scope file has no scopes", () => {
    assert.equal(parseScopeFile(null).scopes.size, 0);
  });

  test("an unreadable scope file throws so operations are retried", () => {
    assert.throws(() => parseScopeFile(new TextEncoder().encode("not json")), /penguin\/scopes\.json/);
    assert.throws(() => parseScopeFile(new TextEncoder().encode(`{"scopes": "none"}`)), /penguin\/scopes\.json/);
  });
});
