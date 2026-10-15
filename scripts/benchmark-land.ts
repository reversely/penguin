// Times how long Penguin takes to check a land on Larder, for docs/testing.md (#194, #196).
//
//   node scripts/benchmark-land.ts
//
// Seeds Larder's four cases as the use-case tests do (scripts/preview/seed.ts) and prints, for each
// case's originating feature, the time of its block checks: from the check runner's claim of the
// block run to its signed report, on main and every target fork. It also prints the number of running
// features, the whole seed's time and the machine, so a result can be compared with a later one.
import { cpus, hostname, totalmem } from "node:os";

import { larderExpanded, seed } from "./preview/seed.ts";

const started = performance.now();
const preview = await seed("money-minor-units", { runnerTools: false });
const seedMs = performance.now() - started;

const running = larderExpanded().larder.features.filter((feature) => feature.role !== "migration").length;
const blockSteps = preview.steps.filter((step) => step.step.startsWith("block checks of "));
const seconds = (ms: number) => (ms / 1000).toFixed(1);

console.log(`machine: ${hostname()}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB`);
console.log(`running features: ${running}`);
for (const step of blockSteps) console.log(`${step.step}: ${seconds(step.ms)} s`);
console.log(`whole seed: ${seconds(seedMs)} s over ${preview.steps.length} steps`);
