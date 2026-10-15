// Measures how long Penguin's check runner takes to check each land on Larder, for docs/testing.md
// (#194, #196). Run it on the test machine:
//
//   node scripts/benchmark-land.ts [--runs N]
//   LARDER_SCALE_PEOPLE=30 node scripts/benchmark-land.ts     # fewer generated people
//   SEED_CASES_TO=3 node scripts/benchmark-land.ts             # cases 1 to 3 only, no split
//
// Each run seeds Larder's four cases as the use-case tests do (scripts/preview/seed.ts). For every
// block run the check runner reports (cases 1 to 3 and each block of case 4), it prints the land's
// targets, the runner's wall time from its report, and the time each kind of check took summed over
// every target, read from each check's own `durationMs`. With several runs it prints each value's
// median and range. The preview fetches forks from a local repository, so fetch time here is not the
// network fetch of an Artifacts fork; that is measured on its own.
import { cpus, hostname, totalmem } from "node:os";
import { parseArgs } from "node:util";

import { larderExpanded, seed } from "./preview/seed.ts";

// The seed keeps its block reports only when asked.
process.env["SEED_BLOCK_REPORTS"] = "1";

const { values } = parseArgs({ options: { runs: { type: "string", default: "1" } } });
const runs = Number(values.runs);

interface Land {
  readonly change: string;
  readonly targets: number;
  readonly wallMs: number;
  readonly byCheck: Record<string, number>;
}

const lands: Land[][] = [];
for (let run = 0; run < runs; run += 1) {
  const preview = await seed("money-minor-units", { runnerTools: false });
  lands.push(
    preview.blockReports.map((report) => {
      const byCheck: Record<string, number> = {};
      for (const check of report.checks) byCheck[check.check] = (byCheck[check.check] ?? 0) + check.durationMs;
      const targets = new Set(report.checks.map((check) => check.target).filter((target) => target !== "main")).size;
      return { change: report.checkpoint.slice(0, 12), targets, wallMs: report.durationMs, byCheck };
    }),
  );
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const seconds = (ms: number) => (ms / 1000).toFixed(2);
const spread = (values: readonly number[]) => (values.length > 1 ? ` (${seconds(Math.min(...values))}-${seconds(Math.max(...values))})` : "");

const running = larderExpanded().larder.features.filter((feature) => feature.role !== "migration").length;
console.log(`machine: ${hostname()}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB; running features: ${running}; runs: ${runs}`);
for (const [index, land] of (lands[0] ?? []).entries()) {
  const walls = lands.map((each) => each[index]?.wallMs ?? 0);
  const checks = Object.keys(land.byCheck)
    .sort()
    .map((check) => `${check} ${seconds(median(lands.map((each) => each[index]?.byCheck[check] ?? 0)))}`)
    .join(", ");
  console.log(`block ${index + 1} at ${land.change}: ${land.targets} targets, runner ${seconds(median(walls))} s${spread(walls)}; ${checks}`);
}
