// The ProjectAgent's issue index: validates each operation, reduces it into its issue's state and
// writes the result to SQL with one AppliedOp row per operation. It talks to SQL through `SqlDatabase`,
// so the Durable Object's storage runs it in the Worker and node:sqlite runs it in tests.
//
// Operations from MCP, the dashboard and Penguin arrive through `submit`: the index signs them with
// the service key, applies them at once and holds them in PendingOp until the runner pushes them to
// the issues repo. The push event then reaches `apply`, which drops the PendingOp row and records
// the commit on the existing AppliedOp row (PRD sections 5, 7 and 12).
//
// An operation an identity authors is checked against the identity's charter, which `keys.identities`
// supplies. A team identity's rights depend on the owner who assigned it to the issue, which the index
// reads from its AppliedOp log: the first applied assign of the identity since its last applied unassign.
//
// An `IndexListener` hears of each assignment an applied operation adds or removes and of each change
// the operation makes to its issue, inside the operation's transaction, so the session router
// (session-store.ts) routes and the inbox (inbox-store.ts) derives its items in the same write.
//
// An issue a bridge creates offline names its create's op_id as a temporary ID. Applying that create
// gives the issue the next number, one more than the highest number in the Issue table, and keeps the
// temporary ID in Issue.alias (#48). The number depends only on the creates applied before it, so a
// rebuild that applies the same files in the same Git order assigns the same numbers. From then on
// the temporary ID resolves to the number wherever an issue is named: an operation's issue, a
// sub-issue link, and every lookup by id. The files stay where they are in the issues repo. A
// submission to a renumbered issue is written under the temporary ID, so all of the issue's files
// share one folder and the bridge, which never learns the number, counts them all for its base version.

