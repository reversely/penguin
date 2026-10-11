// Builds the dashboard's issue page (PRD section 8) from the issue index and the session router: the
// issue, each sub-issue with its sessions, reviews and checks, and the timeline of applied and rejected
// operations. The result is plain JSON, so the Worker can send it as it comes from Durable Object RPC.

import type { Assignment, Check, IssueRecord, Review } from "@penguin/issues";
import type {
  IssuePage,
  IssuePageAssignee,
  IssuePageCheck,
  IssuePageReview,
  IssuePageTimelineEntry,
} from "@penguin/protocol";

import type { TimelineEntry } from "./issue-index.ts";
import type { AssignmentRoute, Session } from "./session-store.ts";

/** What the page reads: the index's issues and timeline, and the router's routes and sessions. */
export interface IssuePageSources {
  read(id: string): { readonly issue: IssueRecord | undefined; readonly timeline: readonly TimelineEntry[] };
  issue(id: string): IssueRecord | undefined;
  routes(issueId: string): readonly AssignmentRoute[];
  session(id: string): Session | undefined;
}

/** The issue page for an issue number or temporary ID, or undefined when no such issue exists. */
export function buildIssuePage(sources: IssuePageSources, id: string): IssuePage | undefined {
  const { issue, timeline } = sources.read(id);
  if (issue === undefined) return undefined;
  const linkedBy = new Map(timeline.map((entry) => [entry.opId, entry.author]));
  return {
    issue: {
      id: issue.id,
      alias: issue.alias,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      labels: issue.labels,
      parentId: issue.parentId,
      version: issue.version,
      assignees: assignees(sources, issue),
      commits: [...issue.linkedCommits.values()].map((commit) => ({
        opId: commit.opId,
        repo: commit.repo,
        sha: commit.sha,
        kind: commit.kind,
        linkedBy: linkedBy.get(commit.opId) ?? null,
      })),
      checks: [...issue.checks.values()].map(check),
      reviews: [...issue.reviews.values()].map(review),
      threads: [...issue.threads.values()].map((thread) => ({
        id: thread.id,
        status: thread.status,
        needsPersonIds: thread.needsPersonIds,
      })),
    },
    subIssues: [...issue.subIssues.values()].flatMap((link) => {
      const child = sources.issue(link.childId);
      if (child === undefined) return [];
      return [
        {
          id: child.id,
          title: child.title,
          state: child.state,
          assignees: assignees(sources, child),
          reviews: [...child.reviews.values()].map(review),
          checks: [...child.checks.values()].map(check),
        },
      ];
    }),
    timeline: timeline.map(timelineEntry),
  };
}

function assignees(sources: IssuePageSources, issue: IssueRecord): IssuePageAssignee[] {
  const routes = new Map(sources.routes(issue.id).map((route) => [route.handle, route]));
  return [...issue.assignments.values()].map((assignment: Assignment) => {
    const route = assignment.assigneeKind === "identity" ? routes.get(assignment.assigneeId) : undefined;
    const session = route?.sessionId == null ? undefined : sources.session(route.sessionId);
    return {
      kind: assignment.assigneeKind,
      id: assignment.assigneeId,
      session:
        session === undefined
          ? null
          : { id: session.id, vendor: session.vendor, branch: session.branch, status: session.status },
      waitingFor: route?.waitingFor ?? null,
    };
  });
}

function check(value: Check): IssuePageCheck {
  return { ...value };
}

function review(value: Review): IssuePageReview {
  return {
    opId: value.opId,
    reviewer: value.reviewerOwnerId,
    verdict: value.verdict,
    reason: value.reason,
    repo: value.repo,
    sha: value.sha,
    counts: value.counts,
    uncountedReason: value.uncountedReason,
  };
}

function timelineEntry(entry: TimelineEntry): IssuePageTimelineEntry {
  return {
    seq: entry.seq,
    opId: entry.opId,
    author: entry.author,
    type: entry.type,
    payload: entry.payload,
    status: entry.status,
    rejectReason: entry.rejectReason,
    message: entry.message,
    gitCommit: entry.gitCommit,
    waitingForGitLog: entry.waitingForGitLog,
  };
}
