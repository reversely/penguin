// Runs one tier of the Node test suite (docs/testing.md).
//
//   fast  the PRD's rules and the dashboard's copy check: pure functions, under a few seconds
//   copy  the dashboard's copy check alone
//   slow  the four use cases on the fixtures, through Penguin's own code with real git and pytest
//   live  one test per Cloudflare primitive against real Artifacts; each skips unless its
//         PENGUIN_*_E2E flag is set and the machine is logged in to Cloudflare
//   all   fast and slow

import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const TIERS = {
  fast: ["tests/rules/**/*.test.ts", "apps/dashboard/test/**/*.test.ts", "tests/walkthrough/**/*.test.ts"],
  copy: ["apps/dashboard/test/**/*.test.ts"],
  slow: ["tests/cases/**/*.test.ts"],
  live: ["tests/e2e/**/*.test.ts"],
};
TIERS.all = [...TIERS.fast, ...TIERS.slow];

const tier = process.argv[2] ?? "fast";
const patterns = TIERS[tier];
if (patterns === undefined) {
  console.error(`unknown tier ${tier}: use ${Object.keys(TIERS).join(", ")}`);
  process.exit(2);
}

const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern)))].sort();
const run = spawnSync(process.execPath, ["--test", ...process.argv.slice(3), ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
