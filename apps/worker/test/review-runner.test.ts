// The check runner's reviews end to end (#101, PRD 0.4 sections 4.3 and 6), without the network. Jun's
// agent submits review forms on Priya's feature through the real `submit_review` MCP tool; runner mode
// claims them through the Worker's bridge routes, runs the review harness on the identity-unification
// fixture and reports each record. Nobody runs `penguin-bridge review` by hand.
//
// The fixture repo stands in for main and for Priya's feature fork. The test commits analytics'
// invariants, examples and contracts to main itself, as review-harness.test.ts does, so the cases it
// asserts on are its own. The feature's checkpoint is Priya's checkpoint merged onto that main.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runGit } from "@penguin/git-analysis";
import { generateSigningKeyPair } from "@penguin/issues";
import {
  claimReviews as claimReviewsOver,
  fetchRepoBranches,
  localRemote,
  pythonImpactAnalyzer,
  reportReview,
  reviewPass,
  runReview,
  type Fetch,
} from "@penguin/local-bridge";
import { serveMcp, type McpProject } from "@penguin/mcp";
import { parseScopeMap } from "@penguin/scope-map";

import { mcpFeatures, type FeatureDirectory, type FeaturePorts } from "../src/features.ts";
import { handleRequest, type GatewayHandlers } from "../src/gateway.ts";
import { RepoNames } from "../src/repos.ts";
import { BridgeRegistry } from "../../../services/project-agent/src/bridge-registry.ts";
import { checkpointBaseline } from "../../../services/project-agent/src/combined-run-schedule.ts";
import { FeatureStore, signFeatureRecord } from "../../../services/project-agent/src/feature-store.ts";
import { IdentityStore } from "../../../services/project-agent/src/identity-store.ts";
import { InboxStore } from "../../../services/project-agent/src/inbox-store.ts";
import { IssueIndex, type BridgeCaller } from "../../../services/project-agent/src/issue-index.ts";
import { claimReviews, recordReview } from "../../../services/project-agent/src/review-record.ts";
import { ReviewStore, submitReview } from "../../../services/project-agent/src/review-submit.ts";
import { importServiceKey, type ServiceKey } from "../../../services/project-agent/src/service-key.ts";
import { SessionStore } from "../../../services/project-agent/src/session-store.ts";
import { gitHistory } from "../../../services/project-agent/test/huddle-project.ts";
import { sqlite } from "../../../services/project-agent/test/issues-repo.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO_ROOT, "examples", "identity-unification");
const VENV_BIN = join(REPO_ROOT, ".venv", "bin");
const PYTHON = existsSync(join(VENV_BIN, "python")) ? join(VENV_BIN, "python") : "python3";
const SERVER = "https://penguin.example";
const OPTIONS = { deployerToken: "deployer-secret-for-tests" };
const PREFIX = "t-";
const FEATURE = "person-id";

const ANALYTICS = "analytics";
const DAU = "analytics/models.py::daily_active_users";
const IDENTITY_MAP = "ingestion/identity_map.py::IdentityMap";
const TABLET = "tablet-patrons-separate";
const ORDER = "days-in-date-order";
const EXAMPLES_FILE = "analytics/examples/daily_active_users.json";

const login = (ts: number, user: string, device: string) => ({ source: "mobile", type: "login", day: "2026-01-05", ts, user_id: user, device_id: device });
const dauArgs = (events: readonly object[]) => ({ events, identity_map: { $call: `${IDENTITY_MAP}.from_events`, args: { events } } });

const INVARIANTS = {
  invariants: [
    { id: TABLET, scope: ANALYTICS, statement: "Patrons who log in on one library tablet stay separate people", protected: true },
    { id: ORDER, scope: ANALYTICS, statement: "Daily active users are listed by day in date order", protected: false },
  ],
  examples: [{ scope: ANALYTICS, file: EXAMPLES_FILE, invariants: [TABLET] }],
};
const EXAMPLES = {
  contract: DAU,
  cases: [
    { name: "patrons on their own devices", args: dauArgs([login(1, "u1", "d1"), login(2, "u2", "d2")]) },
    { name: "three patrons on one library tablet", args: dauArgs([login(1, "u1", "tablet-7"), login(2, "u2", "tablet-7"), login(3, "u3", "tablet-7")]) },
  ],
};
const ORDER_ROW = {
  invariant: ORDER,
  verdict: "holds",
  evidence: ["analytics/tests/test_dau.py::test_days_are_counted_separately_in_date_order"],
  storedData: "None",
};
/** Jun's agent reports the tablet invariant broken and names the cutover marker for stored profiles. */
const BREAKS_FORM = {
  rows: [
    { invariant: TABLET, verdict: "breaks", evidence: ["ingestion/identity_map.py::IdentityMap::observe"], storedData: "Past days lose people" },
    ORDER_ROW,
  ],
  storedDataMarker: { kind: "cutover", evidence: "ingestion/identity_map.py::IdentityMap::person_id" },
};
/** A form that passes at submission and names no stored data marker. */
const HOLDS_FORM = {
  rows: [{ invariant: TABLET, verdict: "holds", evidence: ["analytics/tests/test_dau.py::test_distinct_users_each_count"], storedData: "Past days keep their counts" }, ORDER_ROW],
};

