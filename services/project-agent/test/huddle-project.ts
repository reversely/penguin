// Test support for opening Huddle issues: one ProjectAgent's stores over one in-memory database,
// wired the way the agent wires them, with `openHuddle` called through the same dependencies. Each
// Huddle's verification runs, review standing and approved-branch request are kept apart, as each
// Huddle's HuddleAgent keeps them in its own SQLite.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateSigningKeyPair, type FixApproval, type ReduceRejectReason, type RejectReason } from "@penguin/issues";
import type { ApprovalSpec, Author, CombinedRunEvent, VerificationRunSpec } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { parseCombinedRunEvent } from "@penguin/protocol";

import {
  CombinedRunStore,
  scheduleCombinedRuns,
  type RepoHistoryReader,
  type ScheduleOutcome,
} from "../src/combined-run-schedule.ts";
import { openHuddle, type HuddleOpenDeps, type HuddleOpenOutcome } from "../src/huddle-open.ts";
import { CloseOutStore, FixApprovalStore } from "../src/approval-store.ts";
import {
  ApprovedBranchStore,
  CLOSE_RECORDED_REJECTIONS,
  closeOut,
  pendingApprovals,
  recordApprovedBranch,
  type ApprovalOutcome,
  type CloseOutcome,
  type HuddleCloseDeps,
} from "../src/huddle-close.ts";
import { collectReviews, FixReviewStore, type HuddleReviewDeps, type ReviewCollection } from "../src/huddle-reviews.ts";
import { HuddleStore, type Huddle } from "../src/huddle-store.ts";
import { HuddleThreadStore } from "../src/huddle-threads.ts";
import {
  huddlesOf,
  recordVerification,
  scheduleVerification,
  unknownVerification,
  verificationSpecs,
  type HuddleVerifyDeps,
  type VerificationScheduleOutcome,
  type VerificationOutcome,
} from "../src/huddle-verify.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { InboxStore } from "../src/inbox-store.ts";
import {
  IssueIndex,
  type IndexListener,
  type OperationKeys,
  type PendingSource,
  type SubmitOutcome,
} from "../src/issue-index.ts";
import { OwnerForkStore, recordReportedCheckpoint, type CheckpointOutcome } from "../src/owner-forks.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { postSessionUpdate, type SessionUpdate, type SessionUpdateOutcome } from "../src/session-updates.ts";
import { SessionStore, threadRefs } from "../src/session-store.ts";
import { VerificationStore } from "../src/verification-store.ts";
import { reassignUpstream } from "../src/upstream.ts";
import { artifactsResolvesRef } from "./artifacts-refs.ts";
import { sqlite } from "./issues-repo.ts";

const FIXTURE = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin");

/**
 * The fixture's scope map plus a billing scope owned by Lee that depends on nothing, so a test can
 * check that an unrelated owner hears nothing of a Huddle.
 */
export function fixtureScopeMap(): ScopeMap {
  const scopes = JSON.parse(readFileSync(join(FIXTURE, "scopes.json"), "utf8")) as { scopes: unknown[] };
  const billing = {
    id: "billing",
    name: "Billing",
    owner: "lee",
    paths: ["billing/"],
    test_command: "python -m pytest billing",
    depends_on: [],
  };
  return parseScopeMap({ scopes: [...scopes.scopes, billing] });
}

/** The fixture's seed identities: @priya/merge-rules, @jun/reports and @sam/campaigns. */
function seedIdentities(): { handle: string; owner: string; job: string; charter_scopes: string[] }[] {
  return (JSON.parse(readFileSync(join(FIXTURE, "identities.json"), "utf8")) as { identities: [] }).identities;
}

let service: ServiceKey | undefined;

async function serviceKey(): Promise<ServiceKey> {
  if (service === undefined) {
    const pair = await generateSigningKeyPair();
    service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  }
  return service;
}

