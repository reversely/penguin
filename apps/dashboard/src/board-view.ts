// What the board derives from GET /api/board: each issue's column, the swimlanes and their cards, each
// card's session status and what its issue waits on, and the Penguin character's state for the whole
// board. Pure, so the rules are tested without a browser (test/board-view.test.ts).
//
// Columns follow the Huddle lifecycle (PRD section 6). A plain issue has no Huddle state: an open
// issue with an assignee sits in Fixing and one without in Detected; a closed issue is Done. Its
// state still moves the card once someone changes it.
//
// Session status (PRD section 8: working, waiting at a checkpoint, blocked, done) is derived from the
// issue's state and its routing, because no MCP tool reports it: done once the issue is closed;
// blocked while no running session holds the issue or an open thread needs a person; waiting at a
// checkpoint while the published fix is verified or reviewed; working otherwise.

import type {
  Board,
  BoardIdentity,
  BoardIssue,
  IssuePageAssignee,
  IssuePageReview,
  IssuePageState,
} from "@penguin/protocol";

import { fixedIn, latestChecks, penguinState, standingReviews, type PenguinState } from "./issue-view.ts";

export type Column = "detected" | "fixing" | "verifying" | "in_review" | "done";

export const COLUMNS: readonly { readonly id: Column; readonly label: string }[] = [
  { id: "detected", label: "Detected" },
  { id: "fixing", label: "Fixing" },
  { id: "verifying", label: "Verifying" },
  { id: "in_review", label: "In review" },
  { id: "done", label: "Done" },
];

export type SessionStatus = "working" | "waiting at a checkpoint" | "blocked" | "done";

export const SESSION_STATUS_LABEL: Readonly<Record<SessionStatus, string>> = {
  working: "Working",
  "waiting at a checkpoint": "Waiting at a checkpoint",
  blocked: "Blocked",
  done: "Done",
};

export interface CheckCounts {
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
}

export interface Card {
  readonly key: string;
  readonly issue: BoardIssue;
  /** The assignee the card is for, or null for an unassigned issue. */
  readonly assignee: IssuePageAssignee | null;
  /** The assigned identity as the board lists it, for its avatar; null for a person or no assignee. */
  readonly identity: BoardIdentity | null;
  /** The identity's session status; null for a person or no assignee, who run no session. */
  readonly status: SessionStatus | null;
  readonly checks: CheckCounts;
  /** Each reviewer's latest review; one without review rights has `counts` false. */
  readonly reviewers: readonly IssuePageReview[];
  readonly waitsOn: string | null;
}

export interface Lane {
  /** The owner, or null for the lane of issues no owner holds. */
  readonly owner: string | null;
  readonly identities: readonly BoardIdentity[];
  readonly columns: Readonly<Record<Column, readonly Card[]>>;
}

const STATE_COLUMN: Readonly<Record<Exclude<IssuePageState, "open">, Column>> = {
  detected: "detected",
  fixing: "fixing",
  verifying: "verifying",
  in_review: "in_review",
  closed: "done",
};

export function boardColumn(issue: BoardIssue): Column {
  const { state, assignees } = issue.issue;
  if (state === "open") return assignees.length > 0 ? "fixing" : "detected";
  return STATE_COLUMN[state];
}

function threadNeedsPerson(issue: BoardIssue): readonly string[] {
  return issue.issue.threads.filter((thread) => thread.status === "open").flatMap((thread) => thread.needsPersonIds);
}

export function sessionStatus(issue: BoardIssue, assignee: IssuePageAssignee | null): SessionStatus | null {
  if (assignee?.kind !== "identity") return null;
  const { state } = issue.issue;
  if (state === "closed") return "done";
  if (assignee.session?.status !== "running" || threadNeedsPerson(issue).length > 0) return "blocked";
  if (state === "verifying" || state === "in_review") return "waiting at a checkpoint";
  return "working";
}

/** What the issue waits on, as one short noun phrase, or null once it is closed. */
export function waitsOn(issue: BoardIssue, assignee: IssuePageAssignee | null): string | null {
  const { state, assignees, checks, reviews } = issue.issue;
  if (state === "closed") return null;
  if (assignee?.waitingFor === "acceptance") return "Owner acceptance";
  if (assignee?.kind === "identity" && assignee.session?.status !== "running") return "A running session";
  const people = [...new Set(threadNeedsPerson(issue))];
  if (people.length > 0) return `Reply from ${people.join(", ")}`;
  switch (state) {
    case "open":
      return assignees.length === 0 ? "An assignee" : "A fix";
    case "detected":
      if (issue.subIssues.length > 0) return "Fix sub-issues";
      return assignees.length === 0 ? "An assignee" : "A fix";
    case "fixing":
      return "A fix";
    case "verifying": {
      const failing = latestChecks(checks).some((check) => check.result !== "pass" && fixedIn(check, issue.subIssues) === undefined);
      return failing ? "A passing run" : "Combined tests";
    }
    case "in_review":
      if (penguinState(issue) === "ready to approve") return "Approval";
      return standingReviews(reviews).some((review) => review.verdict === "request_changes") ? "Requested changes" : "Reviews";
  }
}

