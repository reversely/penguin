// Derives an issue's state from its operations, one operation at a time. The reducer is pure: it
// reads only its arguments, never mutates them, and returns either the next state or a rejection.
// Unchanged parts of the state keep their identity, so a store can write only what changed.
//
// It runs after the validator, which has already checked form, signature, author, base version and
// charter. The reducer checks what needs the issue's contents: that the issue exists, and that a
// referenced comment, thread or sub-issue exists and is in a state that allows the operation. It also
// records whether a review counts toward approval, which depends on the issue's scope labels: a review
// from someone without review rights is kept as a comment that does not count (PRD sections 5 and 14).
//
// A create that names its own op_id as the issue (a bridge's create, written without a number) is
// renumbered: the issue takes the number the context assigns and keeps the op_id as its alias. Every
// later reference to the alias, as an operation's issue or as a sub-issue, resolves to the number
// through the context (#48).

import { reviewRight } from "@penguin/policies";
import { authorSegment, isTemporaryIssueId, type IssueId, type Operation, type Party } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

export const REDUCE_REJECT_REASONS = [
  /** The operation is not a create, and its issue does not exist. */
  "no_issue",
  /** A create names an issue that already exists. */
  "issue_exists",
  /** A create names a string issue id other than its own op_id. */
  "create_id_mismatch",
  /** The comment it edits or mentions from is not a comment on this issue. */
  "unknown_comment",
  /** The thread it replies to or resolves is not a thread on this issue. */
  "unknown_thread",
  /** The thread it replies to or resolves is already resolved. */
  "thread_resolved",
  /** The sub-issue is the issue itself. */
  "sub_issue_self",
  /** The sub-issue does not exist. */
  "sub_issue_unknown",
  /** The sub-issue already has a parent. */
  "sub_issue_has_parent",
  /** The sub-issue is this issue's parent or an ancestor of it. */
  "sub_issue_cycle",
] as const;

export type ReduceRejectReason = (typeof REDUCE_REJECT_REASONS)[number];

export type IssueStateName = "open" | "detected" | "fixing" | "verifying" | "in_review" | "closed";

export interface Assignment {
  readonly assigneeKind: "person" | "identity";
  readonly assigneeId: string;
}

export interface CommentRevision {
  readonly body: string;
  /** The op_id of the comment or edit_comment operation that wrote this text. */
  readonly opId: string;
}

export interface Comment {
  /** The op_id of the comment operation. */
  readonly id: string;
  /** The author segment of the comment's author. */
  readonly author: string;
  readonly body: string;
  /** Every text the comment has held, oldest first; the last is the current body. */
  readonly revisions: readonly CommentRevision[];
}

export interface Mention {
  readonly opId: string;
  readonly mentionedKind: "person" | "identity";
  readonly mentionedId: string;
  readonly commentId: string | null;
}

export interface LinkedCommit {
  readonly opId: string;
  readonly repo: string;
  readonly sha: string;
  readonly kind: "trigger" | "fix" | "related" | null;
}

export interface Check {
  readonly opId: string;
  readonly commandId: string;
  readonly repo: string;
  readonly sha: string;
  readonly test: string | null;
  readonly result: "pass" | "fail" | "error";
  readonly logRef: string | null;
  /** The result's fingerprint (tested commit, lockfiles and command ID), or null when none was given. */
  readonly fingerprint: string | null;
}

export interface SubIssue {
  readonly childId: string;
  readonly opId: string;
}

export interface Review {
  readonly opId: string;
  /** The author segment of the reviewer: an owner's person id when the review counts. */
  readonly reviewerOwnerId: string;
  readonly verdict: "approve" | "request_changes";
  readonly reason: string | null;
  readonly repo: string;
  readonly sha: string;
  /**
   * True when the reviewer held review rights on the issue when the review was applied. A review
   * without rights stays on the issue as a comment, and approval must leave it out.
   */
  readonly counts: boolean;
  /** Why the review does not count, or null when it counts. */
  readonly uncountedReason: string | null;
}

