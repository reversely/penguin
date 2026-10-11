// submit_review (#95, PRD 0.4 sections 4.3 and 6) without the network: an agent session calls the
// real MCP tool, which reaches the Worker's feature module and the ProjectAgent's real stores. A real
// Git repo on disk stands in for main and for the feature's fork, read through the binding's
// `readFile({ ref, path })`. The invariants file is the test's own: the fixtures' files belong to #98.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, test } from "node:test";

import { generateSigningKeyPair } from "@penguin/issues";
import { serveMcp, type McpProject } from "@penguin/mcp";
import { parseScopeMap } from "@penguin/scope-map";

import { mcpFeatures, type FeatureDirectory, type FeaturePorts } from "../src/features.ts";
import { RepoNames } from "../src/repos.ts";
import { FeatureStore, signFeatureRecord } from "../../../services/project-agent/src/feature-store.ts";
import { IdentityStore } from "../../../services/project-agent/src/identity-store.ts";
import { IssueIndex } from "../../../services/project-agent/src/issue-index.ts";
import { ReviewStore, submitReview, type ReviewDeps } from "../../../services/project-agent/src/review-submit.ts";
import { importServiceKey, type ServiceKey } from "../../../services/project-agent/src/service-key.ts";
import { SessionStore } from "../../../services/project-agent/src/session-store.ts";
import { GitRepo, sqlite } from "../../../services/project-agent/test/issues-repo.ts";

const PREFIX = "t-";
const FIXTURE = join(import.meta.dirname, "../../../examples/identity-unification/base");
const scopesFile = readFileSync(join(FIXTURE, "penguin/scopes.json"), "utf8");
const scopeMap = parseScopeMap(JSON.parse(scopesFile));
const owners = new Map([...scopeMap.scopes.values()].map((scope) => [scope.id, scope.ownerId]));
const JUN = owners.get("analytics") as string;
const PRIYA = owners.get("identity-map") as string;

const TABLET = "tablet-patrons-separate";
const INVARIANTS = {
  invariants: [{ id: TABLET, scope: "analytics", statement: "Patrons who log in on one library tablet stay separate people", protected: true }],
};
const EXISTING_TEST = "analytics/tests/test_dau.py::test_distinct_users_each_count";

let service: ServiceKey;
before(async () => {
  const pair = await generateSigningKeyPair();
  service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
});

/** The project's stores, a repo for main and the fork, and the Worker's feature ports. */
class Project {
  readonly sqlite = sqlite();
  readonly identities: IdentityStore;
  readonly sessions: SessionStore;
  readonly features: FeatureStore;
  readonly reviews: ReviewStore;
  readonly names = new RepoNames(PREFIX);
  readonly git = new GitRepo();
  readonly ports: FeaturePorts;
  invariantsFile: string | null = JSON.stringify(INVARIANTS);

