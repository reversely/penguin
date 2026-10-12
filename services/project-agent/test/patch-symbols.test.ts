// The symbol check on a plan part's patch (#132): a name the patch's new lines import from a project
// module must exist in the trial tree, at the checkpoint, at the fork head or in the patch itself.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePatch } from "@penguin/protocol";

import { addedLines, bindsName, importedNames, missingSymbols, modulePaths, type TreeFiles } from "../src/patch-symbols.ts";

const PATCH = `diff --git a/analytics/weekly.py b/analytics/weekly.py
--- a/analytics/weekly.py
+++ b/analytics/weekly.py
@@ -1,4 +1,9 @@
 from collections import Counter
-from shared.dates import start_of_day
+from shared.dates import start_of_day, start_of_local_day as local_day
+from shared.dates import (
+    DAY,
+    week_of,
+)
+from .helpers import bucket
 # The weekly report.
 def weekly_report(events):
`;

const AFTER = [
  "from collections import Counter",
  "from shared.dates import start_of_day, start_of_local_day as local_day",
  "from shared.dates import (",
  "    DAY,",
  "    week_of,",
  ")",
  "from .helpers import bucket",
  "# The weekly report.",
  "def weekly_report(events):",
].join("\n");

test("the names an added import takes, with each module's paths", () => {
  const parsed = parsePatch(PATCH);
  assert.ok(parsed.ok);
  const file = parsed.files[0];
  assert.ok(file !== undefined);
  assert.deepEqual([...addedLines(file)], [2, 3, 4, 5, 6, 7]);
  const names = importedNames(file.path, AFTER, addedLines(file));
  assert.deepEqual(
    names.map((each) => [each.line, each.module, each.name]),
    [
      [2, "shared.dates", "start_of_day"],
      [2, "shared.dates", "start_of_local_day"],
      [3, "shared.dates", "DAY"],
      [3, "shared.dates", "week_of"],
      [7, ".helpers", "bucket"],
    ],
  );
  // An unchanged import is not the patch's.
  assert.deepEqual(importedNames(file.path, AFTER, new Set([7])).map((each) => each.name), ["bucket"]);
  assert.deepEqual(importedNames("README.md", AFTER, addedLines(file)), []);
  assert.deepEqual(modulePaths(".helpers", "analytics/weekly.py"), ["analytics/helpers.py", "analytics/helpers/__init__.py"]);
  assert.deepEqual(modulePaths("..", "a/b/c.py"), ["a.py", "a/__init__.py"]);
  assert.deepEqual(modulePaths("...x", "a.py"), []);
});

test("a module binds a name by a definition, an assignment or an import", () => {
  const source = ["import os", "from .tz import offset as utc_offset", "DAY = 86_400", "WEEK: int = 7", "def week_of(day):", "    inner = 1", "async def later():", "class Bucket:", "    pass"].join("\n");
  for (const name of ["os", "utc_offset", "DAY", "WEEK", "week_of", "later", "Bucket"]) assert.equal(bindsName(source, name), true, name);
  for (const name of ["inner", "offset", "start_of_local_day"]) assert.equal(bindsName(source, name), false, name);
});

test("a name missing from every tree is named; a library module and a name the patch adds are not", async () => {
  const trees: Record<string, { patched?: string | null; checkpoint: string | null; head: string | null }> = {
    "shared/dates.py": { checkpoint: "def start_of_day(ts):\n    pass\nDAY = 1\n", head: "def start_of_day(ts):\n    pass\ndef week_of(day):\n    pass\n" },
    "analytics/helpers.py": { patched: "def bucket(day):\n    pass\n", checkpoint: null, head: null },
  };
  const read: TreeFiles = async (path) => {
    const found = trees[path];
    return { patched: found?.patched, checkpoint: found?.checkpoint ?? null, head: found?.head ?? null };
  };
  const parsed = parsePatch(PATCH);
  assert.ok(parsed.ok);
  const file = parsed.files[0];
  assert.ok(file !== undefined);
  const imports = [...importedNames(file.path, AFTER, addedLines(file)), ...importedNames("x.py", "from collections import Counter", new Set([1]))];
  const missing = await missingSymbols(imports, read);
  assert.deepEqual(missing.map((each) => [each.name, each.modulePath]), [["start_of_local_day", "shared/dates.py"]]);
});
