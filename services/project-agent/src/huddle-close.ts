// Close-out of a Huddle issue (PRD sections 5, 6 and 11 Phase 4). Every operation comes from a
// template; nothing here calls a model.
//
// The Huddle's FeatureAgent evaluates the close after each review, check and thread change it hears
// of (`closeOut`): the issue may close as approved when every fix is approved, the combined tests
// pass and every thread is resolved (packages/policies/src/huddle-close.ts). It then asks the
// integration runner to point the Huddle repo's `approved` branch at the verified `integration`
// commit, since only a Git client writes a ref there. When the runner reports the branch
// (`recordApprovedBranch`), the agent evaluates again and, if nothing changed in between, links the
// branch's commit on the issue as `approved` and closes it with its reason. The index applies the
// same close rule to the close itself, so a close that slips past a change is refused and recorded.
//
// Approving the candidate and merging it stay separate: nothing here touches the team's main branch.
//
// Each FeatureAgent keeps its approved-branch request in its own SQLite (ApprovedBranch). The
// ProjectAgent keeps the last evaluation's blockers for the issue page (CloseOutStore).

import {
  approvedCommit,
  closeBlockers,
  verifiedIntegration,
  type IssueRecord,
  type OpenThread,
  type ReduceRejectReason,
} from "@penguin/issues";
import { huddleRepoName, parseApprovalReport, type ApprovalSpec } from "@penguin/protocol";

import type { HuddleReviewDeps, HuddleReviewPort } from "./huddle-reviews.ts";
import type { Huddle } from "./huddle-store.ts";
import type { HuddleThreadStore } from "./huddle-threads.ts";
import type { SqlDatabase, SqlValue } from "./issue-index.ts";

/** What a FeatureAgent's close-out steps read and write through the ProjectAgent, beyond reviews'. */
export interface HuddleClosePort extends HuddleReviewPort {
  /** Hands the ProjectAgent what the Huddle issue waits on before it may close, for the issue page. */
  recordCloseOut(issueId: string, waitingOn: readonly string[]): void | Promise<void>;
}

/** One Huddle's review deps (with its thread state), its approved-branch request and the ProjectAgent's side. */
export interface HuddleCloseDeps extends HuddleClosePort, HuddleReviewDeps {
  readonly approvals: ApprovedBranchStore;
}

/** The close-out steps a FeatureAgent answers over RPC for its one Huddle. */
export interface HuddleCloser {
  closeOut(huddle: Huddle, project: HuddleClosePort): Promise<CloseOutcome | undefined>;
  pendingApprovals(huddle: Huddle): ApprovalSpec[] | Promise<ApprovalSpec[]>;
  reportApprovedBranch(huddle: Huddle, runnerId: string, report: unknown, project: HuddleClosePort): Promise<ApprovalOutcome>;
}

export type CloseOutcome =
  /** Something stands in the way; `waitingOn` says what, one sentence each. */
  | { readonly status: "waiting"; readonly issueId: string; readonly waitingOn: readonly string[] }
  /** Nothing stands in the way; the runner is asked to point `approved` at `commit`. */
  | { readonly status: "approving"; readonly issueId: string; readonly commit: string }
  /** The issue is closed as approved, with the approved branch's `commit` linked. */
  | { readonly status: "closed"; readonly issueId: string; readonly commit: string };

export type ApprovalOutcome =
  | { readonly status: "recorded"; readonly issueId: string; readonly state: IssueRecord["state"]; readonly commit: string }
  | { readonly status: "rejected"; readonly reason: "invalid" | "not_found" | "stale"; readonly message: string };

