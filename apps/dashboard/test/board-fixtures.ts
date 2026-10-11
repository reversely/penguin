// Board values for the dashboard's pure tests (board-view.test.ts, team-view.test.ts), each built
// the way GET /api/board returns it.

import type {
  BoardIdentity,
  BoardIssue,
  IssuePageAssignee,
  IssuePageCheck,
  IssuePageReview,
  IssuePageState,
  IssuePageThread,
} from "@penguin/protocol";

export const running = { id: "session-1", vendor: "codex", branch: "reports/retention", status: "running" as const };

/** An issue page thread Jun opened, with `fields` replacing any of its fields. */
export function thread(fields: Partial<IssuePageThread>): IssuePageThread {
  return {
    id: "t1",
    status: "open",
    needsPersonIds: [],
    body: "A limit of five still joins the tablet's users.",
    anchor: null,
    openedBy: "jun",
    participants: ["jun"],
    resolvedBy: null,
    resolveReason: null,
    ...fields,
  };
}

export function identity(id: string, session: IssuePageAssignee["session"] = running): IssuePageAssignee {
  return { kind: "identity", id, session, waitingFor: session === null ? "session" : null };
}

export function person(id: string): IssuePageAssignee {
  return { kind: "person", id, session: null, waitingFor: null };
}

export function check(result: IssuePageCheck["result"], test = "test_retention::dau_stable"): IssuePageCheck {
  const opId = `op-${test}-${result}`;
  return { opId, commandId: "analytics", repo: "huddle-031", sha: "7c41e2a9", test, result, logRef: null, fingerprint: null, supersededBy: null };
}

export function review(reviewer: string, verdict: IssuePageReview["verdict"]): IssuePageReview {
  return {
    opId: `op-${reviewer}-${verdict}`,
    reviewer,
    verdict,
    reason: null,
    repo: "owner-jun",
    sha: "9d0e11f2",
    counts: true,
    uncountedReason: null,
  };
}

/** An issue with `fields` replacing any of its fields; each assignee's lane owner is its owner half. */
export function issue(
  id: string,
  state: IssuePageState,
  fields: Partial<BoardIssue["issue"]> = {},
  extra: Partial<Omit<BoardIssue, "issue">> = {},
): BoardIssue {
  const assignees = fields.assignees ?? [];
  return {
    issue: {
      id,
      alias: null,
      title: `Issue ${id}`,
      body: "",
      state,
      stateReason: null,
      labels: [],
      parentId: null,
      version: 1,
      assignees,
      commits: [],
      checks: [],
      reviews: [],
      threads: [],
      ...fields,
    },
    subIssues: [],
    laneOwners: Object.fromEntries(
      assignees.map((assignee) => [assignee.id, [assignee.kind === "person" ? assignee.id : assignee.id.slice(1, assignee.id.indexOf("/"))]]),
    ),
    ...extra,
  };
}

/** An identity as the board lists it, with `sessions` running sessions. */
export function boardIdentity(handle: string, sessions = 1, team = false): BoardIdentity {
  return {
    handle,
    name: handle.slice(handle.indexOf("/") + 1),
    avatar: null,
    team,
    sessions: Array.from({ length: sessions }, (_, n) => ({
      id: n === 0 ? "session-1" : `session-${n + 1}`,
      vendor: "codex",
      branch: "main",
      lastSeen: "2026-10-10T12:00:00.000Z",
    })),
  };
}
