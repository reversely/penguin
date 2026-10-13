// What the dashboard derives from GET /api/board for each assignment: an identity's session status,
// what its issue waits on and Penguin's state across every issue. The team map
// (team-view.ts) and the agent card build on these. Pure, so the rules are tested without a browser
// (test/board-view.test.ts).
//
// Session status (PRD section 8: working, waiting at a checkpoint, blocked, done) is derived from the
// issue's state and its routing, because no MCP tool reports it: done once the issue is closed;
// blocked while no running session holds the issue or an open thread needs a person; waiting at a
// checkpoint while the published fix is verified or reviewed; working otherwise.

import type { Board, BoardIssue, IssuePageAssignee } from "@penguin/protocol";

import { fixedIn, latestChecks, penguinState, standingReviews, type PenguinState } from "./issue-view.ts";

export type SessionStatus = "working" | "waiting at a checkpoint" | "blocked" | "done";

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

/** Session statuses in the order they call for attention, the most pressing first. */
export const STATUS_ATTENTION: readonly SessionStatus[] = ["blocked", "waiting at a checkpoint", "working", "done"];

/**
 * Each routed session's status, by session id: the most pressing status of the issues routed to it.
 * A running session that holds no issue on the board has none here and counts as working, the status
 * an assignment takes when nothing blocks it.
 */
export function sessionStatuses(board: Board): ReadonlyMap<string, SessionStatus> {
  const statuses = new Map<string, SessionStatus>();
  for (const issue of board.issues) {
    for (const assignee of issue.issue.assignees) {
      const status = sessionStatus(issue, assignee);
      const id = assignee.session?.id;
      if (status === null || id === undefined) continue;
      const known = statuses.get(id);
      if (known === undefined || STATUS_ATTENTION.indexOf(status) < STATUS_ATTENTION.indexOf(known)) statuses.set(id, status);
    }
  }
  return statuses;
}

/** What the issue waits on, as one short noun phrase, or null once it is closed. */
export function waitsOn(issue: BoardIssue, assignee: IssuePageAssignee | null): string | null {
  const { state, assignees, checks, reviews } = issue.issue;
  if (state === "closed") return null;
  if (assignee?.waitingFor === "acceptance") return "Owner acceptance";
  if (assignee?.kind === "identity" && assignee.session?.status !== "running") return "A running session";
  const people = [...new Set(threadNeedsPerson(issue))];
  if (people.length > 0) return `Reply from ${people.join(" and ")}`;
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

/** The order in which a state calls for attention: the first one any open issue is in is the team's. */
const ATTENTION: readonly PenguinState[] = [
  "verification failed",
  "ready to approve",
  "awaiting review",
  "fixing",
  "coordinating",
  "observing",
];

/** Penguin's state for the whole project: the most pressing state of any issue. */
export function boardPenguinState(board: Board): PenguinState {
  const states = new Set(board.issues.map((issue) => penguinState(issue)));
  return ATTENTION.find((state) => states.has(state)) ?? "observing";
}

/** The initial of an identity's name part or a person's id, for an avatar without an image. */
export function initial(id: string): string {
  const name = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}