export const APPROVED_BRANCH_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ApprovedBranch (
    issue_id TEXT PRIMARY KEY, sha TEXT NOT NULL, status TEXT NOT NULL, runner_id TEXT,
    requested_at INTEGER NOT NULL, pushed_at INTEGER)`,
];

export interface ApprovedBranchRequest {
  readonly issueId: string;
  /** The verified integration commit the branch is to point at. */
  readonly sha: string;
  /** `pending` until the runner reports the branch at `sha`, then `pushed`. */
  readonly status: "pending" | "pushed";
}

/**
 * The close rejections the issue records when a person or session submits the close, so the
 * timeline shows why the Huddle cannot close yet, or why only its starting owner may cancel it.
 */
export const CLOSE_RECORDED_REJECTIONS: readonly ReduceRejectReason[] = ["close_blocked", "not_starting_owner"];

/** How many times Penguin writes one close-out step when another writer moved the issue first. */
const WRITE_ATTEMPTS = 5;
const REASON_MAX = 2_000;

/**
 * The Huddle's request for its approved branch (PRD section 7, FeatureAgent storage: `Candidate` and
 * its approval state). It is live coordination state: the evidence is the `approved` link on the issue.
 */
export class ApprovedBranchStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    for (const statement of APPROVED_BRANCH_SCHEMA) db.exec(statement);
  }

  get(issueId: string): ApprovedBranchRequest | undefined {
    const [row] = this.#db.exec(`SELECT * FROM ApprovedBranch WHERE issue_id = ?`, issueId);
    return row === undefined ? undefined : request(row);
  }

  /** Asks for the branch at `sha`; a request for the same commit is kept as it stands. */
  request(issueId: string, sha: string): void {
    if (this.get(issueId)?.sha === sha) return;
    this.#db.exec(
      `INSERT OR REPLACE INTO ApprovedBranch (issue_id, sha, status, runner_id, requested_at, pushed_at)
       VALUES (?, ?, 'pending', NULL, ?, NULL)`,
      issueId,
      sha,
      this.#now(),
    );
  }

  /** Records that the runner `runnerId` pointed the branch at the requested commit. */
  pushed(issueId: string, runnerId: string): void {
    this.#db.exec(
      `UPDATE ApprovedBranch SET status = 'pushed', runner_id = ?, pushed_at = ? WHERE issue_id = ?`,
      runnerId,
      this.#now(),
      issueId,
    );
  }

  /** Drops a request the runner has not answered, once the Huddle no longer qualifies. */
  withdraw(issueId: string): void {
    this.#db.exec(`DELETE FROM ApprovedBranch WHERE issue_id = ? AND status = 'pending'`, issueId);
  }
}

function request(row: Record<string, SqlValue>): ApprovedBranchRequest {
  return {
    issueId: row["issue_id"] as string,
    sha: row["sha"] as string,
    status: row["status"] as ApprovedBranchRequest["status"],
  };
}

/**
 * The open threads on the Huddle issue and its fixes, from the FeatureAgent's thread state
 * (huddle-threads.ts). The state is first brought up to the threads the issue index records on the
 * issue and each fix, those opened on the dashboard included, since a close evaluation can follow a
 * step that collected no reviews.
 */
export function huddleOpenThreads(
  threads: HuddleThreadStore,
  issue: IssueRecord,
  fixes: readonly IssueRecord[],
): OpenThread[] {
  for (const record of [issue, ...fixes]) threads.record(record.id, record.threads.values());
  return threads.unresolved().map((thread) => ({ issueId: thread.issueId, threadId: thread.threadId }));
}

/**
 * Evaluates the Huddle's close: records what it waits on, withdraws an approved-branch request once
 * something stands in the way, asks for the branch once nothing does, and closes the issue as
 * approved once the branch is recorded at the verified integration commit. Undefined while the
 * Huddle's issue is still opening, missing or closed. Safe to repeat.
 */
export async function closeOut(deps: HuddleCloseDeps, huddle: Huddle): Promise<CloseOutcome | undefined> {
  const issueId = huddle.issueId;
  const issue = issueId === null ? undefined : await deps.issue(issueId);
  if (issueId === null || issue === undefined || issue.state === "closed") return undefined;
  const fixes = (await Promise.all([...issue.subIssues.keys()].map((subId) => deps.issue(subId)))).flatMap(
    (fix) => fix ?? [],
  );
  const openThreads = huddleOpenThreads(deps.threads, issue, fixes);
  const waitingOn = closeBlockers({ issue, fixes, openThreads, scopeMap: await deps.scopeMap() });
  const integration = verifiedIntegration(issue);
  if (waitingOn.length > 0 || integration === null) {
    deps.approvals.withdraw(issueId);
    await deps.recordCloseOut(issueId, waitingOn);
    return { status: "waiting", issueId, waitingOn };
  }
  const sha = integration.slice(integration.indexOf("@") + 1);
  const requested = deps.approvals.get(issueId);
  if (approvedCommit(issue) !== integration && !(requested?.sha === sha && requested.status === "pushed")) {
    deps.approvals.request(issueId, sha);
    const waiting = [`The approved branch is being recorded at ${integration}.`];
    await deps.recordCloseOut(issueId, waiting);
    return { status: "approving", issueId, commit: integration };
  }
  await write(deps, issueId, (current) => approvedCommit(current) === integration, "link_commit", {
    commit: integration,
    kind: "approved",
  });
  await write(deps, issueId, (current) => current.state === "closed", "change_state", {
    state: "closed",
    resolution: "approved",
    reason: closeReason(fixes.length, integration),
  });
  await deps.recordCloseOut(issueId, []);
  return { status: "closed", issueId, commit: integration };
}

/** The Huddle's approved-branch request for the runner, while it waits for one. */
export function pendingApprovals(approvals: ApprovedBranchStore, huddle: Huddle): ApprovalSpec[] {
  const issueId = huddle.issueId;
  if (issueId === null || huddle.huddleRepo === null) return [];
  const requested = approvals.get(issueId);
  if (requested?.status !== "pending") return [];
  return [{ issueId, huddleRepo: huddleRepoName(issueId), sha: requested.sha }];
}

/**
 * Records the runner's report that the Huddle repo's `approved` branch points at the requested commit,
 * then evaluates the close again, which links the branch and closes the issue when nothing changed.
 */
export async function recordApprovedBranch(
  deps: HuddleCloseDeps,
  huddle: Huddle,
  runnerId: string,
  input: unknown,
): Promise<ApprovalOutcome> {
  const parsed = parseApprovalReport(input);
  if (!parsed.ok) {
    return { status: "rejected", reason: "invalid", message: parsed.issues.map((i) => `${i.field || "/"} ${i.message}`).join("; ") };
  }
  const issueId = huddle.issueId;
  const requested = issueId === null ? undefined : deps.approvals.get(issueId);
  if (issueId === null || requested === undefined) {
    return { status: "rejected", reason: "not_found", message: `no approved branch is requested for Huddle ${huddle.triggerCommit}` };
  }
  if (requested.sha !== parsed.report.sha) {
    return { status: "rejected", reason: "stale", message: `the approved branch is requested at ${requested.sha}, not ${parsed.report.sha}` };
  }
  if (requested.status === "pending") deps.approvals.pushed(issueId, runnerId);
  try {
    await closeOut(deps, huddle);
  } catch (error) {
    // The branch stays recorded as pushed; the next review, check or thread change closes again.
    console.error(JSON.stringify({ event: "close_out_failed", issue: issueId, error: String(error) }));
  }
  const state = (await deps.issue(issueId))?.state ?? "closed";
  return { status: "recorded", issueId, state, commit: `${huddleRepoName(issueId)}@${requested.sha}` };
}

function closeReason(fixCount: number, integration: string): string {
  const fixes = fixCount === 1 ? "The fix is approved" : `All ${fixCount} fixes are approved`;
  const at = integration.indexOf("@");
  const revision = `${integration.slice(0, at)}@${integration.slice(at + 1, at + 13)}`;
  const reason = `${fixes}, the combined tests pass on ${revision} and every thread is resolved. The approved branch points at ${revision}.`;
  return reason.length <= REASON_MAX ? reason : `${reason.slice(0, REASON_MAX - 1)}…`;
}

/**
 * Writes the operation unless `present` finds its effect on the issue already, reading the issue
 * again when another writer moved it first. Throws when the index refuses it for any other reason.
 */
async function write(
  deps: HuddleClosePort,
  issueId: string,
  present: (issue: IssueRecord) => boolean,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const issue = await deps.issue(issueId);
    if (issue === undefined) throw new Error(`issue ${issueId} is missing from the index`);
    if (present(issue)) return;
    const outcome = await deps.submit({ issue: Number(issueId), type, base_version: issue.version, payload });
    if (outcome.status === "applied") return;
    if (outcome.reason !== "superseded_version" || attempt === WRITE_ATTEMPTS) {
      throw new Error(`${type} on #${issueId} was rejected: ${outcome.reason}: ${outcome.message}`);
    }
  }
}
