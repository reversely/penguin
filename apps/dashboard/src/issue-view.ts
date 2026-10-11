// What the issue page derives from GET /api/issues/<id>: the Penguin character's state, the signal
// treatment of each timeline entry and check, and the one-line text of each operation. Pure, so the
// rules are tested without a browser (test/issue-view.test.ts).
//
// Signal semantics (PRD sections 3 and 8): an agent identity's change of state or linked commit is a
// claim; a test result is evidence, verified when it passes; Penguin's own operations are alerts; a
// review is its own kind. A failed test is a failure and a test that errored is a warning, and the two
// look different. Penguin's bookkeeping (labels, assignments, sub-issue links) is not an alert.

import type { IssuePage, IssuePageCheck, IssuePageReview, IssuePageState, IssuePageTimelineEntry } from "@penguin/protocol";

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
      const reviewed = subIssues.length > 0 ? subIssues.every((sub) => approved(sub.reviews)) : approved(issue.reviews);
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
