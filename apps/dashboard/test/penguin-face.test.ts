// An agent's avatar (identity plan section 3): a crop of Penguin's logo in the owner's person hue and
// white. A builder is the hue on white; the owner's steward is the same crop inverted.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { assignPersonHues } from "../src/person-hue.ts";
import { LOGO_PATH, penguinFace } from "../src/penguin-face.ts";

const team = assignPersonHues(["priya", "jun", "sam"]);

test("a builder and the owner's steward take the owner's hue with ground and logo swapped", () => {
  const builder = penguinFace("@priya/accounts-merge", team);
  const steward = penguinFace("@priya/steward", team);
  assert.deepEqual(builder, { hue: team.get("priya"), ground: "fill-white", figure: "fill-person" });
  assert.deepEqual(steward, { hue: team.get("priya"), ground: "fill-person", figure: "fill-white" });
  assert.equal(penguinFace("@priya/tip-jar", team).hue, builder.hue);
  assert.notEqual(penguinFace("@jun/cohort-ltv", team).hue, builder.hue);
});

test("the avatar draws the path of Penguin's logo: outline, belly and eye", async () => {
  const avatar = await readFile(join(import.meta.dirname, "../src/avatar.tsx"), "utf8");
  assert.match(avatar, /d=\{LOGO_PATH\} fillRule="evenodd"/u);
  assert.equal(LOGO_PATH.match(/M /gu)?.length, 3);
  assert.ok(LOGO_PATH.startsWith("M 636.0 101.0 Q 609.0 88.0"));
});