export interface Thread {
  /** The op_id of the open_thread operation. */
  readonly id: string;
  readonly body: string;
  readonly anchor: string | null;
  /** The author segment of the author who opened the thread. */
  readonly openedBy: string;
  /** Author segments of everyone who opened, replied to or resolved the thread, in order of arrival. */
  readonly participants: readonly string[];
  readonly needsPersonIds: readonly string[];
  readonly status: "open" | "resolved";
  readonly resolvedBy: string | null;
  readonly resolveReason: string | null;
}

/** One issue's state. Collections are keyed by the id their table uses. */
export interface IssueRecord {
  /** The issue's number as text. */
  readonly id: string;
  /**
   * The temporary ID the issue was created under, the op_id of its create, when a bridge created it
   * without a number; null otherwise. It resolves to `id`.
   */
  readonly alias: string | null;
  readonly kind: "issue";
  readonly title: string;
  readonly body: string;
  readonly state: IssueStateName;
  readonly stateReason: string | null;
  readonly labels: readonly string[];
  readonly parentId: string | null;
  readonly huddleId: string | null;
  /** The number of operations applied to the issue. */
  readonly version: number;
  /** Keyed by `<kind>:<id>`. */
  readonly assignments: ReadonlyMap<string, Assignment>;
  readonly comments: ReadonlyMap<string, Comment>;
  readonly mentions: ReadonlyMap<string, Mention>;
  readonly linkedCommits: ReadonlyMap<string, LinkedCommit>;
  readonly checks: ReadonlyMap<string, Check>;
  /** Keyed by the sub-issue's id. */
  readonly subIssues: ReadonlyMap<string, SubIssue>;
  readonly reviews: ReadonlyMap<string, Review>;
  readonly threads: ReadonlyMap<string, Thread>;
}

/** What the reducer may ask about other issues. */
export interface ReduceContext {
  /** The parent id of an issue, null when it has none, or undefined when no such issue exists. */
  parentOf(issueId: string): string | null | undefined;
  /** The number an issue id or temporary ID resolves to, as text; an unknown id comes back unchanged. */
  resolve(issueId: string): string;
  /**
   * The number a create under a temporary ID takes: one more than the highest issue number so far.
   * It depends only on the issues applied before, so applying the same operations in the same order
   * assigns the same numbers.
   */
  nextIssueNumber(): number;
  /** The scope map a review's rights are judged by. */
  readonly scopeMap: ScopeMap;
}

export type ReduceResult =
  | { readonly ok: true; readonly issue: IssueRecord }
  | { readonly ok: false; readonly reason: ReduceRejectReason; readonly message: string };

/** The text key an issue id is stored under. A number and an op_id never share a spelling. */
export function issueKey(issue: IssueId): string {
  return String(issue);
}

/**
 * Applies one validated operation to an issue's state, or undefined for an issue that does not exist
 * yet. The caller looks the issue up through `context.resolve`, so an operation that names a
 * temporary ID reaches the numbered issue.
 */
export function reduce(issue: IssueRecord | undefined, operation: Operation, context: ReduceContext): ReduceResult {
  if (operation.type === "create") return create(issue, operation, context);
  if (issue === undefined) return reject("no_issue", `issue ${issueKey(operation.issue)} does not exist`);
  const next = apply(issue, operation, context);
  return "reason" in next ? next : { ok: true, issue: { ...next, version: issue.version + 1 } };
}

type Rejection = Extract<ReduceResult, { ok: false }>;

function reject(reason: ReduceRejectReason, message: string): Rejection {
  return { ok: false, reason, message };
}

