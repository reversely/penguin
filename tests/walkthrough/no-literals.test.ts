// The walkthrough reads every person, handle, scope, feature, SHA and test ID from the fixtures at
// runtime. These tests grep its source (the spec, its support modules and every test helper they
// import) for any of those values, with the forbidden strings derived from the fixtures' own files,
// and check that renaming a person in a fixture changes what the walkthrough derives.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CaseFixture } from "./support/fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WALKTHROUGH = fileURLToPath(new URL(".", import.meta.url));
const TESTS = resolve(WALKTHROUGH, "..");

/** The cases the walkthrough plays. */
async function cases(root: string): Promise<CaseFixture[]> {
  return CaseFixture.all(root);
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

/** Every object key of a case's data files: the format's own words, such as a field name. */
async function formatKeys(fixture: CaseFixture): Promise<Set<string>> {
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        keys.add(key);
        walk(inner);
      }
    }
  };
  for (const file of ["features.json", "larder.json"]) {
    const path = join(fixture.dir, file);
    if (existsSync(path)) walk(JSON.parse(await readFile(path, "utf8")));
  }
  return keys;
}

/**
 * The values the walkthrough must not name. A value that is also a key of the data files' format,
 * such as a scope named like a field, reads as the format's word in the source, so it is left out.
 */
async function forbiddenValues(fixtures: readonly CaseFixture[]): Promise<string[]> {
  const keys = new Set<string>();
  for (const fixture of fixtures) for (const key of await formatKeys(fixture)) keys.add(key);
  return fixtures.flatMap((fixture) => fixture.forbiddenLiterals()).filter((value) => !keys.has(value));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/** Each forbidden value found in `text`, as a whole word, and each SHA's seven-character short form. */
function literalsIn(text: string, forbidden: readonly string[]): string[] {
  const variants = forbidden.flatMap((value) => (/^[0-9a-f]{40}$/u.test(value) ? [value, value.slice(0, 7)] : [value]));
  return [...new Set(variants)].filter((value) => new RegExp(`(?<![\\w@/-])${escape(value)}(?![\\w-])`, "u").test(text));
}

test("the walkthrough source names no person, handle, scope, feature, SHA or test ID from the fixtures", async () => {
  const fixtures = await cases(REPO_ROOT);
  assert.equal(fixtures.length, 4, "the four cases");
  const forbidden = await forbiddenValues(fixtures);
  for (const fixture of fixtures) {
    for (const person of fixture.people) assert.ok(forbidden.includes(person.id));
    for (const feature of fixture.features) assert.ok(forbidden.includes(feature.id));
    for (const sha of Object.values(fixture.pins.branches)) assert.ok(forbidden.includes(sha));
  }
  const sources = await walkthroughSources();
  assert.ok(sources.some((path) => path.endsWith("walkthrough.spec.ts")), "the spec is checked");
  assert.ok(sources.some((path) => path.endsWith("case-run.ts")), "the case run is checked");
  const found = [];
  for (const path of sources) {
    const hits = literalsIn(await readFile(path, "utf8"), forbidden);
    if (hits.length > 0) found.push(`${path.slice(REPO_ROOT.length)}: ${hits.join(", ")}`);
  }
  assert.deepEqual(found, []);
});

test("the grep finds a fixture value written into a source", async () => {
  const [fixture] = await cases(REPO_ROOT);
  assert.ok(fixture);
  const person = fixture.people[0]!;
  const sha = Object.values(fixture.pins.branches)[0]!;
  const handle = fixture.identities[0]!.handle;
  const source = `await signIn("${person.id}"); expect(head).toBe("${sha.slice(0, 7)}"); register("${handle}");`;
  assert.deepEqual(literalsIn(source, fixture.forbiddenLiterals()).sort(), [person.id, sha.slice(0, 7), handle].sort());
  assert.deepEqual(literalsIn(`const ${person.id}ish = 1; // a ${person.id}-gh-like word`, [person.id]), []);
});

test("renaming the originating person in a fixture changes what the walkthrough derives", async () => {
  const root = await mkdtemp(join(tmpdir(), "penguin-walkthrough-rename-"));
  try {
    for (const fixture of (await cases(REPO_ROOT)).filter((each) => existsSync(join(each.dir, "features.json")))) {
      const copy = join(root, "examples", fixture.name);
      await cp(join(fixture.dir, "pins.json"), join(copy, "pins.json"));
      await cp(join(fixture.dir, "features.json"), join(copy, "features.json"));
      await cp(join(fixture.dir, "base", "penguin"), join(copy, "base", "penguin"), { recursive: true });
      const old = fixture.origin.owner;
      const renamed = `${old}x`;
      for (const path of [...["owners.json", "scopes.json", "identities.json"].map((file) => join(copy, "base", "penguin", file)), join(copy, "features.json")]) {
        const text = (await readFile(path, "utf8")).replaceAll(`"${old}"`, `"${renamed}"`).replaceAll(`"@${old}/`, `"@${renamed}/`);
        await writeFile(path, text);
      }
      const after = CaseFixture.load(root, fixture.name);
      assert.equal(after.origin.owner, renamed, fixture.name);
      assert.ok(after.origin.handle.startsWith(`@${renamed}/`), `${fixture.name}: ${after.origin.handle}`);
      assert.deepEqual(after.origin.commits, fixture.origin.commits);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each case has one originating feature, pinned commits and review forms for single scopes", async () => {
  for (const fixture of await cases(REPO_ROOT)) {
    assert.ok(fixture.origin.commits.length > 0, fixture.name);
    for (const feature of fixture.features) {
      for (const commit of feature.commits) assert.match(commit.sha, /^[0-9a-f]{40}$/u, `${fixture.name}/${feature.id}`);
      if (fixture.fixOf(feature) !== undefined) assert.ok(fixture.checkpointsOf(feature).length > 0, `${feature.id} has a checkpoint before its fix`);
    }
    const scopes = new Set(fixture.scopes.map((scope) => scope.id));
    const reviewed = [...scopes].flatMap((scope) => fixture.formsFor(scope));
    assert.equal(reviewed.length, fixture.reviewForms.length, `${fixture.name}: every review form names the invariants of one scope`);
    for (const commit of fixture.origin.commits.filter((each) => each.revises !== null)) {
      assert.ok(scopes.has(commit.revises?.scope as string), `${fixture.name}: a revision names a scope`);
    }
  }
});
