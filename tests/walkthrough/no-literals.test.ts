// The walkthrough reads every owner, handle, scope, SHA and test ID from the fixtures at runtime.
// These tests grep its source (the specs, its support modules and every test helper they import) for
// any of those values, with the forbidden strings derived from the fixtures' own files, and check
// that renaming an owner in a fixture changes what the walkthrough derives.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { UseCaseFixture } from "./support/fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WALKTHROUGH = fileURLToPath(new URL(".", import.meta.url));
const TESTS = resolve(WALKTHROUGH, "..");

/**
 * The fixtures the walkthrough plays: those that commit their owners under `base/penguin/`. The
 * money-minor-units fixture generates its penguin files from its data file and is not played yet.
 */
async function useCases(root: string): Promise<UseCaseFixture[]> {
  const entries = await readdir(join(root, "examples"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, "examples", entry.name, "base", "penguin", "owners.json")))
    .map((entry) => new UseCaseFixture(root, entry.name));
}

/** The walkthrough's TypeScript files, and every module under tests/ that they import, transitively. */
async function walkthroughSources(): Promise<string[]> {
  const queue = (await readdir(WALKTHROUGH, { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(WALKTHROUGH, path));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8");
    for (const [, specifier] of text.matchAll(/from "(\.{1,2}\/[^"]+\.ts)"/gu)) {
      const imported = resolve(dirname(file), specifier as string);
      if (imported.startsWith(TESTS)) queue.push(imported);
    }
  }
  return [...seen].sort();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/** Each forbidden value found in `text`, as a whole word, and each SHA's seven-character short form. */
function literalsIn(text: string, forbidden: readonly string[]): string[] {
  const variants = forbidden.flatMap((value) => (/^[0-9a-f]{40}$/u.test(value) ? [value, value.slice(0, 7)] : [value]));
  return [...new Set(variants)].filter((value) => new RegExp(`(?<![\\w@/-])${escape(value)}(?![\\w-])`, "u").test(text));
}

test("the walkthrough source names no owner, handle, scope, SHA or test ID from the fixtures", async () => {
  const fixtures = await useCases(REPO_ROOT);
  assert.ok(fixtures.length >= 3, "the three use-case fixtures");
  const forbidden = fixtures.flatMap((fixture) => fixture.forbiddenLiterals());
  for (const fixture of fixtures) {
    for (const owner of fixture.owners) assert.ok(forbidden.includes(owner.id));
    for (const sha of Object.values(fixture.pins.branches)) assert.ok(forbidden.includes(sha));
  }
  const sources = await walkthroughSources();
  assert.ok(sources.some((path) => path.endsWith("walkthrough.spec.ts")), "the spec is checked");
  const found = [];
  for (const path of sources) {
    const hits = literalsIn(await readFile(path, "utf8"), forbidden);
    if (hits.length > 0) found.push(`${path.slice(REPO_ROOT.length)}: ${hits.join(", ")}`);
  }
  assert.deepEqual(found, []);
});

test("the grep finds a fixture value written into a source", async () => {
  const [fixture] = await useCases(REPO_ROOT);
  assert.ok(fixture);
  const owner = fixture.owners[0]!;
  const sha = Object.values(fixture.pins.branches)[0]!;
  const handle = fixture.identities[0]!.handle;
  const source = `await signIn("${owner.id}"); expect(head).toBe("${sha.slice(0, 7)}"); register("${handle}");`;
  assert.deepEqual(literalsIn(source, fixture.forbiddenLiterals()).sort(), [owner.id, sha.slice(0, 7), handle].sort());
  assert.deepEqual(literalsIn(`const ${owner.id}ish = 1; // a ${owner.id}-gh-like word`, [owner.id]), []);
});

test("renaming an owner in a fixture changes what the walkthrough derives", async () => {
  const root = await mkdtemp(join(tmpdir(), "penguin-walkthrough-rename-"));
  try {
    for (const fixture of await useCases(REPO_ROOT)) {
      const copy = join(root, "examples", fixture.name);
      await cp(join(fixture.dir, "pins.json"), join(copy, "pins.json"));
      await cp(join(fixture.dir, "base", "penguin"), join(copy, "base", "penguin"), { recursive: true });
      const old = fixture.triggerOwner.id;
      const renamed = `${old}x`;
      for (const file of ["owners.json", "scopes.json", "identities.json"]) {
        const path = join(copy, "base", "penguin", file);
        const text = (await readFile(path, "utf8"))
          .replaceAll(`"${old}"`, `"${renamed}"`)
          .replaceAll(`"@${old}/`, `"@${renamed}/`);
        await writeFile(path, text);
      }
      const pinsPath = join(copy, "pins.json");
      await writeFile(pinsPath, (await readFile(pinsPath, "utf8")).replaceAll(`"owner-${old}`, `"owner-${renamed}`));

      const before = fixture;
      const after = new UseCaseFixture(root, fixture.name);
      assert.equal(after.triggerOwner.id, renamed, fixture.name);
      assert.ok(after.identities.filter((identity) => identity.owner === renamed).every((identity) => identity.handle.startsWith(`@${renamed}/`)));
      assert.deepEqual(
        after.expectedFixes.map((fix) => [fix.nodeId, fix.finalAssignee.handle.replace(`@${renamed}/`, `@${old}/`), fix.upstream]),
        before.expectedFixes.map((fix) => [fix.nodeId, fix.finalAssignee.handle, fix.upstream]),
      );
      assert.ok(!JSON.stringify(after.expectedFixes).includes(`"${old}"`), `${fixture.name} still names ${old}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fixtures give the walkthrough one trigger per use case and one upstream fix in all", async () => {
  const fixtures = await useCases(REPO_ROOT);
  for (const fixture of fixtures) {
    assert.ok(fixture.checkpointOf(fixture.triggerOwner.id), `${fixture.name} has a trigger checkpoint`);
    assert.ok(fixture.expectedFixes.length > 0, `${fixture.name} has failing tests`);
  }
  assert.equal(fixtures.flatMap((fixture) => fixture.expectedFixes).filter((fix) => fix.upstream).length, 1);
});
