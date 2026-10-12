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
 * Each case is one serial group of five phases and a metrics step. Each frame of docs/demo-story.md
 * is one screenshot from the dashboard as the person the frame names. Each case writes its frames,
 * `results.json`, `metrics.md`, `runner.log`, `worker.log` and `cleanup.json` to its own folder.
 */

import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CaseRun } from "./support/case-run.ts";
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
      if (run !== undefined && !run.resultsWritten) await run.writeResults().catch((error: Error) => run.notes.push(`results: ${error.message}`));
      const deleted = run === undefined ? [] : await run.tearDown();
      await writeFile(join(outDir, "cleanup.json"), `${JSON.stringify({ deletedRepos: deleted }, null, 2)}\n`);
    });

    test("1. open: the running features build, and the originating feature opens", async () => {
      await run.phase("open", async () => {
        await run.openRunning();
        await dashboard.frame("team", "Who is working on what?", origin.owner, "/");
        await run.landPromotions();

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
      await run.phase("plan", async () => {
        // The fixes for code on main go into the fork as commits; the plan's facts stay those of the
        // reported checkpoint, the change itself, and the plan names each fix commit.
        const planned = await run.publishOriginUpTo((commit) => commit.revises !== null, false);
        run.onReturned = async () => {
          await dashboard.frame("returned", `Why did the plan go back to ${display(origin.owner)}?`, origin.owner, "/inbox", (page) =>
            page.locator('section[aria-labelledby="approvals-returned"]'),
          );
        };
        const plan = await run.proposePlan();
        // A plan over the break limit goes back to its person: the case ends there, as the system leaves it.
        if (run.returned !== undefined) return;
        expect(plan["parts"].length, "one part per affected place").toBe(run.placesAtPlanTime);
        // The agent then reports the fixes as its checkpoint, the commit the authors' agents review.
        if (planned !== undefined && planned.sha !== run.published.get(origin.id)) await run.publish(origin, planned);
        await dashboard.frame("plan", "Whose work does the change break?", origin.owner, featurePath(origin.id), CaseRun.sections.plan);
      });
    });

    test("3. advance notice: each author's agent reviews, and each author decides on the dashboard", async () => {
      test.skip(run.returned !== undefined, "the plan was returned over the break limit");
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
          const waiting = await run.waitingPart(part.partId);
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
      test.skip(run.returned !== undefined, "the plan was returned over the break limit");
      await run.phase("build", async () => {
        await run.writeFixes();
        for (const write of run.fixWrites) expect(write.matchesFixture, `${write.part} in ${write.fork} is the fixture's fix`).toBe(true);
        if (run.fixWrites.length > 0) {
          await dashboard.frame("fixes", "Where do the fixes go?", origin.owner, featurePath(origin.id), CaseRun.sections.fixes);
        }
      });
    });

    test("5. land: the block passes every check and main moves in one push", async () => {
      test.skip(run.returned !== undefined, "the plan was returned over the break limit");
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

    test("6. metrics: the run writes the PRD section 11 metrics", async () => {
      const metrics = await run.writeResults();
      expect(metrics.mainBreaks.value, "main breaks").toBe(0);
    });
  });
}
