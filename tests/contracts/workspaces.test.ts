import assert from "node:assert/strict";
import { test } from "node:test";

import { packageName } from "@penguin/protocol";

test("a workspace package resolves by its package name", () => {
  assert.equal(packageName, "@penguin/protocol");
});
