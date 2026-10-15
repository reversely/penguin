/**
 * The four cases of PRD 0.4 section 1, each run from feature open to promotion through the real
 * system: the Worker and both agents under `wrangler dev`, the real Artifacts service under a repo
 * prefix unique to the run, a bridge per person, the check runner in-process, scripted agent sessions
 * over MCP, and people deciding on the dashboard in Google Chrome. `npm run walkthrough` runs it;
 * PENGUIN_WALKTHROUGH_CASES picks cases by fixture folder and PENGUIN_WALKTHROUGH_OUT moves the output.
 *
 * Every person, feature, scope, commit, test and review form is read from the case's fixture at
 * runtime (support/fixture.ts); ids and numbers come from the system's answers.
 * tests/walkthrough/no-literals.test.ts fails when this source names any fixture value.
 *
 * Each case is one serial group of five phases and a metrics step. Each frame of docs/walkthrough.md
 * is one screenshot from the dashboard as the person the frame names. Each case writes its frames,
 * `results.json`, `metrics.md`, `runner.log`, `worker.log` and `cleanup.json` to its own folder.
 */

import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PENGUIN_APPROVER } from "../../packages/protocol/src/plan.ts";
import { CaseRun } from "./support/case-run.ts";
import { bounded } from "./support/stack.ts";
import { Dashboard } from "./support/dashboard.ts";
import { CaseFixture, type CaseCommit } from "./support/fixture.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = join(VENV_BIN, "python");
// The runner's allowlisted test commands run `python -m pytest` from the PATH.
process.env.PATH = [VENV_BIN, process.env.PATH].join(delimiter);

/** The cases of PRD section 1, in order: every fixture folder under examples/ that holds a case. */
const CASES = CaseFixture.all(REPO_ROOT);
const SELECTED = process.env.PENGUIN_WALKTHROUGH_CASES?.split(",").filter((name) => name !== "") ?? CASES.map((fixture) => fixture.name);
const OUT_ROOT = process.env.PENGUIN_WALKTHROUGH_OUT ?? join(REPO_ROOT, "test-results", "walkthrough");
const RUN_ID = randomBytes(3).toString("hex");