export class HuddleProject {
  readonly sql = sqlite().sql;
  readonly scopeMap = fixtureScopeMap();
  readonly identities: IdentityStore;
  readonly index: IssueIndex;
  readonly sessions: SessionStore;
  readonly inbox: InboxStore;
  readonly forks: OwnerForkStore;
  readonly huddles: HuddleStore;
  readonly runs: CombinedRunStore;
  /**
   * Each Huddle's verification runs, by trigger commit, each over its own database as each Huddle's
   * HuddleAgent keeps them. Run IDs start at 1 in every Huddle here; the agent gives each Huddle its
   * own range (`runIdBaseOf`).
   */
  readonly huddleRuns = new Map<string, VerificationStore>();
  /** Each Huddle's review standing, by trigger commit, each over its own database as its HuddleAgent keeps it. */
  readonly huddleReviews = new Map<string, FixReviewStore>();
  /** Each Huddle's threads, by trigger commit, each over its own database as its HuddleAgent keeps them. */
  readonly huddleThreads = new Map<string, HuddleThreadStore>();
  /** Each fix's approval as the ProjectAgent keeps it for the issue page. */
  readonly approvals: FixApprovalStore;
  /** Each Huddle's approved-branch request, by trigger commit, each over its own database as its HuddleAgent keeps it. */
  readonly huddleApprovals = new Map<string, ApprovedBranchStore>();
  /** What each Huddle issue waits on before it closes, as the ProjectAgent keeps it for the issue page. */
  readonly closeOuts: CloseOutStore;
  /** Each owner's delegate, as the base repo's `penguin/owners.json` names them. */
  delegates = new Map<string, string>();
  /** Commits in each owner's fork, by owner id, as the Artifacts binding's readCommit would find them. */
  readonly published = new Map<string, Set<string>>();
  /** The sessions' clock in epoch milliseconds; the real clock while undefined. */
  clock: number | undefined;