/** Each reviewer's latest review, counting or not, in first-review order. */
export function latestReviews(issue: BoardIssue): IssuePageReview[] {
  const latest = new Map<string, IssuePageReview>();
  for (const review of issue.issue.reviews) latest.set(review.reviewer, review);
  return [...latest.values()];
}

export function checkCounts(issue: BoardIssue): CheckCounts {
  const latest = latestChecks(issue.issue.checks);
  const count = (result: string) => latest.filter((check) => check.result === result).length;
  return { passed: count("pass"), failed: count("fail"), errored: count("error") };
}

function emptyColumns(): Record<Column, Card[]> {
  return { detected: [], fixing: [], verifying: [], in_review: [], done: [] };
}

/**
 * The swimlanes: the viewer's first, then every other owner in order, then the lane of issues no owner
 * holds when it has cards. An issue has one card per assignee and lane owner; an unassigned issue has
 * one card. Cards keep the board's issue order.
 */
export function boardLanes(board: Board, viewer: string): Lane[] {
  const identities = new Map<string, BoardIdentity>();
  for (const owner of board.owners) for (const identity of owner.identities) identities.set(identity.handle, identity);
  const lanes = new Map<string | null, Record<Column, Card[]>>();
  const ordered = [...board.owners].sort((a, b) => Number(b.id === viewer) - Number(a.id === viewer));
  for (const owner of ordered) lanes.set(owner.id, emptyColumns());

  const place = (owner: string | null, issue: BoardIssue, assignee: IssuePageAssignee | null) => {
    if (!lanes.has(owner)) lanes.set(owner, emptyColumns());
    const identity = assignee?.kind === "identity" ? (identities.get(assignee.id) ?? null) : null;
    (lanes.get(owner) as Record<Column, Card[]>)[boardColumn(issue)].push({
      key: `${issue.issue.id}:${assignee === null ? "" : `${assignee.kind}:${assignee.id}`}:${owner ?? ""}`,
      issue,
      assignee,
      identity,
      status: sessionStatus(issue, assignee),
      checks: checkCounts(issue),
      reviewers: latestReviews(issue),
      waitsOn: waitsOn(issue, assignee),
    });
  };
  for (const issue of board.issues) {
    if (issue.issue.assignees.length === 0) place(null, issue, null);
    for (const assignee of issue.issue.assignees) {
      const owners = issue.laneOwners[assignee.id] ?? [];
      if (owners.length === 0) place(null, issue, assignee);
      for (const owner of owners) place(owner, issue, assignee);
    }
  }
  // The lane without an owner goes last.
  const unowned = lanes.get(null);
  lanes.delete(null);
  if (unowned !== undefined) lanes.set(null, unowned);
  const byOwner = new Map(board.owners.map((owner) => [owner.id, owner.identities]));
  return [...lanes].map(([owner, columns]) => ({
    owner,
    identities: owner === null ? [] : (byOwner.get(owner) ?? []),
    columns,
  }));
}

/** Issues per column across the board, each issue once. */
export function columnCounts(board: Board): Record<Column, number> {
  const counts: Record<Column, number> = { detected: 0, fixing: 0, verifying: 0, in_review: 0, done: 0 };
  for (const issue of board.issues) counts[boardColumn(issue)] += 1;
  return counts;
}

/** How many cards a lane's Done column shows until "Show all" shows every one. */
export const DONE_WINDOW = 5;

/** A number orders issues by age; a temporary ID belongs to an issue created offline and not yet numbered. */
function issueAge(card: Card): number {
  const { id } = card.issue.issue;
  return /^\d+$/.test(id) ? Number(id) : Number.POSITIVE_INFINITY;
}

/**
 * A lane's Done cards, newest issue first: the first DONE_WINDOW, or all of them. The board carries no
 * close time, so the issue number stands in for it.
 */
export function doneCards(cards: readonly Card[], showAll: boolean): readonly Card[] {
  const sorted = [...cards].sort((a, b) => issueAge(b) - issueAge(a));
  return showAll ? sorted : sorted.slice(0, DONE_WINDOW);
}

/** The order in which a state calls for attention: the first one any open issue is in is the board's. */
const ATTENTION: readonly PenguinState[] = [
  "verification failed",
  "ready to approve",
  "awaiting review",
  "fixing",
  "coordinating",
  "observing",
];

/** The Penguin character's state for the whole board: the most pressing state of any issue on it. */
export function boardPenguinState(board: Board): PenguinState {
  const states = new Set(board.issues.map((issue) => penguinState(issue)));
  return ATTENTION.find((state) => states.has(state)) ?? "observing";
}

/** The initial of an identity's name part or a person's id, for an avatar without an image. */
export function initial(id: string): string {
  const name = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}