for (const [index, fixture] of CASES.entries()) {
  const name = fixture.name;
  test.describe.serial(`case ${index + 1}: ${name}`, () => {
    test.skip(!SELECTED.includes(name), "not selected in PENGUIN_WALKTHROUGH_CASES");
    const origin = fixture.origin;
    const display = (person: string) => fixture.people.find((candidate) => candidate.id === person)?.display_name ?? person;
    const outDir = join(OUT_ROOT, name);
    let run: CaseRun;
    let dashboard: Dashboard;
    const featurePath = (feature: string) => `/features/${encodeURIComponent(feature)}`;

    test.beforeAll(async ({ browser }, info) => {
      info.setTimeout(20 * 60_000);
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      run = new CaseRun({ repoRoot: REPO_ROOT, python: PYTHON, fixture, prefix: `wt100-${RUN_ID}-${index + 1}-`, outDir });
      await run.setUp(browser);
      dashboard = run.dashboard;
    });

    test.afterAll(async () => {
      // A case that stopped partway still writes what it measured, with the failure among its notes.
      if (run !== undefined && !run.resultsWritten) {
        const written = await bounded(120_000, () => run.writeResults());
        if (!written) run.notes.push("The results could not be written within two minutes of the case stopping.");
      }
      const deleted = run === undefined ? [] : await run.tearDown();
      // The final listing of the namespace under the case's prefix: every repo the case made is gone.
      const remaining = run?.stack?.remaining ?? null;
      await writeFile(join(outDir, "cleanup.json"), `${JSON.stringify({ deletedRepos: deleted, remainingRepos: remaining }, null, 2)}\n`);
      expect(remaining, "repos left under the case's prefix after clean-up").toEqual([]);
    });

    test("1. open: the running features build, and the originating feature opens", async () => {
      await run.phase("open", async () => {
        await run.openRunning();
        await dashboard.frame("team", "Who is working on what?", origin.owner, "/");

        const opened = await run.openFeature(origin, async (person) => {
          await dashboard.frame("start-waits", `Whose approval does ${display(origin.owner)}'s start wait for?`, person, "/inbox", (page) =>
            page.locator('section[aria-labelledby="approvals-overlaps"]'),
          );
        });
        expect(opened["feature"]["id"], "the opened feature").toBe(origin.id);
        await run.publish(origin, origin.commits[0] as CaseCommit);
        await dashboard.frame("open", `Can ${display(origin.owner)} start?`, origin.owner, featurePath(origin.id), CaseRun.sections.declaration);

        // The originating agent asks what is near, then the impact graph and the checks on its checkpoint.
        await run.originAgent.call("whats_near", { scopes: [...origin.area.scopes] });
        const runs = await run.askTools(["impact", "check"]);
        const check = runs.find((each) => each["tool"] === "check");
        run.firstCheck = (check?.["decisions"] ?? []).map((decision: Record<string, any>) => ({
          target: decision["target"],
          check: decision["check"],
          step: decision["step"],
          actor: decision["actor"],
        }));
      });
    });

    test("2. plan: the originating agent proposes one fix per affected place", async () => {
      test.skip(fixture.split !== null, "a split case lands its expand instead of a merge plan");
      await run.phase("plan", async () => {
        // The agent reports its commits up to the plan, so the plan's checkpoint defines every symbol
        // the parts import (PRD case 2: start_of_local_day() is checked in before the plan).
        await run.publishOriginUpTo((commit) => commit.revises !== null);
        run.onReturned = async () => {
          await dashboard.frame("returned", `Why did the plan go back to ${display(origin.owner)}?`, origin.owner, "/inbox", (page) =>
            page.locator('section[aria-labelledby="approvals-returned"]'),
          );
        };
        const plan = await run.proposePlan();
        // A plan over the break limit goes back to its person: the case ends there, as the system leaves it.
        if (run.returned !== undefined) return;
        expect(plan["parts"].length, "one part per affected place").toBe(run.placesAtPlanTime);
        await dashboard.frame("plan", "Whose work does the change break?", origin.owner, featurePath(origin.id), CaseRun.sections.plan);
      });
    });

    test("3. advance notice: each author's agent reviews, and each author decides on the dashboard", async () => {
      test.skip(fixture.split !== null || run.returned !== undefined, "a split case has no merge plan, or the plan was returned over the break limit");
      await run.phase("advance notice", async () => {
        const parts = [...run.parts.values()];
        // Nobody else decides a part: another person's approval and a body naming its approver are refused.
        const target = parts[0] as (typeof parts)[number];
        const outsider = fixture.people.find((person) => person.id !== target.owner && person.id !== origin.owner) ?? fixture.people.find((person) => person.id !== target.owner);
        await dashboard.signIn(outsider?.id as string);
        const forged = await dashboard.post("/api/plan-parts/approve", { feature: origin.id, part: target.partId, revision: target.revision });
        expect(forged.status, "an approval by someone who does not own the part").not.toBe(200);
        await dashboard.signIn(target.owner);
        const named = await dashboard.post("/api/plan-parts/approve", { feature: origin.id, part: target.partId, revision: target.revision, approvedBy: target.owner });
        expect(named.status, "an approval that names its own approver").not.toBe(200);
        run.notes.push(`A forged approval of ${target.partId} by ${outsider?.id} answered HTTP ${forged.status}; an approval naming its approver answered HTTP ${named.status}.`);

        await run.review();
        const asking = new Set(parts.filter((part) => run.asksForChange(part)).map((part) => part.owner));
        let reviewShown = false;
        for (const part of parts.filter((each) => !asking.has(each.owner))) {
          const decided = await run.decidedPart(part.partId);
          if (decided === "penguin") {
            const state = await dashboard.partState({ feature: origin.id, partId: part.partId });
            expect(state.approvedBy, `${part.partId}: a part approved before its author acted is Penguin's approval`).toBe(PENGUIN_APPROVER);
            run.notes.push(`Penguin approved ${part.partId} for ${part.owner}: every check was clean.`);
            continue;
          }
          const waiting = decided;
          // With no change asked for in the case, the review frame shows the first reviewed part its author approves.
          if (asking.size === 0 && !reviewShown && waiting.reviews.length > 0) {
            await dashboard.frame("review", `What does ${display(part.owner)}'s review show?`, part.owner, "/inbox", () => dashboard.planCard(waiting.feature));
            reviewShown = true;
          }
          await dashboard.approvePart(part.owner, waiting);
        }
        await dashboard.frame("approvals", "Who has approved?", origin.owner, featurePath(origin.id), CaseRun.sections.plan);

        // An author whose part the case revises asks for a change after each review, until the last revision.
        for (const part of parts.filter((each) => run.asksForChange(each))) {
          let waiting = await run.waitingPart(part.partId);
          await dashboard.frame("review", `Why does ${display(part.owner)} ask ${display(origin.owner)} for a change?`, part.owner, "/inbox", () => dashboard.planCard(waiting.feature));
          await dashboard.requestChange(part.owner, waiting, run.changeText(waiting));
          for (;;) {
            const revised = await run.revise(part.partId);
            await run.review(new Set(revised.scopes));
            waiting = await run.waitingPart(part.partId);
            const more = run.asksForChange(revised);
            await dashboard.frame(
              more ? "revision" : "revision-passes",
              `Did revision ${waiting.revision} fix it?`,
              part.owner,
              "/inbox",
              () => dashboard.planCard(waiting.feature),
            );
            if (!more) break;
            await dashboard.requestChange(part.owner, waiting, run.changeText(waiting));
          }
          await dashboard.approvePart(part.owner, waiting);
        }
        for (const part of parts.filter((each) => asking.has(each.owner) && !run.asksForChange(each))) {
          const current = await dashboard.partState({ feature: origin.id, partId: part.partId });
          if (current.state !== "approved") await dashboard.approvePart(part.owner, await run.waitingPart(part.partId));
        }

        // A running feature that starts touching the plan's area midway gains a part, which its person approves.
        for (const feature of fixture.features.filter((each) => each.role === "midway")) {
          const part = await run.joinMidway(feature);
          await dashboard.approvePart(part.owner, await run.waitingPart(part.partId));
          await dashboard.frame("midway", `What did ${display(feature.owner)}'s checkpoint add to the plan?`, origin.owner, featurePath(origin.id), CaseRun.sections.plan);
        }
        // A late starter receives the announced plan when it opens.
        for (const feature of fixture.features.filter((each) => each.role === "late-starter")) {
          const opened = await run.openFeature(feature);
          const handed = (opened["announcedPlans"] ?? []) as { feature: string }[];
          expect(handed.map((plan) => plan.feature), `${feature.id} receives the plan at open`).toContain(origin.id);
          await run.publish(feature, fixture.checkpointsOf(feature)[0] as CaseCommit);
          run.notes.push(`${feature.id} opened after the plan and received ${handed.length} announced plan(s) at open.`);
        }
        for (const part of run.parts.values()) {
          expect((await dashboard.partState({ feature: origin.id, partId: part.partId })).state, `${part.partId}`).toBe("approved");
        }
      });
    });

    test("4. build: the originating agent writes each approved fix into the affected fork", async () => {
      test.skip(fixture.split !== null || run.returned !== undefined, "a split case has no merge plan, or the plan was returned over the break limit");
      await run.phase("build", async () => {
        await run.writeFixes();
        for (const write of run.fixWrites) expect(write.matchesFixture, `${write.part} in ${write.fork} is the fixture's fix`).toBe(true);
        if (run.fixWrites.length > 0) {
          await dashboard.frame("fixes", "Where do the fixes go?", origin.owner, featurePath(origin.id), CaseRun.sections.fixes);
        }
      });
    });

    test("5. land: the block passes every check and main moves in one push", async () => {
      test.skip(fixture.split !== null || run.returned !== undefined, "a split case has no merge plan, or the plan was returned over the break limit");
      await run.phase("land", async () => {
        await run.publishOriginUpTo(() => false);
        const head = run.published.get(origin.id) as string;
        const refusal = await run.originAgent.pushRefusedOn("base", head);
        expect(refusal, "an agent's fork token pushing to main").not.toBe("pushed");
        run.notes.push(`The originating agent's fork token pushing to main was refused: ${refusal}`);

        const [check] = await run.askTools(["check"]);
        await dashboard.frame("block-checks", "Is it safe to promote?", origin.owner, featurePath(origin.id), CaseRun.sections.checks);
        const failing = (check?.["checks"] ?? []).filter((each: { result: string }) => each.result === "fail" || each.result === "error");
        if (failing.length > 0) run.notes.push(`The originating agent's last check before landing had ${failing.length} failing checks.`);

        const landed = await run.land(origin);
        expect(landed["promotion"]["mainAfter"], "main moved to the originating checkpoint").toBe(head);
        await dashboard.frame("promoted", "How does it end?", origin.owner, featurePath(origin.id));
        const tokenRefusal = await run.originAgent.refused("feature_token", { feature: origin.id });
        run.notes.push(`After the promotion, feature_token on the landed fork answered ${tokenRefusal["error"]}.`);
      });
    });

    test("2. expand: the expand checkpoint reaches main on its own and the old names retire", async () => {
      test.skip(fixture.split === null, "the case keeps a merge plan");
      await run.phase("expand", async () => {
        const plan = await run.proposeExpand();
        expect(plan["parts"].length, "the expand reaches no place").toBe(0);
        await run.landExpand(async (person) => {
          await dashboard.frame("expand-waits", `Why does ${display(origin.owner)}'s expand wait for ${display(person)}?`, person, "/inbox", (page) =>
            page.locator('section[aria-labelledby="approvals-overlaps"]'),
          );
        });
        await dashboard.frame("expand", "What reached main first?", origin.owner, featurePath(origin.id), CaseRun.sections.declaration);
      });
    });

    test("3. migrate: Penguin proposes one migration plan per owner, and each owner's code moves over", async () => {
      test.skip(fixture.split === null, "the case keeps a merge plan");
      await run.phase("migrate", async () => {
        const plans = await run.migrationPlans();
        run.notes.push(`Penguin proposed ${plans.length} migration plans after the expand, one per owner group.`);
        await dashboard.frame("migrations", "Who moves which code off the old names?", origin.owner, featurePath(origin.id), CaseRun.sections.plan);
        // A running feature that adds a call to a retiring name midway gets the replacement as its next step.
        for (const feature of fixture.features.filter((each) => each.role === "midway")) {
          const [, next] = fixture.checkpointsOf(feature);
          if (next === undefined) continue;
          const answer = await run.publish(feature, next);
          run.notes.push(`${feature.id}'s checkpoint answered with ${JSON.stringify(answer["nextSteps"] ?? answer["retiring"] ?? null).slice(0, 600)}.`);
          await dashboard.frame("midway", `What did ${display(feature.owner)}'s checkpoint add to the migration?`, origin.owner, featurePath(origin.id), CaseRun.sections.plan);
        }
        // A feature opened after the expand starts from main with the new names in place.
        for (const feature of fixture.features.filter((each) => each.role === "late-starter")) {
          await run.openFeature(feature);
          await run.publish(feature, fixture.checkpointsOf(feature)[0] as CaseCommit);
        }
        // Each running feature's builder writes its own migration; each owner's steward lands the block for code on main.
        // Penguin's blocks for code on main land below; features main already holds run no session.
        const running = fixture.features.filter((each) => each.role !== "migration" && !fixture.promotions.includes(each.id));
        for (const feature of running.filter((each) => fixture.migrationOf(each) !== undefined)) await run.migrateFeature(feature);
        for (const block of fixture.blocks) {
          await run.landBlock(block, async (commit) => {
            const revision = commit.revises !== null;
            await dashboard.frame(revision ? "revision-passes" : "review", `What does ${display(block.owner)}'s review of ${commit.tag} show?`, block.owner, "/inbox");
          });
        }
      });
    });

    test("5. contract: with no caller left, the old names leave main", async () => {
      test.skip(fixture.split === null, "the case keeps a merge plan");
      await run.phase("contract", async () => {
        const landed = await run.contract();
        expect(landed["state"], "the contract landed").toBe("landed");
        await dashboard.frame("promoted", "How does it end?", origin.owner, featurePath(origin.id));
      });
    });

    test("6. metrics: the run writes the PRD section 11 metrics", async () => {
      const metrics = await run.writeResults();
      expect(metrics.mainBreaks.value, "main breaks").toBe(0);
    });
  });
}
