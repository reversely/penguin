// What the issue page derives from GET /api/issues/<id>: the Penguin character's state, the signal
// treatment of each timeline entry and check, and the one-line text of each operation. Pure, so the
// rules are tested without a browser (test/issue-view.test.ts).
//
// Signal semantics (PRD sections 3 and 8): an agent identity's change of state or linked commit is a
// claim; a test result is evidence, verified when it passes; Penguin's own operations are alerts; a
// review is its own kind. A failed test is a failure and a test that errored is a warning, and the two
// look different. Penguin's bookkeeping (labels, assignments, sub-issue links) is not an alert.

import {
  anchoredReview,
  type IssuePage,
  type IssuePageApproval,
  type IssuePageCheck,
  type IssuePageCloseOut,
  type IssuePageOwnerApproval,
  type IssuePageReview,
  type IssuePageState,
  type IssuePageSubIssue,
  type IssuePageThread,
  type IssuePageTimelineEntry,
} from "@penguin/protocol";

export type PenguinState =
  | "observing"
  | "coordinating"
  | "fixing"
  | "verification failed"
  | "awaiting review"
  | "ready to approve";

export type Signal = "claim" | "alert" | "verified" | "failure" | "warning" | "review";

export const SIGNAL_LABEL: Readonly<Record<Signal, string>> = {
  claim: "Claim",
  alert: "Alert",
  verified: "Verified",
  failure: "Failed",
  warning: "Warning",
  review: "Review",
};

export const STATE_LABEL: Readonly<Record<IssuePageState, string>> = {
  open: "Open",
  detected: "Detected",
  fixing: "Fixing",
  verifying: "Verifying",
  in_review: "In review",
  closed: "Closed",
};

/** Where an owner whose review counts on a fix stands on the fix's head. */
export const APPROVAL_LABEL: Readonly<Record<IssuePageOwnerApproval["state"], string>> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  pending: "Awaiting review",
};

/** How a closed issue ended, as one sentence. */
export const RESOLUTION_LABEL: Readonly<Record<NonNullable<IssuePageCloseOut["resolution"]>, string>> = {
  approved: "Closed as approved. Merging the approved branch is a separate step.",
  cancelled: "Cancelled by the owner who started the work.",
};

/** True when the close-out has something to show: a resolution, the approved branch or what it waits on. */
export function showsCloseOut(closeOut: IssuePageCloseOut | null | undefined): closeOut is IssuePageCloseOut {
  return closeOut != null && (closeOut.resolution !== null || closeOut.approvedCommit !== null || closeOut.waitingOn.length > 0);
}

/**
 * True when a counting review is of a commit other than the fix's head, so it no longer counts. A
 * fix without a recorded approval has no head to compare with.
 */
export function reviewSuperseded(review: IssuePageReview, approval: IssuePageSubIssue["approval"]): boolean {
  return review.counts && approval?.head != null && `${review.repo}@${review.sha}` !== approval.head;
}

const PENGUIN_SEGMENT = "penguin";

/** An author segment as people read it: "jun.reports" is the identity "@jun/reports". */
export function authorName(segment: string | null): string {
  if (segment === null) return "Unknown author";
  if (segment === PENGUIN_SEGMENT) return "Penguin";
  const dot = segment.indexOf(".");
  return dot === -1 ? segment : `@${segment.slice(0, dot)}/${segment.slice(dot + 1)}`;
}