function create(issue: IssueRecord | undefined, operation: Operation, context: ReduceContext): ReduceResult {
  if (issue !== undefined) return reject("issue_exists", `issue ${issueKey(operation.issue)} already exists`);
  const temporary = isTemporaryIssueId(operation.issue);
  if (temporary && operation.issue !== operation.op_id) {
    const message = `a create may name a temporary issue ID only by its own op_id ${operation.op_id}`;
    return reject("create_id_mismatch", message);
  }
  const payload = operation.payload as { title: string; body?: string };
  return {
    ok: true,
    issue: {
      id: temporary ? String(context.nextIssueNumber()) : issueKey(operation.issue),
      alias: temporary ? operation.op_id : null,
      kind: "issue",
      title: payload.title,
      body: payload.body ?? "",
      state: "open",
      stateReason: null,
      labels: [],
      parentId: null,
      huddleId: null,
      version: 1,
      assignments: new Map(),
      comments: new Map(),
      mentions: new Map(),
      linkedCommits: new Map(),
      checks: new Map(),
      subIssues: new Map(),
      reviews: new Map(),
      threads: new Map(),
    },
  };
}

function apply(issue: IssueRecord, operation: Operation, context: ReduceContext): IssueRecord | Rejection {
  const p = operation.payload;
  const author = authorSegment(operation.author);
  const opId = operation.op_id;
  switch (operation.type) {
    case "create":
      return reject("issue_exists", `issue ${issue.id} already exists`);
    case "edit": {
      const { title, body } = p as { title?: string; body?: string };
      return { ...issue, title: title ?? issue.title, body: body ?? issue.body };
    }
    case "comment": {
      const body = (p as { body: string }).body;
      const comment: Comment = { id: opId, author, body, revisions: [{ body, opId }] };
      return { ...issue, comments: withEntry(issue.comments, opId, comment) };
    }
    case "edit_comment": {
      const { comment: id, body } = p as { comment: string; body: string };
      const comment = issue.comments.get(id);
      if (comment === undefined) return reject("unknown_comment", `no comment ${id} on issue ${issue.id}`);
      const edited: Comment = { ...comment, body, revisions: [...comment.revisions, { body, opId }] };
      return { ...issue, comments: withEntry(issue.comments, id, edited) };
    }
    case "add_label": {
      const label = (p as { label: string }).label;
      return issue.labels.includes(label) ? issue : { ...issue, labels: [...issue.labels, label] };
    }
    case "remove_label": {
      const label = (p as { label: string }).label;
      return issue.labels.includes(label) ? { ...issue, labels: issue.labels.filter((l) => l !== label) } : issue;
    }
    case "assign": {
      const assignment = partyAssignment((p as { assignee: Party }).assignee);
      const key = `${assignment.assigneeKind}:${assignment.assigneeId}`;
      if (issue.assignments.has(key)) return issue;
      return { ...issue, assignments: withEntry(issue.assignments, key, assignment) };
    }
    case "unassign": {
      const assignment = partyAssignment((p as { assignee: Party }).assignee);
      const key = `${assignment.assigneeKind}:${assignment.assigneeId}`;
      if (!issue.assignments.has(key)) return issue;
      return { ...issue, assignments: withoutEntry(issue.assignments, key) };
    }
    case "mention": {
      const { mentioned, comment } = p as { mentioned: Party; comment?: string };
      if (comment !== undefined && !issue.comments.has(comment)) {
        return reject("unknown_comment", `no comment ${comment} on issue ${issue.id}`);
      }
      const { assigneeKind, assigneeId } = partyAssignment(mentioned);
      const mention: Mention = {
        opId,
        mentionedKind: assigneeKind,
        mentionedId: assigneeId,
        commentId: comment ?? null,
      };
      return { ...issue, mentions: withEntry(issue.mentions, opId, mention) };
    }
    case "link_commit": {
      const { commit, kind } = p as { commit: string; kind?: LinkedCommit["kind"] };
      const link: LinkedCommit = { opId, ...splitCommit(commit), kind: kind ?? null };
      return { ...issue, linkedCommits: withEntry(issue.linkedCommits, opId, link) };
    }
    case "attach_check": {
      const { command_id, commit, test, result, log_ref, fingerprint } = p as {
        command_id: string;
        commit: string;
        test?: string;
        result: Check["result"];
        log_ref?: string;
        fingerprint?: string;
      };
      const check: Check = {
        opId,
        commandId: command_id,
        ...splitCommit(commit),
        test: test ?? null,
        result,
        logRef: log_ref ?? null,
        fingerprint: fingerprint ?? null,
      };
      return { ...issue, checks: withEntry(issue.checks, opId, check) };
    }
    case "open_sub_issue": {
      const child = context.resolve(issueKey((p as { sub_issue: IssueId }).sub_issue));
      const error = subIssueError(issue, child, context);
      if (error !== undefined) return error;
      return { ...issue, subIssues: withEntry(issue.subIssues, child, { childId: child, opId }) };
    }
    case "review": {
      const { verdict, commit, reason } = p as { verdict: Review["verdict"]; commit: string; reason?: string };
      const right = reviewRight(operation.author, issue.labels, context.scopeMap);
      const review: Review = {
        opId,
        reviewerOwnerId: author,
        verdict,
        reason: reason ?? null,
        ...splitCommit(commit),
        counts: right.allowed,
        uncountedReason: right.allowed ? null : right.message,
      };
      return { ...issue, reviews: withEntry(issue.reviews, opId, review) };
    }
    case "open_thread": {
      const { body, anchor, needs } = p as { body: string; anchor?: string; needs?: string[] };
      const thread: Thread = {
        id: opId,
        body,
        anchor: anchor ?? null,
        openedBy: author,
        participants: [author],
        needsPersonIds: needs ?? [],
        status: "open",
        resolvedBy: null,
        resolveReason: null,
      };
      return { ...issue, threads: withEntry(issue.threads, opId, thread) };
    }
    case "reply_thread":
    case "resolve_thread": {
      const { thread: id, reason } = p as { thread: string; reason?: string };
      const thread = issue.threads.get(id);
      if (thread === undefined) return reject("unknown_thread", `no thread ${id} on issue ${issue.id}`);
      if (thread.status === "resolved") return reject("thread_resolved", `thread ${id} is already resolved`);
      const participants = thread.participants.includes(author)
        ? thread.participants
        : [...thread.participants, author];
      const updated: Thread =
        operation.type === "reply_thread"
          ? { ...thread, participants }
          : { ...thread, participants, status: "resolved", resolvedBy: author, resolveReason: reason ?? null };
      return { ...issue, threads: withEntry(issue.threads, id, updated) };
    }
    case "change_state": {
      const { state, reason } = p as { state: IssueStateName; reason: string };
      return { ...issue, state, stateReason: reason };
    }
  }
}

