// How a proposed fix is checked before anyone writes it (PRD 0.5 sections 4.2 and 4.4): a patch must
// apply exactly to the fork it targets, and a declared rewrite rule must be well formed, since Penguin
// applies it with no agent.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyPatchFile, copiedModules, copyProblem, parsePatch, parseRewriteRules } from "@penguin/protocol";

/** The fields of Larder's data file this file reads (examples/money-minor-units/larder.json). */
interface Larder {
  readonly scopes: readonly { readonly id: string; readonly paths: readonly string[] }[];
  readonly features: readonly {
    readonly id: string;
    readonly area: readonly string[];
    readonly commits: readonly { readonly source?: string; readonly tag?: string; readonly update?: { readonly from: string; readonly tag: string; readonly copies: readonly string[] } }[];
  }[];
}

const PATCH = [
  "diff --git a/analytics/weekly.py b/analytics/weekly.py",
  "--- a/analytics/weekly.py",
  "+++ b/analytics/weekly.py",
  "@@ -1,2 +1,2 @@",
  "-from shared.dates import start_of_day",
  "+from shared.dates import start_of_local_day",
  " WEEK = 7",
  "",
].join("\n");

test("a patch applies to the text it was made against", () => {
  const parsed = parsePatch(PATCH);
  assert.ok(parsed.ok);
  const applied = applyPatchFile(parsed.files[0]!, "from shared.dates import start_of_day\nWEEK = 7\n");
  assert.deepEqual(applied, { ok: true, text: "from shared.dates import start_of_local_day\nWEEK = 7\n" });
});

test("a patch whose context no longer matches the fork is refused", () => {
  const parsed = parsePatch(PATCH);
  assert.ok(parsed.ok);
  assert.equal(applyPatchFile(parsed.files[0]!, "import os\nWEEK = 7\n").ok, false);
});

test("a well-formed rewrite rule is accepted", () => {
  const rules = parseRewriteRules([{ id: "price-times", contract: "shared/money.py::price", kind: "expression", pattern: "money.price($a * $q)", replacement: "$a.times($q)", imports: [] }]);
  assert.ok(Array.isArray(rules));
});

test("a rewrite rule without a contract is refused", () => {
  assert.equal(typeof parseRewriteRules([{ id: "bad", kind: "expression", pattern: "x", replacement: "y" }]), "string");
});

// Penguin's update of an affected fork (#178): the originating change's modules the fork imports are
// copied byte for byte, and only files the originating change itself added or changed.

test("a copy of a file the originating change did not add or change is refused", () => {
  const changed = new Set(["accounts/shoppers.py", "analytics/activity.py"]);
  assert.equal(copyProblem(["accounts/shoppers.py"], changed), null);
  assert.match(copyProblem(["accounts/shoppers.py", "penguin/identities.json"], changed) ?? "", /penguin\/identities\.json is not a file the originating change added or changed/u);
});

test("Penguin copies into each Larder fork the modules it imports from its originating change", () => {
  const larder = fileURLToPath(new URL("../../examples/money-minor-units/", import.meta.url));
  const data = JSON.parse(readFileSync(join(larder, "larder.json"), "utf8")) as Larder;
  const filesOf = (dir: string): Map<string, string> =>
    new Map(
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".py") && !path.includes("__pycache__"))
        .map((path) => [path.split(sep).join("/"), readFileSync(join(dir, path), "utf8")]),
    );
  const base = filesOf(join(larder, "base"));
  const updates = data.features.flatMap((feature) => feature.commits.flatMap((commit) => (commit.update === undefined ? [] : [{ feature, commit, update: commit.update }])));
  assert.equal(updates.length, 4, "case 1 updates two forks and case 3 two");
  for (const { feature, commit, update } of updates) {
    const origin = data.features.find((each) => each.id === update.from)!;
    // The change's own files: what each of its commits laid, up to the commit copied from.
    const upTo = origin.commits.findIndex((each) => each.tag === update.tag);
    const changed = new Map<string, string>();
    for (const each of origin.commits.slice(0, upTo + 1)) for (const [path, text] of filesOf(join(larder, "features", origin.id, each.source!))) changed.set(path, text);
    // The fork's Python files in its scopes before Penguin's update.
    const fork = new Map(base);
    for (const each of feature.commits.slice(0, feature.commits.indexOf(commit))) {
      if (each.source !== undefined) for (const [path, text] of filesOf(join(larder, "features", feature.id, each.source))) fork.set(path, text);
    }
    const scopePaths = data.scopes.filter((scope) => feature.area.includes(scope.id)).flatMap((scope) => scope.paths);
    const start = [...fork].filter(([path]) => scopePaths.some((prefix) => path.startsWith(prefix))).map(([, text]) => text);
    assert.deepEqual(copiedModules(start, changed), [...update.copies].sort(), `${feature.id} ${commit.tag}`);
  }
});