function isIdentity(segment: string | null): boolean {
  return segment !== null && segment.includes(".");
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function checkSignal(check: Pick<IssuePageCheck, "result">): Signal {
  return check.result === "pass" ? "verified" : check.result === "fail" ? "failure" : "warning";
}

/** The newest current result for each command and test, in first-seen order. A superseded check never counts. */
export function latestChecks(checks: readonly IssuePageCheck[]): IssuePageCheck[] {
  const latest = new Map<string, IssuePageCheck>();
  for (const check of checks) {
    if (check.supersededBy === null) latest.set(`${check.commandId}\u0000${check.test ?? ""}`, check);
  }
  return [...latest.values()];
}

/** The sub-issue whose own passing check covers the same command and test, if any. */
export function fixedIn(check: IssuePageCheck, subIssues: IssuePage["subIssues"]): string | undefined {
  if (check.result === "pass") return undefined;
  return subIssues.find((sub) =>
    latestChecks(sub.checks).some(
      (own) => own.result === "pass" && own.commandId === check.commandId && own.test === check.test,
    ),
  )?.id;
}

/** Each counting reviewer's latest verdict. A review without review rights is left out. */
export function standingReviews(reviews: readonly IssuePageReview[]): IssuePageReview[] {
  const latest = new Map<string, IssuePageReview>();
  for (const review of reviews) if (review.counts) latest.set(review.reviewer, review);
  return [...latest.values()];
}

function approved(reviews: readonly IssuePageReview[]): boolean {
  const standing = standingReviews(reviews);
  return standing.length > 0 && standing.every((review) => review.verdict === "approve");
}

/**
 * The Penguin character's state. An open or closed issue is observed; a detected one is being
 * coordinated; in verification, a latest failing check means verification failed; in review, the
 * issue is ready to approve once every fix (or the issue itself, without sub-issues) holds only
 * approvals, no thread is open and no latest check fails.
 */
export function penguinState(page: Pick<IssuePage, "issue" | "subIssues">): PenguinState {
  const { issue, subIssues } = page;
  const failing = latestChecks(issue.checks).some((check) => check.result !== "pass" && fixedIn(check, subIssues) === undefined);
  switch (issue.state) {
    case "open":
    case "closed":
      return "observing";
    case "detected":
      return "coordinating";
    case "fixing":
      return "fixing";
    case "verifying":
      return failing ? "verification failed" : "coordinating";
    case "in_review": {
      // A Huddle fix's recorded approval judges only reviews of its head by the owners whose review counts.
      const fixApproved = (sub: IssuePageSubIssue) => sub.approval?.approved ?? approved(sub.reviews);
      const reviewed = subIssues.length > 0 ? subIssues.every(fixApproved) : approved(issue.reviews);
      const threadsOpen = issue.threads.some((thread) => thread.status === "open");
      return reviewed && !threadsOpen && !failing ? "ready to approve" : "awaiting review";
    }
  }
}

/**
 * Penguin's operations that tell people something: a state change, a comment, a thread or a mention.
 * Its bookkeeping (labels, assignments, sub-issue links) stays plain, so alerts stand out.
 */
const ALERT_TYPES: ReadonlySet<string> = new Set(["create", "change_state", "comment", "open_thread", "mention"]);

/** The signal treatment of a timeline entry, or undefined for a plain operation. */
export function entrySignal(entry: IssuePageTimelineEntry): Signal | undefined {
  if (entry.type === "review") return "review";
  if (entry.type === "attach_check") {
    const result = (entry.payload as { result?: unknown } | null)?.result;
    return result === "pass" || result === "fail" || result === "error" ? checkSignal({ result }) : undefined;
  }
  if (entry.author === PENGUIN_SEGMENT && entry.type !== null && ALERT_TYPES.has(entry.type)) return "alert";
  if (isIdentity(entry.author) && (entry.type === "change_state" || entry.type === "link_commit")) return "claim";
  return undefined;
}

/** A timeline entry as one clause, and the text it carries (a comment's body, a review's reason). */
export interface EntryText {
  readonly summary: string;
  readonly text?: string;
}

function party(value: unknown): string {
  const p = value as { person?: unknown; identity?: unknown } | null;
  if (typeof p?.person === "string") return p.person;
  if (typeof p?.identity === "string") return p.identity;
  return "someone";
}

function commitText(value: unknown): string {
  if (typeof value !== "string") return "a commit";
  const at = value.indexOf("@");
  return at === -1 ? value : `${value.slice(0, at)}@${shortSha(value.slice(at + 1))}`;
}

export function describeEntry(entry: IssuePageTimelineEntry): EntryText {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  switch (entry.type) {
    case "create":
      return { summary: "opened the issue" };
    case "edit":
      return { summary: p["title"] !== undefined ? "edited the title" : "edited the body" };
    case "comment":
      return withText("commented", text(p["body"]));
    case "edit_comment":
      return withText("edited a comment", text(p["body"]));
    case "add_label":
      return { summary: `added ${text(p["label"]) ?? "a label"}` };
    case "remove_label":
      return { summary: `removed ${text(p["label"]) ?? "a label"}` };
    case "assign":
      return { summary: `assigned ${party(p["assignee"])}` };
    case "unassign":
      return { summary: `unassigned ${party(p["assignee"])}` };
    case "mention":
      return { summary: `mentioned ${party(p["mentioned"])}` };
    case "link_commit": {
      const kind = text(p["kind"]);
      return { summary: `linked ${kind === undefined ? "" : `${kind} `}commit ${commitText(p["commit"])}` };
    }
    case "attach_check":
      return { summary: `${text(p["test"]) ?? text(p["command_id"]) ?? "check"} ${checkVerb(p["result"])}` };
    case "open_sub_issue":
      return { summary: `opened sub-issue #${String(p["sub_issue"])}` };
    case "review":
      return withText(
        p["verdict"] === "approve" ? `approved ${commitText(p["commit"])}` : `requested changes on ${commitText(p["commit"])}`,
        text(p["reason"]),
      );
    case "open_thread":
      return withText("opened a thread", text(p["body"]));
    case "reply_thread":
      return withText("replied in a thread", text(p["body"]));
    case "resolve_thread":
      return withText("resolved a thread", text(p["reason"]));
    case "change_state": {
      const state = text(p["state"]);
      const resolution = text(p["resolution"]);
      if (state === "closed" && resolution === "cancelled") return withText("cancelled the issue", text(p["reason"]));
      if (state === "closed" && resolution === "approved") return withText("closed the issue as approved", text(p["reason"]));
      const label = state !== undefined && state in STATE_LABEL ? STATE_LABEL[state as IssuePageState] : state;
      return withText(`moved the issue to ${label ?? "a new state"}`, text(p["reason"]));
    }
    case "send_upstream":
      return withText("sent the fix upstream", text(p["reason"]));
    default:
      return { summary: entry.type === null ? "unreadable operation" : `${entry.type} operation` };
  }
}

function withText(summary: string, text: string | undefined): EntryText {
  return text === undefined ? { summary } : { summary, text };
}

function checkVerb(result: unknown): string {
  return result === "pass" ? "passed" : result === "fail" ? "failed" : "errored";
}

/** A reject reason as a label: "bad_signature" reads "bad signature". */
/**
 * Who a thread speaks for: the reviewer, for a thread Penguin opened for a review that requested
 * changes on the issue, and otherwise whoever opened it. An author segment.
 */
export function threadOpener(thread: Pick<IssuePageThread, "anchor" | "openedBy">, reviews: readonly IssuePageReview[]): string {
  const reviewOpId = anchoredReview(thread.anchor);
  return reviews.find((review) => review.opId === reviewOpId)?.reviewer ?? thread.openedBy;
}

export function reasonLabel(reason: string | null): string {
  return (reason ?? "unknown").replaceAll("_", " ");
}

/**
 * The issue ids whose change refreshes the page: the issue under its number and its temporary ID,
 * and each sub-issue, whose sessions, reviews and checks the page shows.
 */
export function watchedIssues(page: IssuePage | undefined, routeId: string): string[] {
  if (page === undefined) return [routeId];
  return [routeId, page.issue.id, ...(page.issue.alias === null ? [] : [page.issue.alias]), ...page.subIssues.map((sub) => sub.id)];
}

/** An assignee as an author segment: "@jun/reports" as "jun.reports", a person as their id. */
export function assigneeSegment(assignee: { readonly kind: "person" | "identity"; readonly id: string }): string {
  return assignee.kind === "identity" ? assignee.id.replace(/^@/, "").replace("/", ".") : assignee.id;
}

/** Who wrote an operation, as the thread draws them: Penguin's mark, an identity's character or a person's initial. */
export type AuthorKind = "penguin" | "identity" | "person" | "unknown";

export function authorKind(segment: string | null): AuthorKind {
  if (segment === null) return "unknown";
  if (segment === PENGUIN_SEGMENT) return "penguin";
  return isIdentity(segment) ? "identity" : "person";
}

/**
 * How the thread draws a timeline entry (identity plan section 5): the opening as the issue's
 * description; a comment as a post under its author, the viewer's own in ink; Penguin's alerts as centred
 * system lines; a claim as a compact line with a dashed edge; a check as an evidence card; a review
 * as a settled approval card; a thread as a card holding its replies; a rejected operation struck
 * through with its reason; anything else as a compact event line. A reply or resolution of a thread
 * on the page renders inside the thread's card, so the thread skips it at the top level.
 */
export type EntryKind =
  | "opened"
  | "comment"
  | "own-comment"
  | "system"
  | "claim"
  | "check"
  | "review"
  | "thread"
  | "in-thread"
  | "rejected"
  | "event";

/** The op_ids of the issue's checks, reviews and threads, read once per render so each entry looks them up in a set. */
export interface EntryIds {
  readonly checks: ReadonlySet<string>;
  readonly reviews: ReadonlySet<string>;
  readonly threads: ReadonlySet<string>;
}

export function entryIds(issue: Pick<IssuePage["issue"], "checks" | "reviews" | "threads">): EntryIds {
  return {
    checks: new Set(issue.checks.map((check) => check.opId)),
    reviews: new Set(issue.reviews.map((review) => review.opId)),
    threads: new Set(issue.threads.map((thread) => thread.id)),
  };
}

export function entryKind(entry: IssuePageTimelineEntry, viewer: string, ids: EntryIds): EntryKind {
  if (entry.status === "rejected") return "rejected";
  switch (entry.type) {
    case "create":
      return "opened";
    case "attach_check":
      if (ids.checks.has(entry.opId)) return "check";
      break;
    case "review":
      if (ids.reviews.has(entry.opId)) return "review";
      break;
    case "open_thread":
      if (ids.threads.has(entry.opId)) return "thread";
      break;
    case "reply_thread":
    case "resolve_thread": {
      const thread = threadOf(entry);
      if (thread !== undefined && ids.threads.has(thread)) return "in-thread";
      break;
    }
    case "comment":
    case "edit_comment":
      if (entry.author === PENGUIN_SEGMENT) return "system";
      return entry.author === viewer ? "own-comment" : "comment";
  }
  const signal = entrySignal(entry);
  if (signal === "alert") return "system";
  if (signal === "claim") return "claim";
  return "event";
}

/** The thread a reply or resolution names, or undefined. */
export function threadOf(entry: Pick<IssuePageTimelineEntry, "payload">): string | undefined {
  const thread = (entry.payload as { thread?: unknown } | null)?.thread;
  return typeof thread === "string" ? thread : undefined;
}

/** Each thread's applied replies and resolution, in timeline order, by thread id, in one pass. */
export function threadEntries(timeline: readonly IssuePageTimelineEntry[]): ReadonlyMap<string, readonly IssuePageTimelineEntry[]> {
  const byThread = new Map<string, IssuePageTimelineEntry[]>();
  for (const entry of timeline) {
    if (entry.status !== "applied" || (entry.type !== "reply_thread" && entry.type !== "resolve_thread")) continue;
    const thread = threadOf(entry);
    if (thread === undefined) continue;
    const entries = byThread.get(thread);
    if (entries === undefined) byThread.set(thread, [entry]);
    else entries.push(entry);
  }
  return byThread;
}

/** Where a fix's approval card stands for the viewer (identity plan section 5, Approval card). */
export type ApprovalStatus = "waiting-for-you" | "approved" | "changes-requested" | "waiting";

export const APPROVAL_STATUS_LABEL: Readonly<Record<ApprovalStatus, string>> = {
  "waiting-for-you": "Waiting for your review",
  approved: "Approved",
  "changes-requested": "Changes requested",
  waiting: "Waiting for review",
};

/**
 * The card's status: approved once every owner approved the head; waiting for the viewer while a
 * head is linked and the viewer is an owner whose review is pending; changes requested while an
 * owner's standing review asks for changes; waiting for review otherwise.
 */
export function approvalStatus(approval: IssuePageApproval, viewer: string): ApprovalStatus {
  if (approval.approved) return "approved";
  if (approval.head !== null && approval.owners.some((owner) => owner.owner === viewer && owner.state === "pending")) {
    return "waiting-for-you";
  }
  if (approval.owners.some((owner) => owner.state === "changes_requested")) return "changes-requested";
  return "waiting";
}

/** A fix sub-issue whose approval Penguin collects. */
export type ApprovalFix = IssuePageSubIssue & { readonly approval: IssuePageApproval };

/** The fix sub-issues whose approval Penguin collects, which the thread shows as approval cards. */
export function approvalFixes(subIssues: readonly IssuePageSubIssue[]): ApprovalFix[] {
  return subIssues.flatMap((sub) => (sub.approval === null ? [] : [{ ...sub, approval: sub.approval }]));
}

/** The number of current checks per signal, and of superseded checks, for the details panel's summary row. */
export interface CheckSummary {
  readonly verified: number;
  readonly failure: number;
  readonly warning: number;
  readonly superseded: number;
}

export function checkSummary(checks: readonly IssuePageCheck[]): CheckSummary {
  const summary = { verified: 0, failure: 0, warning: 0, superseded: 0 };
  for (const check of checks) {
    if (check.supersededBy !== null) summary.superseded += 1;
    else summary[checkSignal(check) as "verified" | "failure" | "warning"] += 1;
  }
  return summary;
}

/** A `<repo>@<sha>` commit with its SHA shortened, as the cards print it. */
export function shortCommit(commit: string): string {
  return commitText(commit);
}

/**
 * The composer's height in rows: one per line of the draft, up to six (identity plan section 5,
 * Composer). Browsers that size a field to its content also grow it for wrapped lines.
 */
export function composerRows(draft: string): number {
  let lines = 1;
  for (const char of draft) if (char === "\n") lines += 1;
  return Math.min(6, lines);
}