const GIT_ENV = { GIT_AUTHOR_NAME: "Penguin Test", GIT_AUTHOR_EMAIL: "test@penguin.invalid", GIT_COMMITTER_NAME: "Penguin Test", GIT_COMMITTER_EMAIL: "test@penguin.invalid" };

let root: string;
let fixture: string;
let main: string;
let checkpoint: string;
let service: ServiceKey;

before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  root = await realpath(await mkdtemp(join(tmpdir(), "penguin-review-runner-")));
  fixture = join(root, "fixture");
  await promisify(execFile)(PYTHON, [join(FIXTURE, "build.py"), fixture]);
  const git = (...args: string[]) => runGit(fixture, args, { env: GIT_ENV }).then((out) => out.trim());
  const scopes = JSON.parse(await readFile(join(fixture, "penguin", "scopes.json"), "utf8"));
  for (const scope of scopes.scopes) {
    if (scope.id === ANALYTICS) scope.contracts = [DAU];
    if (scope.id === "identity-map") scope.contracts = [IDENTITY_MAP];
  }
  const files: Record<string, unknown> = { "penguin/scopes.json": scopes, "penguin/invariants.json": INVARIANTS, [EXAMPLES_FILE]: EXAMPLES };
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await writeFile(join(fixture, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  await git("add", "--", ...Object.keys(files));
  await git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "Declare analytics invariants and examples");
  main = await git("rev-parse", "HEAD");
  const tree = await git("merge-tree", "--write-tree", main, "owner-priya-checkpoint");
  checkpoint = await git("commit-tree", tree, "-p", main, "-p", "owner-priya-checkpoint", "-m", "Priya's feature checkpoint");
  // The feature fork's branch: the runner fetches branches, as it fetches `feature-<id>`.
  await git("branch", "feature-head", checkpoint);
});

after(() => rm(root, { recursive: true, force: true }));

/** The project's stores behind the MCP tool and the Worker's bridge routes, and a runner. */
class Deployment {
  readonly sql = sqlite().sql;
  readonly names = new RepoNames(PREFIX);
  readonly identities: IdentityStore;
  readonly sessions: SessionStore;
  readonly features = new FeatureStore(this.sql);
  readonly reviews = new ReviewStore(this.sql);
  readonly inbox: InboxStore;
  readonly registry = new BridgeRegistry(this.sql);
  readonly scopeMap = parseScopeMap(JSON.parse(execGit("show", "main:penguin/scopes.json")));
  readonly owner = (scope: string) => this.scopeMap.scopes.get(scope)?.driId as string;
  readonly fetchImpl: Fetch;
  readonly tokens = new Map<string, string>();
  readonly reported: number[] = [];

