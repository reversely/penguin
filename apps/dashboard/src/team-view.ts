// What the team map derives from GET /api/board and GET /api/identities: one square per person with
// their agents and what needs them, a person's issues, and the facts an agent card shows about the
// work an identity holds. Pure, so the rules are tested without a browser (test/team-view.test.ts).
//
// People are every owner the board lists (identity holders and the owners of assigned issues), every
// owner the identities page lists (the scope map's owners) and every person an inbox item asks to act.
// A personal identity sits under its owner. A team identity sits under the owners who assigned it the
// issues it holds, as the board's lanes place it, and under every owner it serves while it holds none.

import type { Board, BoardIdentity, BoardIssue, BoardWaiting, IdentitiesPage, IssuePageAssignee } from "@penguin/protocol";

import { sessionStatus, sessionStatuses, STATUS_ATTENTION, waitsOn, type SessionStatus } from "./board-view.ts";

/** An agent box's status: its session's, or "none" while no session of the identity runs. */
export type AgentStatus = SessionStatus | "none";

export const AGENT_STATUS_LABEL: Readonly<Record<AgentStatus, string>> = {
  working: "Working",
  "waiting at a checkpoint": "Waiting",
  blocked: "Blocked",
  done: "Done",
  none: "No session",
};

export interface Agent {
  readonly identity: BoardIdentity;
  /** The identity's id on the identities page, which its card opens by; null when the page lacks it. */
  readonly id: string | null;
  readonly status: AgentStatus;
  /** The open issues assigned to the identity, the most pressing first. */
  readonly held: readonly BoardIssue[];
}

/** How many review requests, threads and session requests wait on a person. */
export interface Needs {
  readonly reviews: number;
  readonly threads: number;
  readonly sessions: number;
}

export interface Person {
  readonly id: string;
  readonly agents: readonly Agent[];
  readonly needs: Needs;
}

export interface TeamMap {
  /** The viewer first, then everyone else in id order. */
  readonly people: readonly Person[];
  /** Open issues no one is assigned to. */
  readonly unassigned: readonly BoardIssue[];
}

function isOpen(issue: BoardIssue): boolean {
  return issue.issue.state !== "closed";
}

function assignment(issue: BoardIssue, handle: string): IssuePageAssignee | undefined {
  return issue.issue.assignees.find((assignee) => assignee.kind === "identity" && assignee.id === handle);
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

/** The status of an identity's running sessions: the most pressing one, or "none" with none running. */
export function agentStatus(identity: BoardIdentity, statuses: ReadonlyMap<string, SessionStatus>): AgentStatus {
  if (identity.sessions.length === 0) return "none";
  const known = identity.sessions.map((session) => statuses.get(session.id) ?? "working");
  return STATUS_ATTENTION.find((status) => known.includes(status)) ?? "working";
}

/** Whether an open thread on the issue needs the person. */
function threadNeeds(issue: BoardIssue | undefined, person: string): boolean {
  return issue?.issue.threads.some((thread) => thread.status === "open" && thread.needsPersonIds.includes(person)) ?? false;
}

/**
 * What waits on a person, counted from their inbox items as the inbox lists them: each review
 * request, each thread item while an open thread on its issue still needs them, and each request to
 * start a session.
 */
export function needsOf(person: string, waiting: readonly BoardWaiting[], issues: ReadonlyMap<string, BoardIssue>): Needs {
  const own = waiting.filter((item) => item.personId === person);
  return {
    reviews: own.filter((item) => item.reason === "review_requested").length,
    threads: own.filter((item) => item.reason === "thread" && threadNeeds(issues.get(item.issueId), person)).length,
    sessions: own.filter((item) => item.reason === "start_session").length,
  };
}

/** Agents with a session first, the most pressing status first, then by handle. */
function byAttention(agents: readonly Agent[]): Agent[] {
  const rank = (agent: Agent) => (agent.status === "none" ? STATUS_ATTENTION.length : STATUS_ATTENTION.indexOf(agent.status));
  return [...agents].sort((a, b) => rank(a) - rank(b) || (a.identity.handle < b.identity.handle ? -1 : 1));
}

export function teamMap(board: Board, page: IdentitiesPage, viewer: string): TeamMap {
  const statuses = sessionStatuses(board);
  const ids = new Map(page.identities.map((identity) => [identity.handle, identity.id]));
  const issues = new Map(board.issues.map((issue) => [issue.issue.id, issue] as const));
  const people = new Set([...board.owners.map((owner) => owner.id), ...page.owners, ...board.waiting.map((item) => item.personId)]);
  const agentsOf = new Map<string, Agent[]>();

  for (const owner of board.owners) {
    for (const identity of owner.identities) {
      const held = heldIssues(board, identity.handle);
      if (identity.team) {
        // A team identity goes under the owners who assigned it its issues, as the board's lanes do.
        const assigners = new Set(held.flatMap((issue) => issue.laneOwners[identity.handle] ?? []));
        if (assigners.size > 0 && !assigners.has(owner.id)) continue;
      }
      const agent: Agent = { identity, id: ids.get(identity.handle) ?? null, status: agentStatus(identity, statuses), held };
      agentsOf.set(owner.id, [...(agentsOf.get(owner.id) ?? []), agent]);
    }
  }

  const ordered = [...people].sort((a, b) => Number(b === viewer) - Number(a === viewer) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    people: ordered.map((id) => ({ id, agents: byAttention(agentsOf.get(id) ?? []), needs: needsOf(id, board.waiting, issues) })),
    unassigned: board.issues.filter((issue) => isOpen(issue) && issue.issue.assignees.length === 0),
  };
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