function subIssueError(issue: IssueRecord, child: string, context: ReduceContext): Rejection | undefined {
  if (child === issue.id) return reject("sub_issue_self", `issue ${issue.id} cannot be its own sub-issue`);
  const childParent = context.parentOf(child);
  if (childParent === undefined) return reject("sub_issue_unknown", `issue ${child} does not exist`);
  if (childParent !== null)
    return reject("sub_issue_has_parent", `issue ${child} is already a sub-issue of ${childParent}`);
  // Walk up from this issue; parents form a forest, so the walk ends. The seen set guards a corrupt index.
  const seen = new Set<string>();
  for (let at: string | null | undefined = issue.parentId; at != null && !seen.has(at); at = context.parentOf(at)) {
    if (at === child) return reject("sub_issue_cycle", `issue ${child} is an ancestor of issue ${issue.id}`);
    seen.add(at);
  }
  return undefined;
}

function partyAssignment(party: Party): Assignment {
  return "person" in party
    ? { assigneeKind: "person", assigneeId: party.person }
    : { assigneeKind: "identity", assigneeId: party.identity };
}

/** Splits "<repo>@<sha>"; the schema guarantees exactly one "@". */
function splitCommit(commit: string): { repo: string; sha: string } {
  const at = commit.indexOf("@");
  return { repo: commit.slice(0, at), sha: commit.slice(at + 1) };
}

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  return new Map(map).set(key, value);
}

function withoutEntry<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}
