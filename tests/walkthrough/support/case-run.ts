/**
 * One case of PRD 0.4 section 1 run through the real system, phase by phase: open, plan, advance
 * notice, build and land. Agents are scripted MCP sessions; people decide on the dashboard in the
 * browser; the check runner runs in-process. Every feature, commit, part, form and person comes from
 * the case's fixture (fixture.ts) or the system's answers; the run records what PRD section 11 counts
 * (metrics.ts) and captures the frames of docs/demo-story.md from the dashboard as the person each
 * frame names.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Browser, BrowserContext, Page } from "@playwright/test";

import { Runner } from "../../e2e/support/runner.ts";
import { Dashboard, type PartRequest } from "./dashboard.ts";
import { CaseFixture, loginOf, type CaseCommit, type CaseFeature } from "./fixture.ts";
import { caseMetrics, metricsReport, type CaseEvidence, type FixWriteEvidence, type LadderDecision, type PromotionCheck } from "./metrics.ts";
import { POLLING_TOOLS, Person, type AgentSession } from "./person.ts";
import { LocalStack } from "./stack.ts";

const run = promisify(execFile);

/** How long the run waits for the check runner or the system to reach a state it expects. */
const WAIT_MS = 20 * 60_000;
/** How many agents commit at once. */
const CONCURRENT_AGENTS = 6;

const section = (id: string) => (page: Page) => page.locator(`section[aria-labelledby="feature-${id}"]`);

async function inBatches<T>(items: readonly T[], size: number, step: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) await Promise.all(items.slice(start, start + size).map(step));
}

/** A plan part as propose_plan, revise_plan_part and the plan route answer it. */
interface StoredPart {
  readonly partId: string;
  readonly revision: number;
  readonly place: { readonly kind: string; readonly scope?: string; readonly feature?: string };
  readonly owner: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly diff: { readonly base: string | null; readonly commit: string | null };
  readonly approvalState?: string;
}

export interface CaseRunOptions {
  readonly repoRoot: string;
  readonly python: string;
  readonly fixture: CaseFixture;
  readonly prefix: string;
  readonly outDir: string;
}

export class CaseRun {
  readonly fixture: CaseFixture;
  readonly options: CaseRunOptions;
  stack!: LocalStack;
  runner!: Runner;
  dashboard!: Dashboard;
  #context: BrowserContext | undefined;
  #root = "";
  #fixtureRepo = "";
  readonly people = new Map<string, Person>();
  /** The SHA each feature's fork last published. */
  readonly published = new Map<string, string>();
  readonly runnerLog: string[] = [];
  readonly phases: { phase: string; startedAt: string; ms: number }[] = [];
  readonly promotions: PromotionCheck[] = [];
  readonly fixWrites: FixWriteEvidence[] = [];
  readonly notes: string[] = [];
  /** The plan's parts as last stored or revised, by part id. */
  readonly parts = new Map<string, StoredPart>();
  placesAtPlanTime = 0;
  firstCheck: LadderDecision[] = [];
  /** When the originating agent asked for its first `check`: the start of the agent-calls window. */
  #checkAskedAt = 0;
  #promotedAt = 0;
  /** Each revision commit already answered, by part scope. */
  readonly #revisionsUsed = new Map<string, number>();
  /** The review form round each reviewing scope is on. */
  readonly #reviewRound = new Map<string, number>();

  constructor(options: CaseRunOptions) {
    this.options = options;
    this.fixture = options.fixture;
  }

  get origin(): CaseFeature {
    return this.fixture.origin;
  }

  person(id: string): Person {
    const person = this.people.get(id);
    if (person === undefined) throw new Error(`no machine for ${id}`);
    return person;
  }

  session(feature: CaseFeature | string): AgentSession {
    const id = typeof feature === "string" ? feature : feature.id;
    return this.person(this.fixture.personOf(id)).session(id);
  }

  get originAgent(): AgentSession {
    return this.session(this.origin);
  }

