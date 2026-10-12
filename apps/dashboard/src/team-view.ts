// What the dashboard derives from GET /api/board and GET /api/identities: the team's people for their
// hues, a person's issues and the facts an agent card shows about the work an identity holds. Pure, so
// the rules are tested without a browser (test/team-view.test.ts).
//
// The board's people are every owner it lists (identity holders and the owners of assigned issues),
// every owner the identities page lists (the scope map's owners) and every person an inbox item asks
// to act. A person's steward shows on its own row, not among their agents on no feature.

import type { Board, BoardIssue, BoardWaiting, DashboardAgent, IdentitiesPage, IssuePageAssignee, TeamPerson } from "@penguin/protocol";

import { sessionStatus, STATUS_ATTENTION, waitsOn } from "./board-view.ts";

function isOpen(issue: BoardIssue): boolean {
  return issue.issue.state !== "closed";
}

function assignment(issue: BoardIssue, handle: string): IssuePageAssignee | undefined {
  return issue.issue.assignees.find((assignee) => assignee.kind === "identity" && assignee.id === handle);
}

/** The person's agents on no feature, without the steward, which the person's Steward row shows. */
export function idleAgents(person: Pick<TeamPerson, "idleAgents" | "steward">): readonly DashboardAgent[] {
  const steward = person.steward?.handle;
  return steward === undefined ? person.idleAgents : person.idleAgents.filter((agent) => agent.handle !== steward);
}

/** A number orders issues; a temporary ID belongs to an issue created offline and goes last. */
function issueOrder(id: string): number {
  return /^\d+$/.test(id) ? Number(id) : Number.POSITIVE_INFINITY;
}

/** The open issues assigned to `handle`: the most pressing session status first, then by number. */
export function heldIssues(board: Board, handle: string): BoardIssue[] {
  const rank = (issue: BoardIssue) => STATUS_ATTENTION.indexOf(sessionStatus(issue, assignment(issue, handle) ?? null) ?? "done");
  return board.issues
    .filter((issue) => isOpen(issue) && assignment(issue, handle) !== undefined)
    .sort((a, b) => rank(a) - rank(b) || issueOrder(a.issue.id) - issueOrder(b.issue.id));
}

/** Whether an open thread on the issue needs the person. */
function threadNeeds(issue: BoardIssue | undefined, person: string): boolean {
  return issue?.issue.threads.some((thread) => thread.status === "open" && thread.needsPersonIds.includes(person)) ?? false;
}

/** The board's people, in no particular order. */
export function teamPeople(board: Board, page: IdentitiesPage): ReadonlySet<string> {
  return new Set([...board.owners.map((owner) => owner.id), ...page.owners, ...board.waiting.map((item) => item.personId)]);
}

/** Why an issue is on a person's list. */
export type Involvement = "assigned" | "review" | "reply" | "session";

export const INVOLVEMENT_LABEL: Readonly<Record<Involvement, string>> = {
  assigned: "Assigned",
  review: "Review",
  reply: "Reply",
  session: "Session to start",
};

export interface PersonIssue {
  readonly issue: BoardIssue;
  readonly involvement: readonly Involvement[];
}

/**
 * The issues that involve a person: assigned to them or to an identity whose lane they hold, or
 * waiting on their review, their reply or a session they start. Open issues come first, each part
 * newest first.
 */
export function personIssues(board: Board, person: string): PersonIssue[] {
  const waiting = board.waiting.filter((item) => item.personId === person);
  const asked = (issueId: string, reason: BoardWaiting["reason"]) => waiting.some((item) => item.issueId === issueId && item.reason === reason);
  const rows = board.issues.flatMap((issue): PersonIssue[] => {
    const id = issue.issue.id;
    const involvement: Involvement[] = [];
    if (Object.values(issue.laneOwners).some((owners) => owners.includes(person))) involvement.push("assigned");
    if (isOpen(issue) && asked(id, "review_requested")) involvement.push("review");
    if (threadNeeds(issue, person)) involvement.push("reply");
    if (isOpen(issue) && asked(id, "start_session")) involvement.push("session");
    return involvement.length === 0 ? [] : [{ issue, involvement }];
  });
  return rows.sort(
    (a, b) => Number(isOpen(b.issue)) - Number(isOpen(a.issue)) || issueOrder(b.issue.issue.id) - issueOrder(a.issue.issue.id),
  );
}

export interface AgentWork {
  /** The issue the agent works on now: the most pressing open issue assigned to it, or null. */
  readonly issue: BoardIssue | null;
  /** What that issue waits on, or null with no issue. */
  readonly waitsOn: string | null;
  /** The other open issues assigned to it, by number. */
  readonly others: readonly BoardIssue[];
}

/**
 * The issue a session works on: the fix task last delivered to it at a checkpoint, else the most
 * pressing open issue of the identity routed to it; null when neither is known.
 */
export function sessionIssue(
  board: Board | undefined,
  handle: string,
  session: { readonly id: string; readonly currentIssueId: string | null },
): string | null {
  if (session.currentIssueId !== null) return session.currentIssueId;
  if (board === undefined) return null;
  return heldIssues(board, handle).find((issue) => assignment(issue, handle)?.session?.id === session.id)?.issue.id ?? null;
}

/** The work an identity holds, for its agent card. */
export function agentWork(board: Board, handle: string): AgentWork {
  const [first, ...others] = heldIssues(board, handle);
  if (first === undefined) return { issue: null, waitsOn: null, others: [] };
  const byNumber = others.sort((a, b) => issueOrder(a.issue.id) - issueOrder(b.issue.id));
  return { issue: first, waitsOn: waitsOn(first, assignment(first, handle) ?? null), others: byNumber };
}
