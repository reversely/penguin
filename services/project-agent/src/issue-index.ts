// The ProjectAgent's issue index: validates each operation, reduces it into its issue's state and
// writes the result to SQL with one AppliedOp row per operation. It talks to SQL through `SqlDatabase`,
// so the Durable Object's storage runs it in the Worker and node:sqlite runs it in tests.

import {
  canonicalBytes,
  issueKey,
  reduce,
  validate,
  type BridgeKey,
  type Comment,
  type IssueRecord,
  type IssueStateName,
  type RejectReason,
  type ReduceRejectReason,
  type Thread,
} from "@penguin/issues";
import { authorSegment, validateOperation, parseOperationFile, type Operation } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

export type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

/** The SQL access the index needs. Every value reaches SQL as a bound parameter. */
export interface SqlDatabase {
  exec(query: string, ...bindings: SqlValue[]): Row[];
  /** Runs `body` in one transaction, rolling back every write if it throws. */
  transaction<T>(body: () => T): T;
}

/** The keys and scope map the validator checks an operation against. */
export interface OperationKeys {
  readonly bridges: readonly BridgeKey[];
  readonly serviceKey: CryptoKey;
  readonly scopeMap: ScopeMap;
}

export interface ApplyInput {
  /** The operation file's bytes or text, or an already parsed operation from MCP or the dashboard. */
  readonly file: unknown;
  /** The issues repo commit that added the file, or null for an operation not yet in the Git log. */
  readonly gitCommit: string | null;
  /** The file's path in the issues repo, when it was read from there. */
  readonly path?: string;
  readonly keys: OperationKeys;
}

export type ApplyOutcome =
  | { readonly status: "applied"; readonly opId: string; readonly issueId: string; readonly version: number }
  | {
      readonly status: "rejected";
      /** The AppliedOp key: the op_id, or "sha256:<hex>" when the op_id was not authenticated. */
      readonly opId: string;
      readonly issueId: string | null;
      readonly reason: RejectReason | ReduceRejectReason;
      readonly message: string;
    }
  | { readonly status: "duplicate"; readonly opId: string };

export interface TimelineEntry {
  readonly seq: number;
  readonly opId: string;
  readonly statedOpId: string | null;
  readonly author: string | null;
  readonly type: string | null;
  readonly payload: unknown;
  readonly status: "applied" | "rejected";
  readonly rejectReason: string | null;
  readonly message: string | null;
  readonly gitCommit: string | null;
}

/**
 * Rejections the validator gives only after the signature verified under a key bound to the author.
 * Only these, and accepted operations, claim their op_id. Any pusher can write a file that names
 * someone else's op_id, so an unauthenticated rejection is keyed by its content hash instead; keying
 * it by op_id would let a forger block the real operation as a duplicate.
 */
const AUTHENTICATED_REJECTIONS: ReadonlySet<RejectReason> = new Set([
  "superseded_version",
  "unknown_version",
  "no_right",
]);