  constructor(options: { readonly seedIdentities?: boolean } = {}) {
    let nextIdentity = 0;
    let nextSession = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++nextIdentity}`);
    let sessions: SessionStore | undefined;
    let inbox: InboxStore | undefined;
    const listener: IndexListener = {
      assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
      issueChanged: (change) => inbox?.issueChanged(change),
    };
    const index = new IssueIndex(this.sql, listener);
    inbox = new InboxStore(this.sql, this.identities, {
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
    });
    sessions = new SessionStore(this.sql, this.identities, {
      newId: () => `session-${++nextSession}`,
      now: () => this.clock ?? Date.now(),
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
      startRequests: inbox,
      deliverAtCheckpoint: (issueId) => this.huddles.isFix(issueId),
      threadsNeeding: (person) => threadRefs(index.threadsNeeding(person)),
    });
    [this.index, this.sessions, this.inbox] = [index, sessions, inbox];
    this.forks = new OwnerForkStore(this.sql);
    this.huddles = new HuddleStore(this.sql);
    this.approvals = new FixApprovalStore(this.sql);
    this.closeOuts = new CloseOutStore(this.sql);
    let nextRun = 0;
    this.runs = new CombinedRunStore(this.sql, { newId: () => `run-${++nextRun}` });
    if (options.seedIdentities ?? true) {
      for (const seed of seedIdentities()) this.identity(seed.owner, seed.handle, seed.charter_scopes);
    }
  }

  identity(owner: string, handle: string, charterScopes: string[]): void {
    const name = handle.slice(handle.indexOf("/") + 1);
    const input = { handle, name, job: "Fix things", charterScopes, autoAccept: true };
    const outcome = this.identities.create(owner, input, this.scopeMap);
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  }

  /** Records `sha` as published to `owner`'s fork, optionally reported by an agent session. */
  publish(owner: string, sha: string, sessionId: string | null = null): void {
    const commits = this.published.get(owner) ?? new Set();
    commits.add(sha);
    this.published.set(owner, commits);
    this.forks.recordCheckpoint(owner, `owner-${owner}`, sha, sessionId);
  }

  /** Signs and applies an operation as `author`, as ProjectAgent.submit does. */
  async submit(
    operation: unknown,
    author: Author,
    source: PendingSource,
    recordRejections?: readonly (RejectReason | ReduceRejectReason)[],
  ): Promise<SubmitOutcome> {
    const key = await serviceKey();
    const keys: OperationKeys = {
      bridges: [],
      serviceKey: key.publicKey,
      scopeMap: this.scopeMap,
      delegates: this.delegates,
      identities: this.identities,
      fixes: { upstreamScopes: (issueId) => this.huddles.fixOf(this.index.resolve(issueId))?.huddle.triggerScopes },
      huddles: { startedBy: (issueId) => this.huddles.byIssue(issueId)?.triggerOwner },
    };
    const record = recordRejections === undefined ? {} : { recordRejections };
    return this.index.submit({ operation, author, source, signingKey: key.privateKey, keys, ...record });
  }

  /** A session's post_update, wired as ProjectAgent.sessionUpdate wires it. */
  sessionUpdate(caller: string, sessionId: string, update: SessionUpdate): Promise<SessionUpdateOutcome> {
    return postSessionUpdate(
      {
        sessions: {
          heartbeat: (owner, id) => this.sessions.heartbeat(owner, id),
          routes: (issueId) => this.sessions.routes(this.index.resolve(issueId)),
        },
        issueVersion: (issueId) => this.index.issue(issueId)?.version,
        submit: (operation, author, record) => this.submit(operation, author, "mcp", record),
        reassignUpstream: (issueId, sender) =>
          reassignUpstream(
            {
              huddleOf: (id) => this.huddles.fixOf(id)?.huddle,
              scopeMap: this.scopeMap,
              issue: (id) => this.index.issue(id),
              identities: () => this.identities.list(),
              runningHandles: () => this.sessions.running().map((session) => session.handle),
              submit: (operation) => this.submit(operation, { penguin: true }, "penguin"),
            },
            issueId,
            sender,
          ),
      },
      caller,
      sessionId,
      update,
    );
  }

  /** The dependencies ProjectAgent.openHuddle passes, with `overrides` replacing any of them. */
  async deps(overrides: Partial<HuddleOpenDeps> = {}): Promise<HuddleOpenDeps> {
    return {
      huddles: this.huddles,
      scopeMap: this.scopeMap,
      issue: (issueId) => this.index.issue(issueId),
      issueIds: () => this.index.ids(),
      submit: (operation) => this.submit(operation, { penguin: true }, "penguin"),
      ownerFork: (ownerId) => this.forks.get(ownerId),
      session: (sessionId) => this.sessions.get(sessionId),
      identities: () => this.identities.list(),
      triggerPublished: async ({ trigger }) => this.published.get(trigger.ownerId)?.has(trigger.sha) ?? false,
      ...overrides,
    };
  }

  /** The runs of the Huddle opened by `triggerCommit`, kept as its HuddleAgent keeps them. */
  runsOf(triggerCommit: string): VerificationStore {
    let runs = this.huddleRuns.get(triggerCommit);
    if (runs === undefined) {
      runs = new VerificationStore(sqlite().sql);
      this.huddleRuns.set(triggerCommit, runs);
    }
    return runs;
  }

  /** The runs of the one open Huddle the verification tests open. */
  get verificationRuns(): VerificationStore {
    const [huddle, ...others] = this.huddles.open();
    assert.ok(huddle !== undefined && others.length === 0, "one open Huddle");
    return this.runsOf(huddle.triggerCommit);
  }

  /** The dependencies a HuddleAgent's verification steps have: its runs and the ProjectAgent's side. */
  async verifyDeps(huddle: Huddle): Promise<HuddleVerifyDeps> {
    const { issue, submit, ownerFork } = await this.deps();
    return { runs: this.runsOf(huddle.triggerCommit), issue, submit, ownerFork };
  }

  /**
   * Records `sha` as `owner`'s latest checkpoint and schedules verification of each open Huddle the
   * owner takes part in, as a checkpoint report does.
   */
  async checkpoint(owner: string, sha: string): Promise<VerificationScheduleOutcome[]> {
    this.publish(owner, sha);
    const outcomes: VerificationScheduleOutcome[] = [];
    for (const huddle of huddlesOf(this.huddles.open(), owner)) {
      const outcome = await scheduleVerification(await this.verifyDeps(huddle), huddle);
      if (outcome !== undefined) outcomes.push(outcome);
      if (outcome?.status === "scheduled") await this.closeOut(huddle);
    }
    return outcomes;
  }

  /** The runs waiting for the runner across the open Huddles, as the ProjectAgent lists them. */
  verificationSpecs(): VerificationRunSpec[] {
    return this.huddles.open().flatMap((huddle) => verificationSpecs(this.runsOf(huddle.triggerCommit), huddle));
  }

  /**
   * Records a report with the Huddle whose HuddleAgent holds run `runId`, then collects the Huddle's
   * reviews when the report moved it to IN_REVIEW and evaluates its close, as the HuddleAgent does.
   */
  async reportVerification(runId: string, report: unknown, runnerId = "runner-1"): Promise<VerificationOutcome> {
    const huddle = this.huddles.open().find((open) => this.runsOf(open.triggerCommit).get(runId) !== undefined);
    if (huddle === undefined) return unknownVerification(runId, report);
    const outcome = await recordVerification(await this.verifyDeps(huddle), huddle, runId, runnerId, report);
    if (outcome.status === "recorded" && outcome.state === "in_review") await this.collectReviews(huddle);
    else if (outcome.status === "recorded") await this.closeOut(huddle);
    return outcome;
  }

  /** The review standing of the Huddle opened by `triggerCommit`, kept as its HuddleAgent keeps it. */
  reviewsOf(triggerCommit: string): FixReviewStore {
    let reviews = this.huddleReviews.get(triggerCommit);
    if (reviews === undefined) {
      reviews = new FixReviewStore(sqlite().sql);
      this.huddleReviews.set(triggerCommit, reviews);
    }
    return reviews;
  }

  /** The threads of the Huddle opened by `triggerCommit`, kept as its HuddleAgent keeps them. */
  threadsOf(triggerCommit: string): HuddleThreadStore {
    let threads = this.huddleThreads.get(triggerCommit);
    if (threads === undefined) {
      threads = new HuddleThreadStore(sqlite().sql);
      this.huddleThreads.set(triggerCommit, threads);
    }
    return threads;
  }

  /** The dependencies a HuddleAgent's review steps have: its runs and reviews, and the ProjectAgent's side. */
  async reviewDeps(huddle: Huddle): Promise<HuddleReviewDeps> {
    return {
      ...(await this.verifyDeps(huddle)),
      reviews: this.reviewsOf(huddle.triggerCommit),
      threads: this.threadsOf(huddle.triggerCommit),
      scopeMap: () => this.scopeMap,
      requestReview: (ownerId, issueId) => this.inbox.reviewRequested(ownerId, issueId),
      recordApproval: (issueId, approval) => {
        this.approvals.set(issueId, approval);
      },
    };
  }

  /**
   * Collects the reviews of a Huddle's fixes, by default the one open Huddle's, then evaluates its
   * close, as its HuddleAgent does.
   */
  async collectReviews(huddle?: Huddle): Promise<ReviewCollection | undefined> {
    const target = huddle ?? this.huddles.open()[0];
    assert.ok(target !== undefined, "an open Huddle");
    const collection = await collectReviews(await this.reviewDeps(target), target);
    await this.closeOut(target);
    return collection;
  }

  /** The approved-branch request of the Huddle opened by `triggerCommit`, kept as its HuddleAgent keeps it. */
  approvalsOf(triggerCommit: string): ApprovedBranchStore {
    let approvals = this.huddleApprovals.get(triggerCommit);
    if (approvals === undefined) {
      approvals = new ApprovedBranchStore(sqlite().sql);
      this.huddleApprovals.set(triggerCommit, approvals);
    }
    return approvals;
  }

  /** The dependencies a HuddleAgent's close-out steps have: its review deps and approved-branch request. */
  async closeDeps(huddle: Huddle): Promise<HuddleCloseDeps> {
    return {
      ...(await this.reviewDeps(huddle)),
      approvals: this.approvalsOf(huddle.triggerCommit),
      recordCloseOut: (issueId, waitingOn) => {
        this.closeOuts.set(issueId, waitingOn);
      },
    };
  }

  /** Evaluates the close of a Huddle, by default the one open Huddle's, as its HuddleAgent does. */
  async closeOut(huddle?: Huddle): Promise<CloseOutcome | undefined> {
    const target = huddle ?? this.huddles.open()[0];
    assert.ok(target !== undefined, "an open Huddle");
    return closeOut(await this.closeDeps(target), target);
  }

  /** The approved branches waiting for the runner across the open Huddles, as the ProjectAgent lists them. */
  approvalSpecs(): ApprovalSpec[] {
    return this.huddles
      .open()
      .filter((huddle) => huddle.issueId !== null && this.index.issue(huddle.issueId)?.state !== "closed")
      .flatMap((huddle) => pendingApprovals(this.approvalsOf(huddle.triggerCommit), huddle));
  }

  /** Records the runner's report of a Huddle issue's approved branch with its HuddleAgent, as the ProjectAgent does. */
  async reportApprovedBranch(issueId: string, report: unknown, runnerId = "runner-1"): Promise<ApprovalOutcome> {
    const huddle = this.huddles.byIssue(issueId);
    if (huddle === undefined) return { status: "rejected", reason: "not_found", message: `no Huddle has issue ${issueId}` };
    return recordApprovedBranch(await this.closeDeps(huddle), huddle, runnerId, report);
  }

  /**
   * `person` writes an operation on the dashboard, with a refused close recorded on the timeline; the
   * Huddle of the issue, or of the fix, then collects its reviews and evaluates its close, as the
   * ProjectAgent has it do after an operation changes a fix or a Huddle issue.
   */
  async dashboard(person: string, issueId: string, type: string, payload: Record<string, unknown>): Promise<SubmitOutcome> {
    const version = this.index.issue(issueId)?.version ?? 0;
    const operation = { issue: Number(issueId), type, base_version: version, payload };
    const outcome = await this.submit(operation, { person }, "dashboard", CLOSE_RECORDED_REJECTIONS);
    const huddle = this.huddles.fixOf(issueId)?.huddle ?? this.huddles.byIssue(issueId);
    if (huddle !== undefined) await this.collectReviews(huddle);
    return outcome;
  }

  /**
   * `person` reviews the fix sub-issue `issueId` from the dashboard; the fix's Huddle then collects its
   * reviews, as the ProjectAgent has it do after an operation changes a fix.
   */
  async review(
    person: string,
    issueId: string,
    payload: { verdict: "approve" | "request_changes"; commit: string; reason?: string },
  ): Promise<SubmitOutcome> {
    const version = this.index.issue(issueId)?.version ?? 0;
    const outcome = await this.submit({ issue: Number(issueId), type: "review", base_version: version, payload }, { person }, "dashboard");
    await this.collectFor(issueId);
    return outcome;
  }

  /**
   * `person` writes a thread operation (reply_thread or resolve_thread) from the dashboard; the
   * issue's Huddle then collects its reviews and threads, as the ProjectAgent has it do.
   */
  async thread(person: string, issueId: string, type: "reply_thread" | "resolve_thread", payload: object): Promise<SubmitOutcome> {
    const version = this.index.issue(issueId)?.version ?? 0;
    const outcome = await this.submit({ issue: Number(issueId), type, base_version: version, payload }, { person }, "dashboard");
    await this.collectFor(issueId);
    return outcome;
  }

  /** Collects the reviews of the Huddle the issue belongs to, as its Huddle issue or a fix sub-issue. */
  async collectFor(issueId: string): Promise<void> {
    const huddle = this.huddles.fixOf(issueId)?.huddle ?? this.huddles.byIssue(issueId);
    if (huddle !== undefined) await this.collectReviews(huddle);
  }

  /** Where approval of the fix sub-issue stands, as the issue page shows it. */
  approval(issueId: string): FixApproval | undefined {
    return this.approvals.get(issueId);
  }

  /** Opens the Huddle for a combined-run report and completes the runs it answers, as the agent does. */
  async open(event: CombinedRunEvent | unknown, overrides: Partial<HuddleOpenDeps> = {}): Promise<HuddleOpenOutcome> {
    const outcome = await openHuddle(await this.deps(overrides), event);
    const parsed = parseCombinedRunEvent(event);
    if (outcome.status !== "rejected" && parsed.ok) this.runs.complete(parsed.event);
    return outcome;
  }

  /**
   * Records a checkpoint reported for `owner`'s fork once `repo` holds the commit, then schedules
   * its combined runs, as ProjectAgent.reportBridgeCheckpoint does. `repo` stands in for both the
   * owner's fork and the base repo, read by its branch name.
   */
  async report(
    owner: string,
    sha: string,
    repo: RepoHistoryReader & { has(sha: string): boolean },
  ): Promise<{ readonly checkpoint: CheckpointOutcome; readonly schedule: ScheduleOutcome | undefined }> {
    const commitExists = async (_fork: string, commit: string) => repo.has(commit);
    const checkpoint = await recordReportedCheckpoint({ forks: this.forks, commitExists }, owner, sha, `owner-${owner}`, null);
    if (checkpoint.status !== "ok") return { checkpoint, schedule: undefined };
    this.publish(owner, sha);
    const schedule = await scheduleCombinedRuns(
      {
        scopeMap: this.scopeMap,
        fork: repo,
        base: repo,
        latestCheckpoint: (ownerId) => this.forks.get(ownerId)?.latestCheckpointSha ?? undefined,
        runs: this.runs,
      },
      owner,
      sha,
    );
    return { checkpoint, schedule };
  }

  /** Issues labelled `huddle`. */
  huddleIssues(): string[] {
    return this.index.ids().filter((id) => this.index.issue(id)?.labels.includes("huddle"));
  }

  appliedCount(): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM AppliedOp`)[0]?.["n"]);
  }

  /** Each sub-issue of the Huddle issue as "<first assignee> <first check's test> <fingerprint>". */
  fixes(huddleId: string): string[] {
    const huddle = this.index.issue(huddleId);
    assert.ok(huddle);
    return [...huddle.subIssues.keys()].map((subId) => {
      const sub = this.index.issue(subId);
      assert.ok(sub);
      const [assignee] = [...sub.assignments.values()];
      const [check] = [...sub.checks.values()];
      return `${assignee?.assigneeId} ${check?.test} ${check?.fingerprint}`;
    });
  }
}