  constructor() {
    const sql = this.sqlite.sql;
    let next = 0;
    this.identities = new IdentityStore(sql, () => `identity-${++next}`);
    let sessions: SessionStore | undefined;
    const index = new IssueIndex(sql, { assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed) });
    sessions = new SessionStore(sql, this.identities, { assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle) });
    this.sessions = sessions;
    this.features = new FeatureStore(sql);
    this.reviews = new ReviewStore(sql);
    for (const scope of scopeMap.scopes.values()) {
      this.identities.create(
        scope.ownerId,
        { handle: `@${scope.ownerId}/agent`, name: "agent", job: "Review", charterScopes: [scope.id], autoAccept: true },
        scopeMap,
      );
    }
    const unused = () => {
      throw new Error("not used");
    };
    const directory = {
      openFeature: unused,
      recordFeatureRepo: unused,
      featureTokenGrant: unused,
      declareFeatureArea: unused,
      reportFeatureCheckpoint: unused,
      features: () => this.features.list(),
      submitReview: (owner, sessionId, input) => submitReview(this.reviewDeps(), owner, sessionId, input),
    } as FeatureDirectory;
    this.ports = {
      directory: () => directory,
      fork: unused,
      mintWrite: unused,
      repos: { issues: this.names.issues, base: this.names.base },
      config: { forkOptions: { defaultBranchOnly: true }, tokenTtlSeconds: 1800 },
    };
  }

  /** A file at `ref` in the one repo on disk, as the binding's `readFile` returns it. */
  read(ref: string, path: string): Blob | null {
    try {
      return new Blob([execFileSync("git", ["-C", this.git.dir, "cat-file", "blob", `${ref}:${path}`], { stdio: ["ignore", "pipe", "ignore"] })]);
    } catch {
      return null;
    }
  }

  reviewDeps(): ReviewDeps {
    return {
      features: this.features,
      reviews: this.reviews,
      scopeMap: async () => scopeMap,
      invariantsFile: async () => (this.invariantsFile === null ? null : new TextEncoder().encode(this.invariantsFile)),
      readForkFile: async (repo, sha, path) => {
        assert.equal(repo, `${PREFIX}feature-person-id`);
        return this.read(sha, path);
      },
      // The checkpoint's parent is main in this test's one repo.
      baseline: async (_repo, sha) => execFileSync("git", ["-C", this.git.dir, "rev-parse", `${sha}^`], { encoding: "utf8" }).trim(),
      heartbeat: (caller, sessionId) => this.sessions.heartbeat(caller, sessionId),
    };
  }

  register(owner: string): string {
    const outcome = this.sessions.register(owner, { identity: `@${owner}/agent`, vendor: "codex", worktreeId: "wt_review", branch: "main" });
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
    return outcome.status === "ok" ? outcome.session.id : "";
  }

  /** Opens Priya's feature with a fork at `checkpoint`, or with no checkpoint yet. */
  async openFeature(checkpoint: string | null): Promise<void> {
    const author = { person: PRIYA };
    const area = { scopes: ["identity-map"], paths: [], contracts: [] };
    const sign = (type: "open_feature" | "checkpoint_area") =>
      signFeatureRecord(this.features.draftRecord("person-id", type, author, {}), service.privateKey);
    this.features.insert("person-id", PRIYA, area, await sign("open_feature"));
    this.features.setRepo("person-id", `${PREFIX}feature-person-id`);
    if (checkpoint !== null) this.features.setArea("person-id", area, await sign("checkpoint_area"), checkpoint);
  }
}

let nextId = 0;

async function call(project: Project, owner: string, args: unknown): Promise<{ value: any; isError: boolean }> {
  const request = new Request("https://penguin.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name: "submit_review", arguments: args } }),
  });
  const repos = { issues: project.names.issues, base: project.names.base, ownerFork: project.names.owner(owner) };
  const response = await serveMcp(request, owner, () => ({}) as McpProject, repos, mcpFeatures(project.ports, owner));
  const text = await response.text();
  const data = text.includes("data: ") ? (text.split("\n").find((line) => line.startsWith("data: ")) as string).slice(6) : text;
  const parsed = JSON.parse(data);
  assert.equal(parsed.error, undefined, JSON.stringify(parsed.error));
  return { value: parsed.result.structuredContent, isError: parsed.result.isError === true };
}

const row = (evidence: string[], verdict = "holds") => ({ invariant: TABLET, verdict, evidence, storedData: "Past days keep their counts" });

