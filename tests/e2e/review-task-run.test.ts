/**
 * The live check of #138 (PRD 0.5 section 4.4a, PRD case 2): the review forms of the helpful-fix case
 * are filled in by `claude -p` from each author's bridge, with Penguin's MCP server reached through the
 * CLI's MCP config and a token for the one review task. The Worker and both agents run under local
 * `wrangler dev`; every repo sits under a prefix unique to the run and is deleted at the end. Skipped
 * unless PENGUIN_REVIEW_E2E=1; docs/bridge-and-runner.md says how to run it.
 *
 * 1. The case runs the walkthrough's steps up to the plan: Jun's and Sam's features build, Priya's
 *    feature opens, reports the checkpoint that adds `start_of_local_day()` and proposes one part per
 *    affected feature there. Each part
 *    waits on its author, and Penguin routes one review task per scope to the author's steward.
 * 2. No agent session of a steward runs. Each author's bridge runs `penguin-bridge edits --once` with
 *    `claude -p`: it claims the review task and the CLI submits the form through submit_review.
 * 3. The check runner records each form and runs each part's trial. The run reports whether Penguin
 *    approved each part itself and whether any author was asked.
 *
 * Tokens stay in memory and in the MCP config file the bridge removes; nothing prints one.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { runCli, type CliIo } from "@penguin/local-bridge";

import { reposWithPrefix } from "../walkthrough/support/stack.ts";
import { CaseRun } from "../walkthrough/support/case-run.ts";
import { CaseFixture, type CaseCommit } from "../walkthrough/support/fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = join(VENV_BIN, "python");
const RUN_ID = randomBytes(3).toString("hex");
const PREFIX = `p138-${RUN_ID}-`;
const OUT = process.env.PENGUIN_REVIEW_E2E_OUT ?? join(tmpdir(), `penguin-review-e2e-${RUN_ID}`);
const MODEL = process.env.PENGUIN_REVIEW_E2E_MODEL ?? "haiku";
// The runner's allowlisted test commands run `python -m pytest` from the PATH.
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);

const enabled = process.env.PENGUIN_REVIEW_E2E === "1";
const quietIo = (output: string[]): CliIo => ({ write: (text) => output.push(text), ask: async () => "y" });

test("each author's review form is submitted headless by claude -p through Penguin's MCP server", { skip: enabled ? false : "set PENGUIN_REVIEW_E2E=1 to run it against real Artifacts and claude -p", timeout: 60 * 60_000 }, async () => {
  await mkdir(OUT, { recursive: true });
  const fixture = CaseFixture.load(REPO_ROOT, "helpful-fix");
  const origin = fixture.origin;
  const run = new CaseRun({ repoRoot: REPO_ROOT, python: PYTHON, fixture, prefix: PREFIX, outDir: OUT });
  const evidence: Record<string, unknown> = { prefix: PREFIX, model: MODEL, runs: [] };
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await run.setUp(browser);
    // 1. The case up to the plan, as the walkthrough runs it.
    await run.openRunning();
    await run.landPromotions();
    await run.openFeature(origin);
    // PRD case 2 orders it so: Priya's agent reports the checkpoint that adds start_of_local_day(),
    // then proposes the plan there, so each part's trial tree holds the helper.
    for (const commit of origin.commits) await run.publish(origin, commit as CaseCommit);
    const plan = await run.proposePlan();
    assert.equal(plan["status"], "stored", JSON.stringify(plan).slice(0, 2_000));
    const parts = [...run.parts.values()];
    evidence["parts"] = parts.map(({ partId, owner, scopes, kind }) => ({ partId, owner, scopes, kind }));

    // 2. Each author's bridge runs its review task with claude -p; no steward session runs.
    for (const owner of [...new Set(parts.map((part) => part.owner))]) {
      const page = await run.featurePage(origin.id);
      const tasks = (page.editTasks as { id: number; kind: string; handle: string; person: string; state: string; askReason: string | null }[]).filter(
        (task) => task.kind === "review" && task.person === owner,
      );
      assert.ok(tasks.length > 0, `no review task for ${owner}: ${JSON.stringify(page.editTasks)}`);
      const person = run.person(owner);
      const output: string[] = [];
      const started = Date.now();
      const code = await runCli(
        ["edits", "--once", "--vendor", "claude", "--model", MODEL, "--timeout-minutes", "10", "--project", fixture.name, "--state-dir", person.stateDir],
        quietIo(output),
        { keyStore: person.keyStore, stateDir: person.stateDir },
      );
      const printed = output.join("");
      assert.doesNotMatch(printed, /pgt_|pgm_|art_|Bearer /u, "no token is printed");
      const after = (await run.featurePage(origin.id)).editTasks as { id: number; state: string; askReason: string | null; outcome: string | null }[];
      (evidence["runs"] as unknown[]).push({
        owner,
        exit: code,
        ms: Date.now() - started,
        lines: printed.split("\n").filter((line) => /^Edit task|^Edit tasks for/u.test(line)),
        tasks: tasks.map((task) => ({ id: task.id, handle: task.handle, before: task.state, after: after.find((each) => each.id === task.id) })),
      });
      assert.equal(code, 0, printed);
    }
    const page = await run.featurePage(origin.id);
    evidence["reviews"] = (page.reviews as Record<string, unknown>[]).map(({ reviewId, scope, reviewer, state, refusals }) => ({ reviewId, scope, reviewer, state, refusals }));

    // 3. The runner records the forms and runs the trials; Penguin decides each part or asks its author.
    // A part still pending once every form is recorded and the runner made three more passes waits on
    // its author: the inbox then names each reason it goes to the author in person.
    let passesAfterRecords = 0;
    const decided = await run.until("a decision on every part", async () => {
      await run.dashboard.signIn(origin.owner);
      const current = (await run.dashboard.get(`/api/features/${encodeURIComponent(origin.id)}/plan`)).parts as { partId: string; approvalState: string; approvedBy: string | null }[];
      const reviews = (await run.featurePage(origin.id)).reviews as { state: string }[];
      const allApproved = current.every((part) => part.approvalState === "approved");
      if (reviews.every((review) => review.state !== "pending")) passesAfterRecords += 1;
      if (!allApproved && passesAfterRecords < 4) return undefined;
      const asked: { owner: string; partId: string; ask: string; routing: unknown }[] = [];
      for (const owner of new Set(parts.map((part) => part.owner))) {
        const waiting = await run.dashboard.partsWaiting(owner);
        asked.push(...waiting.filter((each) => each.ask === "approve").map((each) => ({ owner, partId: each.partId, ask: each.ask, routing: each.routing })));
      }
      return { parts: current.map(({ partId, approvalState, approvedBy }) => ({ partId, approvalState, approvedBy })), asked };
    });
    evidence["decision"] = decided;
    evidence["reviewsAfter"] = ((await run.featurePage(origin.id)).reviews as Record<string, unknown>[]).map(({ reviewId, scope, reviewer, state, exceptions, refusals, rows }) => ({ reviewId, scope, reviewer, state, exceptions, refusals, rows }));
    evidence["approvedByPenguinWithNobodyAsked"] = decided.asked.length === 0 && decided.parts.every((part) => part.approvalState === "approved" && part.approvedBy === "penguin");
  } finally {
    evidence["deletedRepos"] = await run.tearDown().catch((error: unknown) => [`teardown failed: ${String(error)}`]);
    evidence["remainingRepos"] = await reposWithPrefix(REPO_ROOT, PREFIX).catch((error: unknown) => [`could not list: ${String(error)}`]);
    evidence["notes"] = run.notes;
    await writeFile(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
});