const ISSUE_IN_PATH = /^issues\/([a-z0-9.-]{1,128})\/ops\//u;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS Issue (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL, state_reason TEXT, labels TEXT NOT NULL, parent_id TEXT, huddle_id TEXT,
    version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS Assignment (
    issue_id TEXT NOT NULL, assignee_kind TEXT NOT NULL, assignee_id TEXT NOT NULL, session_id TEXT,
    PRIMARY KEY (issue_id, assignee_kind, assignee_id))`,
  `CREATE TABLE IF NOT EXISTS Comment (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS CommentRevision (
    comment_id TEXT NOT NULL, rev INTEGER NOT NULL, body TEXT NOT NULL, op_id TEXT NOT NULL,
    PRIMARY KEY (comment_id, rev))`,
  `CREATE TABLE IF NOT EXISTS Mention (
    op_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, mentioned_kind TEXT NOT NULL, mentioned_id TEXT NOT NULL,
    comment_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS LinkedCommit (
    op_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL, kind TEXT)`,
  `CREATE TABLE IF NOT EXISTS IssueCheck (
    op_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, command_id TEXT NOT NULL, repo TEXT NOT NULL,
    sha TEXT NOT NULL, test TEXT, result TEXT NOT NULL, log_ref TEXT)`,
  `CREATE TABLE IF NOT EXISTS SubIssue (
    child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, op_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS Review (
    op_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, reviewer_owner_id TEXT NOT NULL, verdict TEXT NOT NULL,
    reason TEXT, repo TEXT NOT NULL, commit_sha TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS Thread (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, anchor TEXT, opened_by TEXT NOT NULL,
    participants TEXT NOT NULL, needs_person_ids TEXT NOT NULL, status TEXT NOT NULL, resolved_by TEXT,
    resolve_reason TEXT, op_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS AppliedOp (
    seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, stated_op_id TEXT, issue_id TEXT, author TEXT,
    type TEXT, payload TEXT, status TEXT NOT NULL, reject_reason TEXT, message TEXT, git_commit TEXT)`,
  `CREATE INDEX IF NOT EXISTS AppliedOp_issue ON AppliedOp (issue_id, seq)`,
  `CREATE INDEX IF NOT EXISTS Comment_issue ON Comment (issue_id)`,
  `CREATE INDEX IF NOT EXISTS SubIssue_parent ON SubIssue (parent_id)`,
];

/** Child tables keyed by issue_id, read back into an IssueRecord's collections. */
const ISSUE_CHILD_TABLES = ["Assignment", "Comment", "Mention", "LinkedCommit", "IssueCheck", "Review", "Thread"];

export class IssueIndex {
  readonly #db: SqlDatabase;
  /** Issue states read from or written to SQL. The index is the only writer, so the cache stays exact. */
  readonly #cache = new Map<string, IssueRecord | undefined>();
  /** Applies run one at a time: each awaits signature checks, and two must not interleave their reads and writes. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of SCHEMA) db.exec(statement);
  }

  /** Validates, reduces and records one operation. Calls are applied in the order they are made. */
  apply(input: ApplyInput): Promise<ApplyOutcome> {
    const run = this.#queue.then(() => this.#apply(input));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** One issue's state, or undefined when it does not exist. */
  issue(id: string): IssueRecord | undefined {
    if (!this.#cache.has(id)) this.#cache.set(id, this.#load(id));
    return this.#cache.get(id);
  }

  /** One issue with every operation recorded against it, applied or rejected, in apply order. */
  read(id: string): { readonly issue: IssueRecord | undefined; readonly timeline: TimelineEntry[] } {
    const rows = this.#db.exec(`SELECT * FROM AppliedOp WHERE issue_id = ? ORDER BY seq`, id);
    return { issue: this.issue(id), timeline: rows.map(timelineEntry) };
  }

  async #apply({ file, gitCommit, path, keys }: ApplyInput): Promise<ApplyOutcome> {
    const parsed = parseInput(file);
    const issueId = parsed?.issue !== undefined ? issueKey(parsed.issue) : issueFromPath(path);
    const current = parsed === undefined ? undefined : this.issue(issueKey(parsed.issue));
    const claimed = parsed !== undefined && this.#recorded(parsed.op_id) ? [parsed.op_id] : [];

    const verdict = await validate(file, {
      ...keys,
      issue: current && { version: current.version, labels: current.labels },
      appliedOpIds: new Set(claimed),
      ...(path === undefined ? {} : { path }),
    });
    if (verdict.status === "duplicate") return verdict;

    if (verdict.status === "rejected") {
      const operation = verdict.operation;
      const opId =
        operation !== undefined && AUTHENTICATED_REJECTIONS.has(verdict.reason)
          ? operation.op_id
          : `sha256:${await sha256Hex(inputBytes(file))}`;
      if (this.#recorded(opId)) return { status: "duplicate", opId };
      return this.#reject(opId, operation, issueId, verdict.reason, verdict.message, gitCommit);
    }

    const operation = verdict.operation;
    const id = issueKey(operation.issue);
    const result = reduce(current, operation, { parentOf: (other) => this.issue(other)?.parentId });
    if (!result.ok) return this.#reject(operation.op_id, operation, id, result.reason, result.message, gitCommit);

    try {
      this.#db.transaction(() => {
        this.#writeIssue(current, result.issue);
        if (operation.type === "open_sub_issue")
          this.#setParent(issueKey(operation.payload["sub_issue"] as string | number), id);
        this.#record(operation.op_id, operation, id, "applied", null, null, gitCommit);
      });
    } catch (error) {
      // The cache may hold states the rollback undid.
      this.#cache.clear();
      throw error;
    }
    this.#cache.set(id, result.issue);
    return { status: "applied", opId: operation.op_id, issueId: id, version: result.issue.version };
  }

  #reject(
    opId: string,
    operation: Operation | undefined,
    issueId: string | null,
    reason: RejectReason | ReduceRejectReason,
    message: string,
    gitCommit: string | null,
  ): ApplyOutcome {
    this.#record(opId, operation, issueId, "rejected", reason, message, gitCommit);
    return { status: "rejected", opId, issueId, reason, message };
  }

  #recorded(opId: string): boolean {
    return this.#db.exec(`SELECT 1 FROM AppliedOp WHERE op_id = ?`, opId).length > 0;
  }

  #record(
    opId: string,
    operation: Operation | undefined,
    issueId: string | null,
    status: "applied" | "rejected",
    reason: string | null,
    message: string | null,
    gitCommit: string | null,
  ): void {
    this.#db.exec(
      `INSERT INTO AppliedOp (op_id, stated_op_id, issue_id, author, type, payload, status, reject_reason, message, git_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opId,
      operation?.op_id ?? null,
      issueId,
      operation === undefined ? null : authorSegment(operation.author),
      operation?.type ?? null,
      operation === undefined ? null : JSON.stringify(operation.payload),
      status,
      reason,
      message,
      gitCommit,
    );
  }

  #setParent(childId: string, parentId: string): void {
    const child = this.issue(childId);
    if (child === undefined) throw new Error(`sub-issue ${childId} vanished`);
    this.#db.exec(`UPDATE Issue SET parent_id = ? WHERE id = ?`, parentId, childId);
    this.#cache.set(childId, { ...child, parentId });
  }

  /** Writes the rows of `next` that differ from `prev`. Collections the reducer left alone keep their identity. */
  #writeIssue(prev: IssueRecord | undefined, next: IssueRecord): void {
    const db = this.#db;
    const id = next.id;
    db.exec(
      `INSERT OR REPLACE INTO Issue (id, kind, title, body, state, state_reason, labels, parent_id, huddle_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      next.kind,
      next.title,
      next.body,
      next.state,
      next.stateReason,
      JSON.stringify(next.labels),
      next.parentId,
      next.huddleId,
      next.version,
    );
    diff(prev?.assignments, next.assignments, {
      upsert: (a) =>
        db.exec(
          `INSERT OR REPLACE INTO Assignment (issue_id, assignee_kind, assignee_id, session_id) VALUES (?, ?, ?, NULL)`,
          id,
          a.assigneeKind,
          a.assigneeId,
        ),
      remove: (a) =>
        db.exec(
          `DELETE FROM Assignment WHERE issue_id = ? AND assignee_kind = ? AND assignee_id = ?`,
          id,
          a.assigneeKind,
          a.assigneeId,
        ),
    });
    diff(prev?.comments, next.comments, {
      upsert: (c, old) => {
        db.exec(
          `INSERT OR REPLACE INTO Comment (id, issue_id, author, body) VALUES (?, ?, ?, ?)`,
          c.id,
          id,
          c.author,
          c.body,
        );
        c.revisions
          .slice(old?.revisions.length ?? 0)
          .forEach((revision, index) =>
            db.exec(
              `INSERT INTO CommentRevision (comment_id, rev, body, op_id) VALUES (?, ?, ?, ?)`,
              c.id,
              (old?.revisions.length ?? 0) + index + 1,
              revision.body,
              revision.opId,
            ),
          );
      },
    });
    diff(prev?.mentions, next.mentions, {
      upsert: (m) =>
        db.exec(
          `INSERT OR REPLACE INTO Mention (op_id, issue_id, mentioned_kind, mentioned_id, comment_id) VALUES (?, ?, ?, ?, ?)`,
          m.opId,
          id,
          m.mentionedKind,
          m.mentionedId,
          m.commentId,
        ),
    });
    diff(prev?.linkedCommits, next.linkedCommits, {
      upsert: (l) =>
        db.exec(
          `INSERT OR REPLACE INTO LinkedCommit (op_id, issue_id, repo, sha, kind) VALUES (?, ?, ?, ?, ?)`,
          l.opId,
          id,
          l.repo,
          l.sha,
          l.kind,
        ),
    });
    diff(prev?.checks, next.checks, {
      upsert: (c) =>
        db.exec(
          `INSERT OR REPLACE INTO IssueCheck (op_id, issue_id, command_id, repo, sha, test, result, log_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          c.opId,
          id,
          c.commandId,
          c.repo,
          c.sha,
          c.test,
          c.result,
          c.logRef,
        ),
    });
    diff(prev?.subIssues, next.subIssues, {
      upsert: (s) =>
        db.exec(`INSERT OR REPLACE INTO SubIssue (child_id, parent_id, op_id) VALUES (?, ?, ?)`, s.childId, id, s.opId),
    });
    diff(prev?.reviews, next.reviews, {
      upsert: (r) =>
        db.exec(
          `INSERT OR REPLACE INTO Review (op_id, issue_id, reviewer_owner_id, verdict, reason, repo, commit_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          r.opId,
          id,
          r.reviewerOwnerId,
          r.verdict,
          r.reason,
          r.repo,
          r.sha,
        ),
    });
    diff(prev?.threads, next.threads, {
      upsert: (t) =>
        db.exec(
          `INSERT OR REPLACE INTO Thread (id, issue_id, body, anchor, opened_by, participants, needs_person_ids, status,
             resolved_by, resolve_reason, op_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          t.id,
          id,
          t.body,
          t.anchor,
          t.openedBy,
          JSON.stringify(t.participants),
          JSON.stringify(t.needsPersonIds),
          t.status,
          t.resolvedBy,
          t.resolveReason,
          t.id,
        ),
    });
  }

  #load(id: string): IssueRecord | undefined {
    const [issue] = this.#db.exec(`SELECT * FROM Issue WHERE id = ?`, id);
    if (issue === undefined) return undefined;
    const [assignments, comments, mentions, links, checks, reviews, threads] = ISSUE_CHILD_TABLES.map((table) =>
      // Table names come from the constant list above, never from input.
      this.#db.exec(`SELECT * FROM ${table} WHERE issue_id = ? ORDER BY rowid`, id),
    ) as [Row[], Row[], Row[], Row[], Row[], Row[], Row[]];
    const revisions = this.#db.exec(
      `SELECT r.* FROM CommentRevision r JOIN Comment c ON c.id = r.comment_id WHERE c.issue_id = ? ORDER BY r.comment_id, r.rev`,
      id,
    );
    const revisionsByComment = new Map<string, { body: string; opId: string }[]>();
    for (const r of revisions) {
      const list = revisionsByComment.get(r["comment_id"] as string) ?? [];
      list.push({ body: r["body"] as string, opId: r["op_id"] as string });
      revisionsByComment.set(r["comment_id"] as string, list);
    }
    const subIssues = this.#db.exec(`SELECT * FROM SubIssue WHERE parent_id = ? ORDER BY rowid`, id);
    const text = (row: Row, column: string): string => row[column] as string;
    const nullable = (row: Row, column: string): string | null => (row[column] as string | null) ?? null;
    return {
      id,
      kind: "issue",
      title: text(issue, "title"),
      body: text(issue, "body"),
      state: text(issue, "state") as IssueStateName,
      stateReason: nullable(issue, "state_reason"),
      labels: JSON.parse(text(issue, "labels")) as string[],
      parentId: nullable(issue, "parent_id"),
      huddleId: nullable(issue, "huddle_id"),
      version: Number(issue["version"]),
      assignments: keyed(
        assignments,
        (r) => `${text(r, "assignee_kind")}:${text(r, "assignee_id")}`,
        (r) => ({
          assigneeKind: text(r, "assignee_kind") as "person" | "identity",
          assigneeId: text(r, "assignee_id"),
        }),
      ),
      comments: keyed(
        comments,
        (r) => text(r, "id"),
        (r): Comment => ({
          id: text(r, "id"),
          author: text(r, "author"),
          body: text(r, "body"),
          revisions: revisionsByComment.get(text(r, "id")) ?? [],
        }),
      ),
      mentions: keyed(
        mentions,
        (r) => text(r, "op_id"),
        (r) => ({
          opId: text(r, "op_id"),
          mentionedKind: text(r, "mentioned_kind") as "person" | "identity",
          mentionedId: text(r, "mentioned_id"),
          commentId: nullable(r, "comment_id"),
        }),
      ),
      linkedCommits: keyed(
        links,
        (r) => text(r, "op_id"),
        (r) => ({
          opId: text(r, "op_id"),
          repo: text(r, "repo"),
          sha: text(r, "sha"),
          kind: nullable(r, "kind") as "trigger" | "fix" | "related" | null,
        }),
      ),
      checks: keyed(
        checks,
        (r) => text(r, "op_id"),
        (r) => ({
          opId: text(r, "op_id"),
          commandId: text(r, "command_id"),
          repo: text(r, "repo"),
          sha: text(r, "sha"),
          test: nullable(r, "test"),
          result: text(r, "result") as "pass" | "fail" | "error",
          logRef: nullable(r, "log_ref"),
        }),
      ),
      subIssues: keyed(
        subIssues,
        (r) => text(r, "child_id"),
        (r) => ({
          childId: text(r, "child_id"),
          opId: text(r, "op_id"),
        }),
      ),
      reviews: keyed(
        reviews,
        (r) => text(r, "op_id"),
        (r) => ({
          opId: text(r, "op_id"),
          reviewerOwnerId: text(r, "reviewer_owner_id"),
          verdict: text(r, "verdict") as "approve" | "request_changes",
          reason: nullable(r, "reason"),
          repo: text(r, "repo"),
          sha: text(r, "commit_sha"),
        }),
      ),
      threads: keyed(
        threads,
        (r) => text(r, "id"),
        (r): Thread => ({
          id: text(r, "id"),
          body: text(r, "body"),
          anchor: nullable(r, "anchor"),
          openedBy: text(r, "opened_by"),
          participants: JSON.parse(text(r, "participants")) as string[],
          needsPersonIds: JSON.parse(text(r, "needs_person_ids")) as string[],
          status: text(r, "status") as "open" | "resolved",
          resolvedBy: nullable(r, "resolved_by"),
          resolveReason: nullable(r, "resolve_reason"),
        }),
      ),
    };
  }
}