describe("submit_review", () => {
  let project: Project;
  let session: string;
  let main: string;
  let fork: string;

  beforeEach(async () => {
    project = new Project();
    main = project.git.commit({
      "penguin/scopes.json": scopesFile,
      "analytics/tests/test_dau.py": readFileSync(join(FIXTURE, "analytics/tests/test_dau.py"), "utf8"),
    });
    fork = project.git.commit({ "ingestion/identity_map.py": "def person_id(identity):\n    return identity\n" }, "Priya's checkpoint");
    await project.openFeature(fork);
    session = project.register(JUN);
  });

  test('a form claiming "holds" without evidence is refused with the reason, and kept', async () => {
    const answer = await call(project, JUN, { sessionId: session, feature: "person-id", scope: "analytics", form: { rows: [row([])] } });
    assert.equal(answer.isError, true);
    assert.equal(answer.value.state, "refused");
    assert.deepEqual(answer.value.refusals, [
      { code: "no_evidence", message: 'a "holds" verdict needs evidence in the fork', personWritten: { invariant: TABLET } },
    ]);
    assert.deepEqual(answer.value.invariants, [{ id: TABLET, protected: true, personWritten: { statement: INVARIANTS.invariants[0]?.statement } }]);
    assert.equal(answer.value.forkSha, fork);
    assert.deepEqual(project.reviews.list("person-id").map((stored) => [stored.state, stored.reviewer]), [["refused", `@${JUN}/agent`]]);
  });

  test("a form whose evidence exists in the fork is kept pending for the runner, with the checkpoint's baseline", async () => {
    const answer = await call(project, JUN, { sessionId: session, feature: "person-id", scope: "analytics", form: { rows: [row([EXISTING_TEST])] } });
    assert.equal(answer.isError, false, JSON.stringify(answer.value));
    assert.equal(answer.value.state, "pending");
    assert.equal(answer.value.sideBySide, "waiting for the check runner");
    const [stored] = project.reviews.list("person-id");
    assert.equal(stored?.forkSha, fork);
    assert.equal(stored?.baseSha, main);
    assert.equal(stored?.ownerId, JUN);
    assert.deepEqual(stored?.invariants.map((invariant) => invariant.id), [TABLET]);
  });

  test('evidence missing from the fork, a missing row and "unknown" without a test are refused', async () => {
    // Jun's own shared-device test lives in Jun's fork, not in the fork under review.
    const missing = await call(project, JUN, {
      sessionId: session,
      feature: "person-id",
      scope: "analytics",
      form: { rows: [row(["analytics/tests/test_identity.py::test_shared_device_split", "../../etc/passwd:1"])] },
    });
    assert.deepEqual(missing.value.refusals.map((refusal: { code: string }) => refusal.code), ["evidence_not_found", "invalid_evidence"]);
    const noRow = await call(project, JUN, { sessionId: session, feature: "person-id", scope: "analytics", form: { rows: [] } });
    assert.deepEqual(noRow.value.refusals.map((refusal: { code: string }) => refusal.code), ["missing_row"]);
    const unknown = await call(project, JUN, {
      sessionId: session,
      feature: "person-id",
      scope: "analytics",
      form: { rows: [row(["ingestion/identity_map.py::person_id"], "unknown")] },
    });
    assert.deepEqual(unknown.value.refusals.map((refusal: { code: string }) => refusal.code), ["unknown_without_test"]);
  });

  test("a review covers the caller's own scope of a feature with a checkpoint", async () => {
    const other = await call(project, JUN, { sessionId: session, feature: "person-id", scope: "identity-map", form: { rows: [] } });
    assert.equal(other.value.error, "forbidden");
    const nowhere = await call(project, JUN, { sessionId: session, feature: "ledger", scope: "analytics", form: { rows: [] } });
    assert.equal(nowhere.value.error, "not_found");
    const fresh = new Project();
    await fresh.openFeature(null);
    const early = await call(fresh, JUN, { sessionId: fresh.register(JUN), feature: "person-id", scope: "analytics", form: { rows: [] } });
    assert.match(early.value.message, /no checkpoint/);
    assert.equal(project.reviews.list("person-id").length, 0);
  });

  test("a malformed invariants file on main refuses every review with its problems", async () => {
    project.invariantsFile = JSON.stringify({ invariants: [{ id: "x", scope: "billing", statement: "y" }] });
    const answer = await call(project, JUN, { sessionId: session, feature: "person-id", scope: "analytics", form: { rows: [] } });
    assert.equal(answer.value.error, "invalid");
    assert.match(answer.value.message, /invariants\[0\]\.scope/);
  });

  test("form text is length-limited before it reaches Penguin and kept as data", async () => {
    const long = await call(project, JUN, {
      sessionId: session,
      feature: "person-id",
      scope: "analytics",
      form: { rows: [{ ...row([EXISTING_TEST]), storedData: "x".repeat(2_001) }] },
    });
    assert.equal(long.isError, true);
    assert.equal(project.reviews.list("person-id").length, 0);
    const hostile = "<script>alert(1)</script> $(rm -rf /)";
    const kept = await call(project, JUN, {
      sessionId: session,
      feature: "person-id",
      scope: "analytics",
      form: { rows: [{ ...row([EXISTING_TEST]), storedData: hostile }] },
    });
    assert.equal(kept.value.state, "pending");
    assert.equal(project.reviews.list("person-id")[0]?.form.rows[0]?.storedData, hostile);
  });
});