/**
 * A Git repo on disk read through the Artifacts binding's `log` and `readTree`, standing in for an
 * owner's fork and for the base repo. Refs resolve as on real Artifacts (artifacts-refs.ts). Counts
 * each call.
 */
export function gitHistory(dir: string): RepoHistoryReader & {
  has(sha: string): boolean;
  readonly calls: Record<string, number>;
} {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const calls: Record<string, number> = {};
  const count = (method: string) => (calls[method] = (calls[method] ?? 0) + 1);
  return {
    calls,
    has: (sha) => {
      try {
        git("cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    log: async ({ ref, limit, offset }) => {
      count("log");
      if (!artifactsResolvesRef(ref)) return [];
      const out = git("log", "--first-parent", "--format=%H %T", `--skip=${offset}`, `-n${limit}`, ref, "--");
      return out === ""
        ? []
        : out.split("\n").map((line) => {
            const [hash, treeHash] = line.split(" ") as [string, string];
            return { hash, treeHash };
          });
    },
    readTree: async (hash) => {
      count("readTree");
      const out = git("ls-tree", hash);
      return out === ""
        ? []
        : out.split("\n").map((line) => {
            const [meta, name] = line.split("\t") as [string, string];
            const [mode, , object] = meta.split(" ") as [string, string, string];
            return { name, hash: object, type: mode === "040000" ? "tree" : "blob" };
          });
    },
  };
}