  async phase<T>(name: string, step: () => Promise<T>): Promise<T> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      return await step();
    } catch (error) {
      this.notes.push(`The ${name} phase stopped: ${(error as Error).message.slice(0, 1_500)}`);
      throw error;
    } finally {
      this.phases.push({ phase: name, startedAt, ms: Math.round(performance.now() - started) });
    }
  }

  /** One check runner pass with every test job: facts runs, reviews, tool runs, fix writes and block runs. */
  async pass(): Promise<void> {
    try {
      const summary = await this.runner.pass(["--combined", "--repo", join(this.#root, "runner-repo"), "--python", this.options.python]);
      this.runnerLog.push(summary);
      // A run that stopped partway stays claimed until its 30-minute lease ends; the case stops here.
      const stopped = /^.*stopped; it runs again after its lease.*$/mu.exec(summary)?.[0];
      if (stopped !== undefined) this.#stopped = stopped.replace(/https:\/\/[^\s/]+\/git\/[^\s/]+\//gu, "<artifacts>/");
    } catch (error) {
      this.runnerLog.push((error as Error).message);
      this.#runnerError = (error as Error).message;
    }
  }

  /** The last runner pass that failed, named when a wait runs out. */
  #runnerError = "";
  /** The runner's report of a run that stopped partway, which ends the wait at once. */
  #stopped: string | undefined;

  /** Runs `step` until it returns a value, with a runner pass between tries. */
  async until<T>(what: string | (() => string), step: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const value = await step();
      if (value !== undefined) return value;
      if (this.#stopped !== undefined) throw new Error(`${typeof what === "string" ? what : what()} stopped: the check runner reported: ${this.#stopped.slice(0, 2_000)}`);
      if (Date.now() > deadline) {
        const failed = this.#runnerError === "" ? "" : `; the last failed runner pass: ${this.#runnerError.slice(0, 2_000)}`;
        throw new Error(`${typeof what === "string" ? what : what()} did not happen within ${WAIT_MS} ms${failed}`);
      }
      await this.pass();
    }
  }

  // Setup -------------------------------------------------------------------------------------------

  async setUp(browser: Browser): Promise<void> {
    this.#root = await mkdtemp(join(tmpdir(), "penguin-walkthrough-case-"));
    this.#fixtureRepo = join(this.#root, "fixture");
    await this.fixture.build(this.options.python, this.#fixtureRepo);
    const owners = this.fixture.people.map((person) => person.id);
    this.stack = await LocalStack.start({
      repoRoot: this.options.repoRoot,
      prefix: this.options.prefix,
      owners,
      login: loginOf,
      logFile: join(this.options.outDir, "worker.log"),
    });
    await this.stack.deployer.setUp(owners);
    await this.stack.seedBase(this.#fixtureRepo, this.fixture.baseSha, "main");
    const setUp = await this.stack.deployer.setUp(owners);
    if (!setUp.complete) throw new Error(`project setup is incomplete: ${JSON.stringify(setUp.repos)}`);
    this.runner = await Runner.register(this.stack.url, "runner", await this.stack.deployer.bridgeCode("runner", "runner"));
    this.#context = await browser.newContext();
    this.dashboard = new Dashboard(await this.#context.newPage(), this.stack.url, this.options.outDir);
    // Each person signs in and creates the identities the fixture gives them; their machine registers a bridge.
    for (const person of this.fixture.people) {
      await this.dashboard.signIn(person.id);
      for (const identity of this.fixture.identities.filter((candidate) => candidate.owner === person.id)) {
        const created = await this.dashboard.post("/api/identities", {
          handle: identity.handle,
          name: identity.handle.split("/")[1],
          job: identity.job.slice(0, 1_000),
          charterScopes: identity.charter_scopes,
          autoAccept: true,
        });
        if (created.status !== 201) throw new Error(`${identity.handle}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
      }
      this.people.set(person.id, await Person.set(this.stack.url, this.stack.deployer, person.id, this.#fixtureRepo));
    }
  }

  async tearDown(): Promise<string[]> {
    // Remote URLs name the account; the log keeps the repo name only.
    await writeFile(join(this.options.outDir, "runner.log"), this.runnerLog.join("\n").replace(/https:\/\/[^\s/]+\/git\/[^\s/]+\//gu, "<artifacts>/"));
    await this.#context?.close();
    for (const person of this.people.values()) if (this.stack !== undefined) await person.dispose(this.stack.deployer);
    if (this.runner !== undefined) {
      await this.stack.deployer.revokeBridge(this.runner.bridgeId).catch(() => undefined);
      await this.runner.dispose();
    }
    const deleted = this.stack === undefined ? [] : await this.stack.stop();
    if (this.#root !== "") await rm(this.#root, { recursive: true, force: true });
    return deleted;
  }

  // Open --------------------------------------------------------------------------------------------

  /** Starts `feature`'s agent session and opens the feature; each lock on it is approved by its person on the dashboard. */
  async openFeature(feature: CaseFeature, onLock?: (person: string, covering: string) => Promise<void>): Promise<Record<string, any>> {
    const session = await this.person(feature.owner).startSession(feature, this.fixture.identity(feature.handle));
    const opened = await session.open();
    for (const lock of (opened["waitingOn"] ?? []) as { feature: string; person: string }[]) {
      await onLock?.(lock.person, lock.feature);
      await this.dashboard.approveStart(lock.person, lock.feature, feature.id);
    }
    return opened;
  }

  async publish(feature: CaseFeature, commit: CaseCommit): Promise<Record<string, any>> {
    const answer = await this.session(feature).publish(commit.sha);
    this.published.set(feature.id, commit.sha);
    return answer;
  }

  /**
   * Every feature that runs before the originating one opens, one at a time so the overlap check
   * sees them in the fixture's order, then publishes its first checkpoint, several agents at once.
   */
  async openRunning(): Promise<void> {
    const early = this.fixture.features.filter((feature) => feature !== this.origin && feature.role !== "late-starter" && feature.start === "base");
    for (const feature of early) await this.openFeature(feature);
    await inBatches(early, CONCURRENT_AGENTS, async (feature) => {
      await this.publish(feature, this.fixture.checkpointsOf(feature)[0] as CaseCommit);
    });
  }

  /** Lands each feature the fixture promotes before the originating feature opens, as its agent asks. */
  async landPromotions(): Promise<void> {
    for (const id of this.fixture.promotions) await this.land(this.fixture.feature(id));
  }

  /** The feature's agent lands it; every scope's tests then run on main's new head. */
  async land(feature: CaseFeature): Promise<Record<string, any>> {
    const session = this.session(feature);
    const asked = await session.call("land_feature", { feature: feature.id });
    let last: unknown;
    const landing = await this.until(() => `${feature.id}'s landing (last read: ${JSON.stringify(last).slice(0, 3_000)})`, async () => {
      const current = (await session.work())["landing"];
      last = current;
      if (current?.state === "landed") return current;
      // Only this land's run counts: an earlier plan check of the same feature may have failed before the fixes were written.
      const failed = current?.runs?.find(
        (each: { state: string; purpose: string; runId: string }) =>
          each.purpose === "land" && (asked["runId"] === undefined || each.runId === asked["runId"]) && (each.state === "failed" || each.state === "raced"),
      );
      if (failed !== undefined && current?.state !== "checking" && current?.state !== "promoting") {
        throw new Error(`${feature.id}'s block failed: ${JSON.stringify(failed).slice(0, 3_000)}`);
      }
      return undefined;
    });
    const mainAfter = await this.person(feature.owner).headOf("base");
    this.promotions.push({ feature: feature.id, mainBefore: asked["mainBefore"], mainAfter, redScopes: await this.person(feature.owner).redScopes(mainAfter) });
    this.#promotedAt = Date.now();
    return landing;
  }

  // Plan --------------------------------------------------------------------------------------------

  /** The originating agent's tool requests on its checkpoint, answered by the runner and delivered at its next safe checkpoint. */
  async askTools(tools: readonly ("impact" | "check")[]): Promise<Record<string, any>[]> {
    const agent = this.originAgent;
    const asked = [];
    for (const tool of tools) {
      if (tool === "check" && this.#checkAskedAt === 0) this.#checkAskedAt = Date.now();
      asked.push(await agent.call(tool, { feature: this.origin.id }));
    }
    const ids = new Set(asked.map((answer) => answer["recordedAs"]));
    const runs = await this.until("the check runner's tool runs", async () => {
      const page = await this.featurePage(this.origin.id);
      const done = (page.tools as { id: number; completedAt: string | null }[]).filter((run) => ids.has(run.id) && run.completedAt !== null);
      return done.length === ids.size ? done : undefined;
    });
    await agent.report(this.published.get(this.origin.id) as string);
    return runs as Record<string, any>[];
  }

  async featurePage(featureId: string, as: string = this.origin.owner): Promise<any> {
    await this.dashboard.signIn(as);
    return this.dashboard.get(`/api/features/${encodeURIComponent(featureId)}/page`);
  }

  /** The fix the originating agent proposes for one affected place, from the fixture's commits. */
  async partFor(place: { kind: string; scope?: string; feature?: string }, heads: ReadonlyMap<string, string>): Promise<Record<string, unknown>> {
    if (place.kind === "scope") {
      const commit = this.origin.commits.find((candidate) => candidate.fix?.scope === place.scope);
      if (commit === undefined) throw new Error(`the fixture holds no fix in ${this.origin.id} for ${place.scope}`);
      return { place: { scope: place.scope }, diff: { commit: commit.sha } };
    }
    return { place: { feature: place.feature }, patch: await this.featurePatch(this.fixture.feature(place.feature as string), heads.get(place.feature as string)) };
  }

  /** A running feature's fixture fix as a patch against its fork head, inside its declared scopes. */
  async featurePatch(feature: CaseFeature, head: string | undefined = this.published.get(feature.id)): Promise<{ base: string; diff: string }> {
    const fix = this.fixture.fixOf(feature);
    if (fix === undefined || head === undefined) throw new Error(`the fixture holds no fix for ${feature.id}`);
    return { base: head, diff: await this.diff(head, fix.sha, this.fixture.pathsOf(feature)) };
  }

  async diff(from: string, to: string, paths: readonly string[]): Promise<string> {
    const { stdout } = await run("git", ["-C", this.#fixtureRepo, "diff", from, to, "--", ...paths], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  /**
   * propose_plan as an agent uses it: ask once to start the facts run, ask again once the runner
   * reported to learn every affected place, then send one part per place.
   */
  async proposePlan(): Promise<Record<string, any>> {
    const agent = this.originAgent;
    const ask = (parts: unknown[]) => agent.answer("propose_plan", { feature: this.origin.id, parts });
    const facts = await this.until("the plan's facts run", async () => {
      const answer = await ask([]);
      const waiting = answer.value["missing"]?.some((item: { code: string }) => item.code === "waiting_for_runner");
      return waiting ? undefined : answer.value;
    });
    if (facts["status"] !== "missing") throw new Error(`a plan with no parts was not missing places: ${JSON.stringify(facts).slice(0, 2_000)}`);
    const places = (facts["missing"] as { code: string; place?: { kind: string } }[]).filter((item) => item.code === "no_part").map((item) => item.place as { kind: string });
    const unexpected = (facts["missing"] as { code: string }[]).filter((item) => item.code !== "no_part");
    if (unexpected.length > 0) throw new Error(`the facts named more than missing parts: ${JSON.stringify(unexpected).slice(0, 2_000)}`);
    this.placesAtPlanTime = places.length;
    const heads = new Map((facts["facts"]["affectedFeatures"] as { feature: string; head: string }[]).map((each) => [each.feature, each.head]));
    const parts = await Promise.all(places.map((place) => this.partFor(place, heads)));
    const answer = (await ask(parts)).value;
    if (answer["status"] === "returned") {
      // Over the project's break limit Penguin returns the plan to its person to split (PRD 4.2 step 5).
      // The walkthrough keeps the project's setting: the case ends here, as the system leaves it.
      this.returned = answer;
      this.notes.push(
        `The plan was returned over the break limit of ${answer["breakLimit"]}: ${(answer["behavioural"] as unknown[]).length} behavioural parts of ${parts.length}. The case stops at the returned plan; nothing was promoted.`,
      );
      await this.onReturned?.(answer);
      return answer;
    }
    if (answer["status"] !== "stored") throw new Error(`the plan was not stored: ${JSON.stringify(answer).slice(0, 3_000)}`);
    for (const part of answer["parts"] as StoredPart[]) this.parts.set(part.partId, part);
    return answer;
  }

  /** Called with a returned plan's answer, for its frame. */
  onReturned: ((answer: Record<string, any>) => Promise<void>) | undefined;
  /** The answer that returned the plan over the break limit, when it was returned. */
  returned: Record<string, any> | undefined;

  // Advance notice ----------------------------------------------------------------------------------

  /** The session of `person` whose identity is chartered on `scope`: the agent that reviews it. */
  reviewerOf(person: string, scope: string): AgentSession | undefined {
    const sessions = [...this.person(person).sessions.values()];
    return sessions.find((session) => session !== this.originAgent && session.identity.charter_scopes.includes(scope));
  }

  /**
   * Each affected author's agent reads its parts through get_work and submits the scope's review
   * form for the round the part is on; the runner then records each review. Returns the review ids.
   */
  async review(scopes: ReadonlySet<string> | undefined = undefined): Promise<number[]> {
    const submitted: number[] = [];
    const reviewed = new Set<string>();
    for (const part of this.parts.values()) {
      for (const scope of part.scopes) {
        if (reviewed.has(scope) || (scopes !== undefined && !scopes.has(scope))) continue;
        const forms = this.fixture.formsFor(scope);
        const agent = this.reviewerOf(part.owner, scope);
        if (forms.length === 0 || agent === undefined) continue;
        const work = await agent.work();
        const asked = (work["planPartsNeedingYou"] as { feature: string; scopes: string[] }[]).some((each) => each.feature === this.origin.id && each.scopes.includes(scope));
        if (!asked) continue;
        reviewed.add(scope);
        const round = this.#reviewRound.get(scope) ?? 0;
        const form = forms[Math.min(round, forms.length - 1)]?.form;
        this.#reviewRound.set(scope, round + 1);
        const answer = await agent.answer("submit_review", { feature: this.origin.id, scope, form: { riskyInputs: [], storedDataMarker: null, ...form } });
        if (answer.isError && answer.value["state"] !== "refused") throw new Error(`${agent.identity.handle}'s review was refused: ${JSON.stringify(answer.value).slice(0, 1_500)}`);
        if (answer.value["state"] === "refused") this.notes.push(`${agent.identity.handle}'s form for ${scope} was refused at submission: ${JSON.stringify(answer.value["refusals"]).slice(0, 600)}`);
        else submitted.push(answer.value["reviewId"]);
      }
    }
    const ids = new Set(submitted);
    await this.until("the runner's review records", async () => {
      const page = await this.featurePage(this.origin.id);
      const done = (page.reviews as { reviewId: number; state: string }[]).filter((each) => ids.has(each.reviewId) && each.state !== "pending");
      return done.length === ids.size ? true : undefined;
    });
    return submitted;
  }

  /** The revision commits of the originating feature that answer requests on `scope`'s part, in order. */
  revisionsFor(scope: string | undefined): CaseCommit[] {
    return scope === undefined ? [] : this.origin.commits.filter((commit) => commit.revises?.scope === scope);
  }

  /** Whether the case has its author ask for (another) change to this part. */
  asksForChange(part: StoredPart): boolean {
    const scope = part.place.kind === "scope" ? part.place.scope : undefined;
    return this.revisionsFor(scope).length > (this.#revisionsUsed.get(scope ?? "") ?? 0);
  }

  /** The part as the person it waits on reads it in the inbox. */
  async waitingPart(partId: string): Promise<PartRequest> {
    const owner = (this.parts.get(partId) as StoredPart).owner;
    const found = (await this.dashboard.partsWaiting(owner)).find((each) => each.partId === partId && each.ask === "approve");
    if (found === undefined) throw new Error(`${partId} does not wait on ${owner}`);
    return found;
  }

  /** The change an author asks for, in the words of the newest review's side-by-side run on the part. */
  changeText(part: PartRequest): string {
    const review = part.reviews.at(-1);
    const differing = review?.["sideBySide"]?.totals?.differing ?? 0;
    const broken = (review?.["rows"] as { statement: string; verdict: string }[] | undefined)?.find((row) => row.verdict === "breaks")?.statement;
    const protectedRow = (review?.["rows"] as { statement: string; protected: boolean }[] | undefined)?.find((row) => row.protected)?.statement;
    const statement = broken ?? protectedRow ?? "the invariant";
    return `The side-by-side run differs on ${differing} inputs, so "${statement}" does not hold yet. Please change your fix so that it holds.`;
  }

  /**
   * The originating agent answers the requested change on `partId` with the fixture's next revision
   * commit: it publishes the commit and names it in revise_plan_part against the part's first base.
   */
  async revise(partId: string): Promise<StoredPart> {
    const part = this.parts.get(partId) as StoredPart;
    const scope = part.place.scope as string;
    const used = this.#revisionsUsed.get(scope) ?? 0;
    const commit = this.revisionsFor(scope)[used] as CaseCommit;
    this.#revisionsUsed.set(scope, used + 1);
    await this.publish(this.origin, commit);
    const own = (await this.originAgent.work())["plan"]["parts"].find((each: { part: string }) => each.part === partId);
    if (own?.state !== "change_requested") throw new Error(`${partId} is ${own?.state}, not change_requested`);
    const revised = await this.originAgent.call("revise_plan_part", {
      feature: this.origin.id,
      part: partId,
      revision: own.revision,
      diff: { commit: commit.sha, ...(part.diff.base === null ? {} : { base: part.diff.base }) },
    });
    const next = revised["part"] as StoredPart;
    this.parts.set(partId, next);
    return next;
  }

  /**
   * A running feature joins the plan midway: its agent publishes its next checkpoint, Penguin adds a
   * part for it, and the originating agent answers Penguin's request with the feature's fix as a patch.
   */
  async joinMidway(feature: CaseFeature): Promise<StoredPart> {
    const [, next] = this.fixture.checkpointsOf(feature);
    if (next === undefined) throw new Error(`${feature.id} has no later checkpoint`);
    const answer = await this.publish(feature, next);
    if ((answer["plansJoined"] as unknown[]).length === 0) throw new Error(`${feature.id}'s checkpoint joined no plan: ${JSON.stringify(answer).slice(0, 1_500)}`);
    const own = await this.until(`the part Penguin adds for ${feature.id}`, async () => {
      const parts = (await this.originAgent.work())["plan"]["parts"] as { part: string; revision: number; place: { feature?: string }; state: string }[];
      return parts.find((each) => each.place.feature === feature.id && each.state === "change_requested");
    });
    const revised = await this.originAgent.call("revise_plan_part", {
      feature: this.origin.id,
      part: own.part,
      revision: own.revision,
      patch: await this.featurePatch(feature),
    });
    const part = revised["part"] as StoredPart;
    this.parts.set(part.partId, part);
    return part;
  }

  /**
   * The originating agent pushes its fixture commits before the first one `predicate` names and,
   * unless `report` is false, reports the last as a checkpoint. Returns that commit.
   */
  async publishOriginUpTo(predicate: (commit: CaseCommit) => boolean, report = true): Promise<CaseCommit | undefined> {
    const commits = this.origin.commits;
    const stop = commits.findIndex(predicate);
    const last = commits[(stop === -1 ? commits.length : stop) - 1];
    if (last === undefined || this.published.get(this.origin.id) === last.sha) return last;
    if (report) await this.publish(this.origin, last);
    else await this.originAgent.push(last.sha);
    return last;
  }

  // Build -------------------------------------------------------------------------------------------

  /** Writes every approved part for a running feature into its fork: the agent's behavioural parts, the runner's mechanical ones. */
  async writeFixes(): Promise<void> {
    for (const part of this.parts.values()) {
      if (part.place.kind !== "feature") continue;
      const feature = this.fixture.feature(part.place.feature as string);
      let commit: string;
      let writer: string;
      if (part.kind === "behavioural") {
        const reported = await this.originAgent.writeFix(part.partId, part.revision);
        commit = reported["commit"];
        writer = this.originAgent.identity.handle;
      } else {
        const written = await this.until(`the runner's write of ${part.partId}`, async () => {
          const page = await this.featurePage(this.origin.id);
          const fix = (page.fixes as { partId: string; write: { state: string; commit: string | null } | null }[]).find((each) => each.partId === part.partId);
          return fix?.write?.state === "written" ? fix.write : undefined;
        });
        commit = written.commit as string;
        writer = "check runner";
      }
      const owner = this.person(feature.owner);
      await owner.fetchRepo(`feature-${feature.id}`);
      const fix = this.fixture.fixOf(feature) as CaseCommit;
      const matches = (await owner.treeOf(commit)) === (await owner.treeOf(fix.sha));
      this.fixWrites.push({ part: part.partId, fork: `feature-${feature.id}`, writer, commit, matchesFixture: matches });
      // The affected feature's own agent takes the fix: its next checkpoint is the fork head that carries it.
      await this.session(feature).report(commit);
      this.published.set(feature.id, commit);
    }
  }

  // Evidence ----------------------------------------------------------------------------------------

  async evidence(): Promise<CaseEvidence> {
    const page = await this.featurePage(this.origin.id);
    const plan = await this.dashboard.get(`/api/features/${encodeURIComponent(this.origin.id)}/plan`);
    const agentCalls: Record<string, Record<string, number>> = {};
    for (const person of this.people.values()) {
      for (const session of person.sessions.values()) {
        const end = this.#promotedAt === 0 ? Date.now() : this.#promotedAt;
        const window = session.calls.filter((call) => call.at >= this.#checkAskedAt && call.at <= end && !POLLING_TOOLS.has(call.tool));
        if (window.length === 0) continue;
        const counts: Record<string, number> = {};
        for (const call of window) counts[call.tool] = (counts[call.tool] ?? 0) + 1;
        agentCalls[session.identity.handle] = counts;
      }
    }
    return {
      case: this.fixture.name,
      prefix: this.options.prefix,
      origin: { feature: this.origin.id, person: this.origin.owner, agent: this.origin.handle },
      phases: this.phases,
      promotions: this.promotions,
      records: page.records,
      parts: plan.parts.map((part: Record<string, any>) => ({
        partId: part.partId,
        kind: part.kind,
        revision: part.revision,
        approvalState: part.approvalState,
        changeRequests: part.changeRequests,
        place: part.place,
      })),
      placesAtPlanTime: this.placesAtPlanTime,
      firstCheck: this.firstCheck,
      agentCalls,
      fixWrites: this.fixWrites,
      reviewExceptions: (page.reviews as { scope: string; exceptions: { kind: string }[] }[])
        .filter((review) => review.exceptions.length > 0)
        .map((review) => ({ scope: review.scope, kinds: review.exceptions.map((exception) => exception.kind) })),
      notes: this.notes,
    };
  }

  /** Writes the case's results and metrics report; returns the metrics. */
  resultsWritten = false;

  async writeResults(): Promise<ReturnType<typeof caseMetrics>> {
    this.resultsWritten = true;
    const evidence = await this.evidence();
    const metrics = caseMetrics(evidence);
    await writeFile(join(this.options.outDir, "results.json"), `${JSON.stringify({ metrics, evidence, frames: this.dashboard.frames }, null, 2)}\n`);
    await writeFile(join(this.options.outDir, "metrics.md"), metricsReport(evidence, metrics, this.dashboard.frames));
    return metrics;
  }

  static readonly sections = { declaration: section("declaration"), plan: section("plan"), fixes: section("fixes"), checks: section("checks"), record: section("record") };
}