  constructor() {
    let next = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++next}`);
    let sessions: SessionStore | undefined;
    const index = new IssueIndex(this.sql, { assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed) });
    sessions = new SessionStore(this.sql, this.identities, { assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle) });
    this.sessions = sessions;
    this.inbox = new InboxStore(this.sql, this.identities);
    for (const scope of this.scopeMap.scopes.values()) {
      this.identities.create(
        scope.driId,
        { handle: `@${scope.driId}/agent`, name: "agent", job: "Review", charterScopes: [scope.id], autoAccept: true },
        this.scopeMap,
      );
    }
    const handlers = {
      bridges: () => ({
        authenticateBridge: (token: string) => this.registry.authenticate(token),
        // As ProjectAgent.claimReviews and reportReview.
        claimReviews: (caller: BridgeCaller) => claimReviews(this.reviews, caller),
        reportReview: (caller: BridgeCaller, reviewId: number, record: unknown) => {
          this.reported.push(reviewId);
          return recordReview(
            { reviews: this.reviews, routeToOwner: (ownerId, review) => this.inbox.reviewException(ownerId, review.featureId, review.scopeId) },
            caller,
            reviewId,
            record,
          );
        },
      }),
      huddles: () => ({}),
      ownerForkRepo: (owner: string) => `owner-${owner}`,
      projectRepos: { issues: "issues", base: "base" },
      mintToken: () => Promise.reject(new Error("no Artifacts in this test")),
    } as unknown as GatewayHandlers;
    this.fetchImpl = async (input, init) => handleRequest(new Request(input, init), OPTIONS, handlers);
  }

  async register(bridge: string, role: "owner" | "runner"): Promise<void> {
    const { code } = await this.registry.issueCode(bridge, role, 600);
    const publicKey = await crypto.subtle.exportKey("jwk", (await generateSigningKeyPair()).publicKey);
    const outcome = await this.registry.register(code, publicKey);
    assert.equal(outcome.status, "registered");
    if (outcome.status === "registered") this.tokens.set(bridge, outcome.bridge.bridgeToken);
  }

  /** Priya's feature with its fork at the checkpoint, as feature-open.ts records it. */
  async openFeature(): Promise<void> {
    const author = { person: this.owner("identity-map") };
    const area = { scopes: ["identity-map"], paths: [], contracts: [] };
    const sign = (type: "open_feature" | "checkpoint_area") => signFeatureRecord(this.features.draftRecord(FEATURE, type, author, {}), service.privateKey);
    this.features.insert(FEATURE, author.person, area, await sign("open_feature"));
    this.features.setRepo(FEATURE, this.names.feature(FEATURE));
    this.features.setArea(FEATURE, area, await sign("checkpoint_area"), checkpoint);
  }

  /** Jun's agent submits `form` through the MCP tool and gets the tool's answer. */
  async submit(form: unknown): Promise<any> {
    const jun = this.owner(ANALYTICS);
    const registered = this.sessions.register(jun, { identity: `@${jun}/agent`, vendor: "codex", worktreeId: "wt_review", branch: "main" });
    assert.equal(registered.status, "ok");
    const sessionId = registered.status === "ok" ? registered.session.id : "";
    const history = gitHistory(fixture);
    const directory = {
      features: () => this.features.list(),
      submitReview: (owner, session, input) =>
        submitReview(
          {
            features: this.features,
            reviews: this.reviews,
            scopeMap: async () => this.scopeMap,
            invariantsFile: async () => new TextEncoder().encode(execGit("show", "main:penguin/invariants.json")),
            readForkFile: async (_repo, sha, path) => {
              try {
                return new Blob([execGit("show", `${sha}:${path}`)]);
              } catch {
                return null;
              }
            },
            // The fixture repo is both the fork and main, as Artifacts holds both in this test.
            baseline: (_repo, sha) => checkpointBaseline(history, history, sha),
            heartbeat: (caller, id) => this.sessions.heartbeat(caller, id),
          },
          owner,
          session,
          input,
        ),
    } as FeatureDirectory;
    const ports = { directory: () => directory, repos: { issues: this.names.issues, base: this.names.base } } as unknown as FeaturePorts;
    const request = new Request("https://penguin.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_review", arguments: { sessionId, feature: FEATURE, scope: ANALYTICS, form } } }),
    });
    const repos = { issues: this.names.issues, base: this.names.base, ownerFork: this.names.owner(jun) };
    const text = await (await serveMcp(request, jun, () => ({}) as McpProject, repos, mcpFeatures(ports, jun))).text();
    const data = text.includes("data: ") ? (text.split("\n").find((line) => line.startsWith("data: ")) as string).slice(6) : text;
    return JSON.parse(data).result.structuredContent;
  }

  /** One pass of runner mode's reviews in its own empty repository. */
  async pass(name: string) {
    const repo = join(root, name);
    if (!existsSync(repo)) {
      await mkdir(join(repo, "scratch"), { recursive: true });
      await runGit(repo, ["init", "--quiet"]);
    }
    const token = this.tokens.get("runner") as string;
    return reviewPass({
      claim: () => claimReviewsOver(SERVER, token, this.fetchImpl),
      report: (reviewId, record) => reportReview(SERVER, token, reviewId, record, this.fetchImpl),
      // The fixture repo stands in for `feature-<id>`.
      fetchFork: (fork) => {
        assert.equal(fork, `feature-${FEATURE}`);
        return fetchRepoBranches(repo, () => localRemote(fixture), fork);
      },
      review: (request) =>
        runReview({ repoPath: repo, python: PYTHON, scratchDir: join(repo, "scratch"), analyzer: pythonImpactAnalyzer({ repoPath: repo, python: PYTHON }) }, request),
      repoPath: repo,
    });
  }
}

/** A Git command's output in the fixture repo, as the binding reads main and the fork. */
function execGit(...args: string[]): string {
  return execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("the check runner's reviews", () => {
  let deployment: Deployment;

  beforeEach(async () => {
    deployment = new Deployment();
    await deployment.openFeature();
    await deployment.register("runner", "runner");
    await deployment.register(deployment.owner(ANALYTICS), "owner");
  });

  test("a submitted review gets its side-by-side record attached by the runner, and its exceptions reach Jun", async () => {
    const answer = await deployment.submit(BREAKS_FORM);
    assert.equal(answer.state, "pending", JSON.stringify(answer));
    assert.equal(answer.sideBySide, "waiting for the check runner");
    const [pending] = deployment.reviews.list(FEATURE);
    assert.equal(pending?.baseSha, main);
    assert.equal(pending?.sideBySideRef, null);

    const result = await deployment.pass("runner-breaks");
    assert.equal(result.claimed, 1);
    assert.equal(result.reviews[0]?.error, null, result.reviews[0]?.error ?? "");
    const [review] = deployment.reviews.list(FEATURE);
    assert.equal(review?.state, "accepted");
    assert.match(review?.sideBySideRef ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(review?.record?.base, main);
    assert.equal(review?.record?.fork, checkpoint);
    const [set] = review?.record?.sideBySide.sets ?? [];
    assert.deepEqual(set?.differing.map((entry) => [entry.name, entry.main, entry.fork]), [
      ["three patrons on one library tablet", { status: "returned", value: { "2026-01-05": 3 } }, { status: "returned", value: { "2026-01-05": 1 } }],
    ]);
    // Priya's change reshapes Profile, which analytics never reads, so the stored data rule asks it for nothing.
    assert.deepEqual(review?.record?.storedShapes, []);
    // PRD 4.3 step 4: the broken invariant and the protected difference route to the scope's owner.
    assert.deepEqual(review?.exceptions.map((exception) => exception.kind).sort(), ["broken_invariant", "protected_difference"]);
    assert.equal(result.reviews[0]?.reply?.routedTo, deployment.owner(ANALYTICS));
    assert.deepEqual(
      deployment.inbox.items(deployment.owner(ANALYTICS)).map(({ issueId, reason }) => [issueId, reason]),
      [[`${FEATURE}/${ANALYTICS}`, "review_exception"]],
    );

    // The record is attached once: the next pass claims nothing.
    assert.equal((await deployment.pass("runner-breaks")).claimed, 0);
    assert.deepEqual(deployment.reported, [review?.id]);
  });

  test("the runner accepts a form with no marker when its scope reads no changed stored shape", async () => {
    assert.equal((await deployment.submit(HOLDS_FORM)).state, "pending");
    const result = await deployment.pass("runner-holds");
    const [review] = deployment.reviews.list(FEATURE);
    assert.equal(review?.state, "accepted");
    assert.deepEqual(review?.refusals, []);
    assert.equal(review?.record?.sideBySide.totals.differing, 1);
    // The form says the tablet invariant holds; the protected difference still reaches Jun.
    assert.deepEqual(review?.exceptions.map((exception) => exception.kind), ["protected_difference"]);
    assert.equal(result.reviews[0]?.reply?.state, "accepted");
  });

  test("a form refused at submission is never claimed", async () => {
    const answer = await deployment.submit({ rows: [{ ...ORDER_ROW, evidence: [] }] });
    assert.equal(answer.state, "refused");
    assert.equal(answer.sideBySide, "not run: the form was refused");
    assert.equal((await deployment.pass("runner-refused")).claimed, 0);
  });

  test("only a runner bridge claims and reports reviews, and a record must be the review's own", async () => {
    await deployment.submit(BREAKS_FORM);
    const ownerToken = deployment.tokens.get(deployment.owner(ANALYTICS)) as string;
    await assert.rejects(claimReviewsOver(SERVER, ownerToken, deployment.fetchImpl), /only to a runner bridge/);
    const [review] = deployment.reviews.list(FEATURE);
    assert.equal(review?.claimedBy, null);

    const runner = deployment.tokens.get("runner") as string;
    const [claimed] = await claimReviewsOver(SERVER, runner, deployment.fetchImpl);
    assert.deepEqual(
      [claimed?.fork, claimed?.base, claimed?.forkSha, claimed?.scope],
      [`feature-${FEATURE}`, main, checkpoint, ANALYTICS],
    );
    // Claimed and within its lease, the review is not handed out again.
    assert.deepEqual(await claimReviewsOver(SERVER, runner, deployment.fetchImpl), []);

    const forged = { schemaVersion: 1, base: checkpoint, fork: checkpoint, scope: ANALYTICS };
    await assert.rejects(reportReview(SERVER, runner, review?.id as number, forged as never, deployment.fetchImpl), /HTTP 400/);
    await assert.rejects(reportReview(SERVER, ownerToken, review?.id as number, forged as never, deployment.fetchImpl), /only to a runner bridge/);
    await assert.rejects(reportReview(SERVER, runner, 999, forged as never, deployment.fetchImpl), /HTTP 404/);
    assert.equal(deployment.reviews.get(review?.id as number)?.state, "pending");
  });
});
