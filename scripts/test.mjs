// Runs one tier of the Node test suite. A tier is a set of test files, so a copy edit does not wait
// on the fixture seeds and a merge of planning code still runs them.
//
//   copy  the dashboard's own tests, including the house-style copy check
//   fast  every test except the slow tier (the default `npm test`)
//   slow  tests that seed a whole fixture or run real git, pytest and Artifacts flows
//   all   fast and slow
//
// Live tests under tests/e2e skip themselves unless their PENGUIN_*_E2E flag is set, so they sit in
// the slow tier without running by default.

import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const ALL = ["{apps,services,packages}/*/{src,test}/**/*.test.ts", "tests/**/*.test.ts"];
const COPY = ["apps/dashboard/test/**/*.test.ts"];
const SLOW = [
  "apps/worker/test/contract-sort-fixtures.test.ts",
  "apps/worker/test/dashboard-fixture.test.ts",
  "apps/worker/test/money-*.test.ts",
  "apps/worker/test/preview-approvals.test.ts",
  "tests/integration/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
];

const files = (patterns) => new Set(patterns.flatMap((pattern) => globSync(pattern)));

const tier = process.argv[2] ?? "fast";
const slow = files(SLOW);
const selected = {
  copy: () => [...files(COPY)],
  fast: () => [...files(ALL)].filter((file) => !slow.has(file)),
  slow: () => [...slow],
  all: () => [...files(ALL)],
}[tier];
if (selected === undefined) {
  console.error(`unknown tier ${tier}: use copy, fast, slow or all`);
  process.exit(2);
}

const list = selected().sort();
const run = spawnSync(process.execPath, ["--test", ...process.argv.slice(3), ...list], { stdio: "inherit" });
process.exit(run.status ?? 1);