function keyed<V>(rows: Row[], key: (row: Row) => string, value: (row: Row) => V): ReadonlyMap<string, V> {
  return new Map(rows.map((row) => [key(row), value(row)]));
}

/** Calls `upsert` for each entry that is new or replaced, and `remove` for each entry that is gone. */
function diff<V>(
  prev: ReadonlyMap<string, V> | undefined,
  next: ReadonlyMap<string, V>,
  write: { upsert: (value: V, old: V | undefined) => void; remove?: (value: V) => void },
): void {
  if (prev === next) return;
  for (const [key, value] of next) {
    const old = prev?.get(key);
    if (old !== value) write.upsert(value, old);
  }
  if (prev === undefined || write.remove === undefined) return;
  for (const [key, value] of prev) if (!next.has(key)) write.remove(value);
}

function timelineEntry(row: Row): TimelineEntry {
  const payload = row["payload"] as string | null;
  return {
    seq: Number(row["seq"]),
    opId: row["op_id"] as string,
    statedOpId: (row["stated_op_id"] as string | null) ?? null,
    author: (row["author"] as string | null) ?? null,
    type: (row["type"] as string | null) ?? null,
    payload: payload === null ? null : (JSON.parse(payload) as unknown),
    status: row["status"] as "applied" | "rejected",
    rejectReason: (row["reject_reason"] as string | null) ?? null,
    message: (row["message"] as string | null) ?? null,
    gitCommit: (row["git_commit"] as string | null) ?? null,
  };
}

/** The operation the input holds when it passes the schema, read only to find its issue and op_id. */
function parseInput(file: unknown): Operation | undefined {
  const result =
    file instanceof Uint8Array
      ? parseOperationFile(file)
      : typeof file === "string"
        ? parseOperationFile(new TextEncoder().encode(file))
        : validateOperation(file);
  return result.ok ? result.operation : undefined;
}

function issueFromPath(path: string | undefined): string | null {
  return path === undefined ? null : (ISSUE_IN_PATH.exec(path)?.[1] ?? null);
}

function inputBytes(file: unknown): Uint8Array {
  if (file instanceof Uint8Array) return file;
  if (typeof file === "string") return new TextEncoder().encode(file);
  try {
    return canonicalBytes(file);
  } catch {
    return new TextEncoder().encode(String(file));
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // digest() takes only ArrayBuffer-backed views, so copy the bytes into one.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