import {
  canonicalBytes,
  type Assignment,
  canonicalJson,
  issueKey,
  reduce,
  signOperation,
  validate,
  type BridgeKey,
  type CharterIdentity,
  type Comment,
  type Delegates,
  type FixLookup,
  type HuddleContext,
  type IssueRecord,
  type IssueStateName,
  type LinkedCommit,
  type RejectReason,
  type ReduceRejectReason,
  type Thread,
} from "@penguin/issues";
import {
  authorSegment,
  formatOpId,
  operationPath,
  parseOperationFile,
  validateOperation,
  WEB_WRITER_TAG,
  type Author,
  type Operation,
  type UnsignedOperation,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

export type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

/** The SQL access the index needs. Every value reaches SQL as a bound parameter. */
export interface SqlDatabase {
  exec(query: string, ...bindings: SqlValue[]): Row[];
  /** Runs `body` in one transaction, rolling back every write if it throws. */
  transaction<T>(body: () => T): T;
}

/** The keys, scope map and identities the validator checks an operation against. */
export interface OperationKeys {
  readonly bridges: readonly BridgeKey[];
  readonly serviceKey: CryptoKey;
  readonly scopeMap: ScopeMap;
  /** Each owner's delegate, from the base repo's `penguin/owners.json`. None when absent. */
  readonly delegates?: Delegates;
  /** Finds an identity by handle for the charter check: the ProjectAgent's identity store. */
  readonly identities: IdentitySource;
  /** The Huddle fix sub-issues a send_upstream may name (the Huddle store). Without it, none is a fix. */
  readonly fixes?: FixLookup;
  /** The Huddle issues whose close the close rule judges (the Huddle store). Without it, none is. */
  readonly huddles?: HuddleLookup;
}

/** Which issues are Huddle issues, and who started each Huddle's work. */
export interface HuddleLookup {
  /** The owner whose checkpoint triggered the Huddle whose issue has this number, or undefined. */
  startedBy(issueId: string): string | undefined;
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

/** Finds an identity by handle for the charter check. The identity store is one. */
export interface IdentitySource {
  byHandle(handle: string): CharterIdentity | undefined;
}

/**
 * Hears of the assignments an applied operation added or removed. It runs inside the operation's
 * transaction, after the issue is written: it must not open a transaction of its own, and a throw
 * rolls the operation back.
 */
export interface AssignmentListener {
  assignmentsChanged(issueId: string, added: readonly Assignment[], removed: readonly Assignment[]): void;
}

/** One applied operation's effect on its issue. */
export interface IssueChange {
  readonly issueId: string;
  /** The issue before the operation, or undefined when the operation created it. */
  readonly previous: IssueRecord | undefined;
  readonly next: IssueRecord;
  readonly author: Author;
}

/**
 * Hears of each applied operation. Both calls run inside the operation's transaction, under the
 * AssignmentListener rules: `assignmentsChanged` first, then `issueChanged`.
 */
export interface IndexListener extends Partial<AssignmentListener> {
  issueChanged?(change: IssueChange): void;
  /**
   * Hears of a timeline change that leaves the issue's state as it was: a rejected operation recorded
   * against the issue, or a pending operation the runner pushed to the Git log. It runs after the
   * write, outside any transaction.
   */
  timelineChanged?(issueId: string): void;
}

/** Where a submitted operation came from. Penguin's own operations wait for the runner as well. */
export type PendingSource = "mcp" | "dashboard" | "penguin";

export interface SubmitInput {
  /** The caller's operation: `issue`, `type`, `base_version` and `payload`. Penguin sets the rest. */
  readonly operation: unknown;
  /** The author the gateway authenticated. The operation may repeat it but never name anyone else. */
  readonly author: Author;
  readonly source: PendingSource;
  /** The private half of the service key (K5). It signs the operation and is never stored or returned. */
  readonly signingKey: CryptoKey;
  readonly keys: OperationKeys;
  /** Milliseconds since the epoch, for PendingOp.created_at. */
  readonly now?: number;
  /**
   * Rejections the issue records, as it records a bridge's rejected operation: the AppliedOp row
   * shows the operation rejected with its reason, and PendingOp queues it for the Git log. Only a
   * rejection the validator gives after the signature verified, or the reducer gives, can be
   * recorded. Every other rejection goes back unrecorded.
   */
  readonly recordRejections?: readonly (RejectReason | ReduceRejectReason)[];
}

/**
 * A rejected submission goes back to the caller and is recorded nowhere, so the caller can retry,
 * unless its reason is one the submission asked to record: then `opId` names the recorded operation.
 */
export type SubmitOutcome =
  | {
      readonly status: "applied";
      readonly opId: string;
      readonly issueId: string;
      readonly version: number;
      readonly path: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: RejectReason | ReduceRejectReason;
      readonly message: string;
      /** The op_id of the recorded rejected operation, when the rejection was recorded. */
      readonly opId?: string;
    };

/** A caller the gateway authenticated by its bridge token (K4), with the role the token grants. */
export interface BridgeCaller {
  readonly bridgeId: string;
  readonly role: "owner" | "runner";
}

/** One operation waiting for the runner, as the file the runner writes at `path` in the issues repo. */
export interface PendingFile {
  readonly opId: string;
  readonly path: string;
  /** The signed operation file's text. */
  readonly file: string;
  readonly source: PendingSource;
  readonly createdAt: number;
}

export type PendingListing =
  | { readonly status: "ok"; readonly files: PendingFile[] }
  | { readonly status: "forbidden"; readonly message: string };

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
  /** True while the operation is applied in the index but not yet pushed to the issues repo. */
  readonly waitingForGitLog: boolean;
}

/** A submission's PendingOp fields and the rejections it records. */
interface PendingWrite {
  readonly source: PendingSource;
  readonly now: number;
  readonly record: ReadonlySet<string>;
}

/** Fields a submission may carry. Penguin fills `schema_version`, `op_id` and `signature`. */
const DRAFT_FIELDS: ReadonlySet<string> = new Set(["issue", "type", "base_version", "payload", "author"]);

/**
 * Rejections the validator gives only after the signature verified under a key bound to the author.
 * Only these, and accepted operations, claim their op_id. Any pusher can write a file that names
 * someone else's op_id, so an unauthenticated rejection is keyed by its content hash instead; keying
 * it by op_id would let a forger block the real operation as a duplicate.
 */
const AUTHENTICATED_REJECTIONS: ReadonlySet<RejectReason> = new Set([
  "superseded_version",
  "unknown_version",
  "outside_charter",
  "not_a_fix",
  "inside_charter",
]);

const ISSUE_IN_PATH = /^issues\/([a-z0-9.-]{1,128})\/ops\//u;

/** The index's tables and SQL indexes. The rebuild reads the names here to build its shadow copies. */
export const ISSUE_INDEX_SCHEMA: readonly string[] = [
  // `alias` is the temporary ID of an issue created offline. It comes last, where ISSUE_COLUMNS adds
  // it to a table created before it.
  `CREATE TABLE IF NOT EXISTS Issue (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL, state_reason TEXT, labels TEXT NOT NULL, parent_id TEXT, huddle_id TEXT,
    version INTEGER NOT NULL, alias TEXT)`,
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
    sha TEXT NOT NULL, test TEXT, result TEXT NOT NULL, log_ref TEXT, fingerprint TEXT, superseded_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS SubIssue (
    child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, op_id TEXT NOT NULL)`,
  // `counts` is 0 for a review from someone without review rights; `uncounted_reason` says why.
  // `counts_for` is the JSON list of owners whose approval the review stands for. The three come last,
  // where REVIEW_COLUMNS adds them to a table created before them.
  `CREATE TABLE IF NOT EXISTS Review (
    op_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, reviewer_owner_id TEXT NOT NULL, verdict TEXT NOT NULL,
    reason TEXT, repo TEXT NOT NULL, commit_sha TEXT NOT NULL, counts INTEGER NOT NULL DEFAULT 1,
    uncounted_reason TEXT, counts_for TEXT)`,
  `CREATE TABLE IF NOT EXISTS Thread (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, anchor TEXT, opened_by TEXT NOT NULL,
    participants TEXT NOT NULL, needs_person_ids TEXT NOT NULL, status TEXT NOT NULL, resolved_by TEXT,
    resolve_reason TEXT, op_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS AppliedOp (
    seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, stated_op_id TEXT, issue_id TEXT, author TEXT,
    type TEXT, payload TEXT, status TEXT NOT NULL, reject_reason TEXT, message TEXT, git_commit TEXT)`,
  // `file` holds the signed operation file the runner pushes; the PRD names the other three columns.
  `CREATE TABLE IF NOT EXISTS PendingOp (
    op_id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at INTEGER NOT NULL, file TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS Issue_alias ON Issue (alias)`,
  `CREATE INDEX IF NOT EXISTS AppliedOp_issue ON AppliedOp (issue_id, seq)`,
  `CREATE INDEX IF NOT EXISTS AppliedOp_author ON AppliedOp (author)`,
  `CREATE INDEX IF NOT EXISTS Comment_issue ON Comment (issue_id)`,
  `CREATE INDEX IF NOT EXISTS SubIssue_parent ON SubIssue (parent_id)`,
  // The session router finds an identity's assignments and a session's routed issues.
  `CREATE INDEX IF NOT EXISTS Assignment_assignee ON Assignment (assignee_kind, assignee_id)`,
  `CREATE INDEX IF NOT EXISTS Assignment_session ON Assignment (session_id)`,
];

/**
 * Review columns added after the table first shipped, with the definition that adds each to an older
 * table. Every review stored before them passed the rights check, so it counts. A counting review
 * stored before #42 has no `counts_for`; no delegate existed then, so it stands for its reviewer.
 */
const REVIEW_COLUMNS: readonly (readonly [string, string])[] = [
  ["counts", "counts INTEGER NOT NULL DEFAULT 1"],
  ["uncounted_reason", "uncounted_reason TEXT"],
  ["counts_for", "counts_for TEXT"],
];

/**
 * IssueCheck columns added after the table first shipped. A check stored before #38 has no fingerprint;
 * one stored before #41 was never superseded, because no link could supersede a check yet.
 */
const ISSUE_CHECK_COLUMNS: readonly (readonly [string, string])[] = [
  ["fingerprint", "fingerprint TEXT"],
  ["superseded_by", "superseded_by TEXT"],
];

/** Issue columns added after the table first shipped. An issue stored before #48 has no alias. */
const ISSUE_COLUMNS: readonly (readonly [string, string])[] = [["alias", "alias TEXT"]];

/** An issue number as text. Any other issue id is a temporary ID. */
const ISSUE_NUMBER = /^[0-9]+$/u;

/** Child tables keyed by issue_id, read back into an IssueRecord's collections. */
const ISSUE_CHILD_TABLES = ["Assignment", "Comment", "Mention", "LinkedCommit", "IssueCheck", "Review", "Thread"];

export class IssueIndex {
  readonly #db: SqlDatabase;
  readonly #listener: IndexListener | undefined;
  /** Issue states read from or written to SQL. The index is the only writer, so the cache stays exact. */
  readonly #cache = new Map<string, IssueRecord | undefined>();
  /** Applies run one at a time: each awaits signature checks, and two must not interleave their reads and writes. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: SqlDatabase, listener?: IndexListener) {
    this.#db = db;
    this.#listener = listener;
    // Tables first, then the columns an older table lacks, then the SQL indexes that may name them.
    const isTable = (statement: string): boolean => statement.startsWith("CREATE TABLE");
    for (const statement of ISSUE_INDEX_SCHEMA.filter(isTable)) db.exec(statement);
    addMissingColumns(db, "Review", REVIEW_COLUMNS);
    addMissingColumns(db, "Issue", ISSUE_COLUMNS);
    addMissingColumns(db, "IssueCheck", ISSUE_CHECK_COLUMNS);
    for (const statement of ISSUE_INDEX_SCHEMA.filter((statement) => !isTable(statement))) db.exec(statement);
  }

  /** Validates, reduces and records one operation. Calls are applied in the order they are made. */
  apply(input: ApplyInput): Promise<ApplyOutcome> {
    return this.#serially(() => this.#apply(input));
  }

  /**
   * Fills in the authenticated author and the author's next op_id, signs with the service key,
   * validates and applies the operation, and holds it in PendingOp for the runner. Calls share
   * `apply`'s queue, so two submissions never take the same op_id.
   */
  submit(input: SubmitInput): Promise<SubmitOutcome> {
    return this.#serially(() => this.#submit(input));
  }

  /** The operations waiting for the runner, in the order they were applied. Only the runner may list them. */
  pendingFiles(caller: BridgeCaller): PendingListing {
    if (caller.role !== "runner") {
      return { status: "forbidden", message: `bridge ${caller.bridgeId} does not hold the runner role` };
    }
    const files = this.#db.exec(`SELECT * FROM PendingOp ORDER BY rowid`).map((row): PendingFile => {
      const file = row["file"] as string;
      return {
        opId: row["op_id"] as string,
        path: operationPath(JSON.parse(file) as Operation),
        file,
        source: row["source"] as PendingSource,
        createdAt: Number(row["created_at"]),
      };
    });
    return { status: "ok", files };
  }

  /**
   * The issue number an id resolves to: a temporary ID resolves to the number its issue was given,
   * and any other id comes back unchanged.
   */
  resolve(id: string): string {
    if (ISSUE_NUMBER.test(id)) return id;
    const [row] = this.#db.exec(`SELECT id FROM Issue WHERE alias = ?`, id);
    return (row?.["id"] as string | undefined) ?? id;
  }

  /** Every issue's number, in numeric order. */
  ids(): string[] {
    return this.#db.exec(`SELECT id FROM Issue ORDER BY CAST(id AS INTEGER), id`).map((row) => row["id"] as string);
  }

  /** One issue's state, by its number or its temporary ID, or undefined when it does not exist. */
  issue(id: string): IssueRecord | undefined {
    const number = this.resolve(id);
    if (!this.#cache.has(number)) this.#cache.set(number, this.#load(number));
    return this.#cache.get(number);
  }

  /** Every open thread that needs `person`, on any issue, the most recently written last. */
  threadsNeeding(person: string): { readonly issueId: string; readonly thread: Thread }[] {
    return this.#db
      .exec(
        `SELECT t.issue_id, t.id FROM Thread t WHERE t.status = 'open'
           AND EXISTS (SELECT 1 FROM json_each(t.needs_person_ids) n WHERE n.value = ?)
         ORDER BY t.rowid`,
        person,
      )
      .flatMap((row) => {
        const issueId = row["issue_id"] as string;
        const thread = this.issue(issueId)?.threads.get(row["id"] as string);
        return thread === undefined ? [] : [{ issueId, thread }];
      });
  }

  /**
   * One issue, by its number or its temporary ID, with every operation recorded against it, applied
   * or rejected, in apply order. Operations rejected under the temporary ID before the create was
   * applied are part of the timeline.
   */
  read(id: string): { readonly issue: IssueRecord | undefined; readonly timeline: TimelineEntry[] } {
    const issue = this.issue(id);
    const number = issue?.id ?? id;
    const rows = this.#db.exec(
      `SELECT a.*, p.op_id IS NOT NULL AS waiting FROM AppliedOp a LEFT JOIN PendingOp p ON p.op_id = a.op_id
       WHERE a.issue_id IN (?, ?) ORDER BY a.seq`,
      number,
      issue?.alias ?? number,
    );
    return { issue, timeline: rows.map(timelineEntry) };
  }

  #serially<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(body);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #submit({
    operation,
    author,
    source,
    signingKey,
    keys,
    now = Date.now(),
    recordRejections = [],
  }: SubmitInput): Promise<SubmitOutcome> {
    const draft = draftFields(operation, author, source);
    if ("reason" in draft) return { status: "rejected", reason: draft.reason, message: draft.message };
    const unsigned = withoutUndefined({
      schema_version: 1,
      op_id: formatOpId(author, WEB_WRITER_TAG, this.#lastSeq(author) + 1),
      issue: draft.type === "create" ? draft.issue : this.#folderOf(draft.issue),
      type: draft.type,
      author,
      base_version: draft.base_version,
      payload: draft.payload,
    }) as UnsignedOperation;
    let signed: Operation;
    try {
      signed = await signOperation(unsigned, signingKey);
    } catch (error) {
      // canonicalJson throws on values JSON cannot hold, such as NaN.
      const detail = error instanceof Error ? error.message : String(error);
      return { status: "rejected", reason: "malformed", message: detail };
    }
    const record: ReadonlySet<string> = new Set(recordRejections);
    const outcome = await this.#apply({ file: operationFile(signed), gitCommit: null, keys }, { source, now, record });
    if (outcome.status === "rejected") {
      const { reason, message, opId } = outcome;
      return opId === "" ? { status: "rejected", reason, message } : { status: "rejected", reason, message, opId };
    }
    if (outcome.status === "duplicate") throw new Error(`op_id ${outcome.opId} was taken during submission`);
    return { ...outcome, path: operationPath(signed) };
  }

  /**
   * The owner who assigned `handle` to the issue, when the identity is assigned there now: the author
   * of the first applied assign since the last applied unassign. A person's assign names that person;
   * an identity's names the identity's owner half; Penguin's names no owner.
   */
  assigningOwner(id: string, handle: string): string | undefined {
    const issueId = this.resolve(id);
    if (!this.issue(issueId)?.assignments.has(`identity:${handle}`)) return undefined;
    const [row] = this.#db.exec(
      `SELECT author FROM AppliedOp
       WHERE issue_id = ? AND status = 'applied' AND type = 'assign'
         AND json_extract(payload, '$.assignee.identity') = ?
         AND seq > COALESCE((SELECT MAX(seq) FROM AppliedOp
           WHERE issue_id = ? AND status = 'applied' AND type = 'unassign'
             AND json_extract(payload, '$.assignee.identity') = ?), 0)
       ORDER BY seq LIMIT 1`,
      issueId,
      handle,
      issueId,
      handle,
    );
    const segment = row?.["author"];
    if (typeof segment !== "string" || segment === authorSegment({ penguin: true })) return undefined;
    // An author segment is a person id or "<owner>.<name>"; person ids contain no dots.
    return segment.split(".")[0];
  }

  /**
   * Each identity's issue history, by handle: the issues with an applied operation that assigned the
   * identity or that the identity wrote, most recent activity first. One scan of AppliedOp serves
   * every identity. History follows the handle, so a duplicate starts with none.
   */
  identityHistory(): Map<string, string[]> {
    const rows = this.#db.exec(
      `SELECT issue_id, party, MAX(seq) AS last FROM (
         SELECT issue_id, seq, json_extract(payload, '$.assignee.identity') AS party FROM AppliedOp
           WHERE status = 'applied' AND type = 'assign'
         UNION ALL
         SELECT issue_id, seq, author AS party FROM AppliedOp
           WHERE status = 'applied' AND instr(author, '.') > 0)
       WHERE party IS NOT NULL AND issue_id IS NOT NULL
       GROUP BY issue_id, party ORDER BY last DESC`,
    );
    const history = new Map<string, string[]>();
    for (const row of rows) {
      const party = String(row["party"]);
      // An author segment "<owner>.<name>" is the handle "@<owner>/<name>".
      const handle = party.startsWith("@") ? party : `@${party.replace(".", "/")}`;
      const issueId = this.resolve(String(row["issue_id"]));
      const issues = history.get(handle) ?? [];
      if (!issues.includes(issueId)) issues.push(issueId);
      history.set(handle, issues);
    }
    return history;
  }

  /**
   * The issue a submission is written under: the temporary ID of an issue created offline, however
   * the caller named it, so its files share the folder the bridge counts; otherwise the caller's value.
   */
  #folderOf(issue: unknown): unknown {
    if (typeof issue !== "number" && typeof issue !== "string") return issue;
    return this.issue(issueKey(issue))?.alias ?? issue;
  }

  /**
   * The highest sequence number among the author's op_ids under the Worker's writer tag that the
   * index holds as claimed. Bridges number their own operations under their own tags, so an offline
   * bridge's operations neither move this counter nor collide with it.
   */
  #lastSeq(author: Author): number {
    const segment = authorSegment(author);
    const prefix = `${segment}-${WEB_WRITER_TAG}-`;
    // Only applied and authenticated-rejected rows claim their op_id (op_id = stated_op_id). An
    // unauthenticated file can state any sequence number, so it must not move the counter.
    const [row] = this.#db.exec(
      `SELECT MAX(CAST(substr(op_id, ?) AS INTEGER)) AS seq FROM AppliedOp
       WHERE author = ? AND op_id = stated_op_id AND substr(op_id, 1, ?) = ?`,
      prefix.length + 1,
      segment,
      prefix.length,
      prefix,
    );
    return Number(row?.["seq"] ?? 0);
  }

  /**
   * With `pending` set, the operation comes from `submit`: a rejection goes back without a record
   * unless its reason is in `pending.record`, and an accepted or recorded operation gets its PendingOp
   * row in the same transaction as its AppliedOp row.
   */
  async #apply({ file, gitCommit, path, keys }: ApplyInput, pending?: PendingWrite): Promise<ApplyOutcome> {
    const parsed = parseInput(file);
    if (parsed !== undefined && gitCommit !== null && this.#confirmPushed(parsed, path, gitCommit)) {
      return { status: "duplicate", opId: parsed.op_id };
    }
    const stated = parsed?.issue !== undefined ? issueKey(parsed.issue) : issueFromPath(path);
    const issueId = stated === null ? null : this.resolve(stated);
    const current = parsed === undefined ? undefined : this.issue(issueKey(parsed.issue));
    const claimed = parsed !== undefined && this.#recorded(parsed.op_id) ? [parsed.op_id] : [];

    const verdict = await validate(file, {
      ...keys,
      issue: current && { version: current.version },
      appliedOpIds: new Set(claimed),
      identities: {
        identity: (handle) => keys.identities.byHandle(handle),
        assigningOwner: (issue, handle) => this.assigningOwner(issue, handle),
      },
      ...(path === undefined ? {} : { path }),
    });
    if (verdict.status === "duplicate") return verdict;

    if (verdict.status === "rejected") {
      const operation = verdict.operation;
      if (pending !== undefined) {
        // Only an authenticated rejection names an op_id the submission may claim.
        if (operation === undefined || !AUTHENTICATED_REJECTIONS.has(verdict.reason) || !pending.record.has(verdict.reason)) {
          return unrecorded(issueId, verdict.reason, verdict.message);
        }
        return this.#rejectPending(operation, issueId, verdict.reason, verdict.message, pending);
      }
      const opId =
        operation !== undefined && AUTHENTICATED_REJECTIONS.has(verdict.reason)
          ? operation.op_id
          : `sha256:${await sha256Hex(inputBytes(file))}`;
      if (this.#recorded(opId)) return { status: "duplicate", opId };
      return this.#reject(opId, operation, issueId, verdict.reason, verdict.message, gitCommit);
    }

    const operation = verdict.operation;
    const result = reduce(current, operation, {
      parentOf: (other) => this.issue(other)?.parentId,
      resolve: (other) => this.resolve(other),
      nextIssueNumber: () => this.#highestIssueNumber() + 1,
      scopeMap: keys.scopeMap,
      ...(keys.delegates === undefined ? {} : { delegates: keys.delegates }),
      huddle: (other) => this.#huddleContext(keys.huddles, other),
    });
    if (!result.ok) {
      const rejectedId = issueId ?? this.resolve(issueKey(operation.issue));
      if (pending !== undefined) {
        if (!pending.record.has(result.reason)) return unrecorded(rejectedId, result.reason, result.message);
        return this.#rejectPending(operation, rejectedId, result.reason, result.message, pending);
      }
      return this.#reject(operation.op_id, operation, rejectedId, result.reason, result.message, gitCommit);
    }
    // A renumbered create's issue takes the number the reducer assigned.
    const id = result.issue.id;

    try {
      this.#db.transaction(() => {
        this.#writeIssue(current, result.issue);
        if (operation.type === "open_sub_issue")
          this.#setParent(this.resolve(issueKey(operation.payload["sub_issue"] as string | number)), id);
        this.#record(operation.op_id, operation, id, "applied", null, null, gitCommit);
        // Set before the listener runs, so it reads the new state; the catch below clears it on rollback.
        this.#cache.set(id, result.issue);
        this.#notifyAssignments(id, current, result.issue);
        this.#listener?.issueChanged?.({ issueId: id, previous: current, next: result.issue, author: operation.author });
        if (pending !== undefined) this.#queuePending(operation, pending);
      });
    } catch (error) {
      // The cache may hold states the rollback undid.
      this.#cache.clear();
      throw error;
    }
    return { status: "applied", opId: operation.op_id, issueId: id, version: result.issue.version };
  }

  /**
   * The Huddle whose issue has this number, with its fix sub-issues as this index holds them, so a
   * rebuild judges a close by the shadow tables' state; undefined for any other issue.
   */
  #huddleContext(huddles: HuddleLookup | undefined, issueId: string): HuddleContext | undefined {
    const startedBy = huddles?.startedBy(issueId);
    const issue = startedBy === undefined ? undefined : this.issue(issueId);
    if (startedBy === undefined || issue === undefined) return undefined;
    const fixes = [...issue.subIssues.keys()].flatMap((childId) => this.issue(childId) ?? []);
    return { startedBy, fixes };
  }

  #notifyAssignments(id: string, prev: IssueRecord | undefined, next: IssueRecord): void {
    const listener = this.#listener;
    if (listener?.assignmentsChanged === undefined || prev?.assignments === next.assignments) return;
    const added = [...next.assignments].filter(([key]) => !prev?.assignments.has(key)).map(([, a]) => a);
    const removed = [...(prev?.assignments ?? [])].filter(([key]) => !next.assignments.has(key)).map(([, a]) => a);
    if (added.length > 0 || removed.length > 0) listener.assignmentsChanged(id, added, removed);
  }

  #queuePending(operation: Operation, pending: PendingWrite): void {
    this.#db.exec(
      `INSERT INTO PendingOp (op_id, source, created_at, file) VALUES (?, ?, ?, ?)`,
      operation.op_id,
      pending.source,
      pending.now,
      operationFile(operation),
    );
  }

  /** Records a submitted operation as rejected and queues it for the Git log, like a bridge's rejected file. */
  #rejectPending(
    operation: Operation,
    issueId: string | null,
    reason: RejectReason | ReduceRejectReason,
    message: string,
    pending: PendingWrite,
  ): ApplyOutcome {
    this.#db.transaction(() => {
      this.#record(operation.op_id, operation, issueId, "rejected", reason, message, null);
      this.#queuePending(operation, pending);
    });
    if (issueId !== null) this.#listener?.timelineChanged?.(issueId);
    return { status: "rejected", opId: operation.op_id, issueId, reason, message };
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
    if (issueId !== null) this.#listener?.timelineChanged?.(issueId);
    return { status: "rejected", opId, issueId, reason, message };
  }

  /**
   * When `parsed` is a pending operation arriving from the issues repo, records the commit on its
   * AppliedOp row and drops its PendingOp row. Only the exact signed operation at its own path
   * counts: anyone can push a file that names a pending op_id, and that file must not mark the real
   * operation as pushed.
   */
  #confirmPushed(parsed: Operation, path: string | undefined, gitCommit: string): boolean {
    const [row] = this.#db.exec(`SELECT file FROM PendingOp WHERE op_id = ?`, parsed.op_id);
    if (row === undefined) return false;
    if (path !== undefined && path !== operationPath(parsed)) return false;
    if (canonicalJson(JSON.parse(row["file"] as string)) !== canonicalJson(parsed)) return false;
    this.#db.transaction(() => {
      this.#db.exec(`UPDATE AppliedOp SET git_commit = ? WHERE op_id = ?`, gitCommit, parsed.op_id);
      this.#db.exec(`DELETE FROM PendingOp WHERE op_id = ?`, parsed.op_id);
    });
    const [applied] = this.#db.exec(`SELECT issue_id FROM AppliedOp WHERE op_id = ?`, parsed.op_id);
    const issueId = applied?.["issue_id"];
    if (typeof issueId === "string") this.#listener?.timelineChanged?.(issueId);
    return true;
  }

  /**
   * The highest issue number in the index, or 0 before the first. An issue stored under its temporary
   * ID before #48 has no number and does not count.
   */
  #highestIssueNumber(): number {
    const [row] = this.#db.exec(`SELECT MAX(CAST(id AS INTEGER)) AS n FROM Issue WHERE id NOT GLOB '*[^0-9]*'`);
    return Number(row?.["n"] ?? 0);
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
      `INSERT OR REPLACE INTO Issue (id, kind, title, body, state, state_reason, labels, parent_id, huddle_id, version,
         alias)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      next.alias,
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
          `INSERT OR REPLACE INTO IssueCheck (op_id, issue_id, command_id, repo, sha, test, result, log_ref,
             fingerprint, superseded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.opId,
          id,
          c.commandId,
          c.repo,
          c.sha,
          c.test,
          c.result,
          c.logRef,
          c.fingerprint,
          c.supersededBy,
        ),
    });
    diff(prev?.subIssues, next.subIssues, {
      upsert: (s) =>
        db.exec(`INSERT OR REPLACE INTO SubIssue (child_id, parent_id, op_id) VALUES (?, ?, ?)`, s.childId, id, s.opId),
    });
    diff(prev?.reviews, next.reviews, {
      upsert: (r) =>
        db.exec(
          `INSERT OR REPLACE INTO Review (op_id, issue_id, reviewer_owner_id, verdict, reason, repo, commit_sha, counts,
             uncounted_reason, counts_for)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.opId,
          id,
          r.reviewerOwnerId,
          r.verdict,
          r.reason,
          r.repo,
          r.sha,
          r.counts ? 1 : 0,
          r.uncountedReason,
          JSON.stringify(r.countsFor),
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
      alias: nullable(issue, "alias"),
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
          kind: nullable(r, "kind") as LinkedCommit["kind"],
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
          fingerprint: nullable(r, "fingerprint"),
          supersededBy: nullable(r, "superseded_by"),
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
          counts: Number(r["counts"]) === 1,
          uncountedReason: nullable(r, "uncounted_reason"),
          countsFor: countsFor(r),
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

/**
 * Adds each of `columns` that `table` lacks. CREATE TABLE IF NOT EXISTS leaves a table created by an
 * earlier deploy as it was, so a column added since must be added to it here.
 */
function addMissingColumns(db: SqlDatabase, table: string, columns: readonly (readonly [string, string])[]): void {
  // Table names and column definitions come from constants, never from input.
  const present = new Set(db.exec(`PRAGMA table_info(${table})`).map((row) => row["name"]));
  for (const [name, definition] of columns) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

/** A Review row's `counts_for`; a counting row stored before the column stands for its reviewer. */
function countsFor(row: Row): string[] {
  const stored = row["counts_for"];
  if (typeof stored === "string") return JSON.parse(stored) as string[];
  return Number(row["counts"]) === 1 ? [row["reviewer_owner_id"] as string] : [];
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
    waitingForGitLog: Number(row["waiting"]) === 1,
  };
}

/** A submission's rejection, which keeps no AppliedOp row and so claims no op_id. */
function unrecorded(issueId: string | null, reason: RejectReason | ReduceRejectReason, message: string): ApplyOutcome {
  return { status: "rejected", opId: "", issueId, reason, message };
}

/** An operation file's text, laid out like the files in the issues repo: two-space JSON and a final newline. */
function operationFile(operation: Operation): string {
  return `${JSON.stringify(operation, null, 2)}\n`;
}

type Draft = Pick<UnsignedOperation, "issue" | "type" | "base_version" | "payload">;

/** Which kinds of author each source writes as: a person on the dashboard, a person or identity over MCP. */
const SOURCE_AUTHORS: Readonly<Record<PendingSource, readonly string[]>> = {
  dashboard: ["person"],
  mcp: ["person", "identity"],
  penguin: ["penguin"],
};

/**
 * The caller's fields of a submission. The author comes from the gateway's authentication; an
 * `author` in the operation must name that same author.
 */
function draftFields(
  operation: unknown,
  author: Author,
  source: PendingSource,
): Draft | { readonly reason: RejectReason; readonly message: string } {
  const kind = "penguin" in author ? "penguin" : "person" in author ? "person" : "identity";
  if (!SOURCE_AUTHORS[source].includes(kind)) {
    return { reason: "author_not_bound", message: `a ${source} submission cannot write as ${kind}` };
  }
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    return { reason: "malformed", message: "the operation must be a JSON object" };
  }
  const record = operation as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !DRAFT_FIELDS.has(key));
  if (extra.length > 0) {
    return { reason: "malformed", message: `Penguin sets ${extra.join(", ")}; the operation may not carry them` };
  }
  if ("author" in record && !sameJson(record["author"], author)) {
    return { reason: "author_not_bound", message: "the operation names an author other than the caller" };
  }
  // Unchecked here: validate() applies the schema to the signed operation.
  return {
    issue: record["issue"],
    type: record["type"],
    base_version: record["base_version"],
    payload: record["payload"],
  } as Draft;
}

/** Drops the fields a submission left out, so the schema reports them as missing. */
function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
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
