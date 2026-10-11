// The ProjectAgent's agent sessions and the routing of assigned issues to them (PRD sections 1, 5, 7
// and 12). A session is one running agent working as an identity. It registers with its identity,
// vendor, worktree and branch, then sends heartbeats; a session with no heartbeat for the offline
// window goes offline for good, and its agent registers again for a new session.
//
// An issue assigned to an identity routes to a running session of that identity: the session goes on
// the Assignment row. With none running, the identity's owner gets a request to start one, and the
// issue routes when a session registers. When the identity does not accept assignments automatically,
// the owner first gets a request to accept, and the issue routes only after the owner accepts. When a
// session goes offline its issues stay open and assigned, and route again the same way.
//
// Offline sessions are found lazily: every call first marks the sessions whose window has passed, so
// every read sees the current state. `sweep` runs the same check on its own and returns when the next
// running session's window ends; the ProjectAgent schedules it then, so a session that stops sending
// heartbeats goes offline on connected dashboards without anyone reading. A SessionListener hears when
// a session goes online or offline and when an issue's route changes, for the live feed.
//
// A fix task (a Huddle's fix sub-issue, PRD section 4, Layer 2) routes the same way but reaches the
// session only at its next safe checkpoint, so it never lands in the middle of the session's other
// work: until then it waits in PendingDelivery and `work` leaves it out. A checkpoint is the bridge's
// hook before the agent's next tool action where the agent product has hooks, or an explicit bridge
// checkpoint otherwise: see `checkpoint` and `checkpointWorktree`. Registering counts as a safe
// checkpoint too, since a new session has nothing in progress.
//
// A thread that needs a person reaches each of that person's running sessions the same way (PRD
// section 4, Layer 2: "tell that person's running sessions so each agent can tell its developer"):
// a session's checkpoint names each open thread needing the owner who reported the checkpoint that
// the session has not yet been told of, and ThreadNotice records that it was told.
//
// A request to approve an overlapping start (overlap-lock.ts, PRD 4.1 step 3) reaches the covering
// person's running sessions the same way, and OverlapNotice records that each session was told. When
// such a lock is approved or withdrawn, the waiting feature's sessions hear of it once at their next
// safe checkpoint, and SettledNotice records that each was told.
//
// The results the check runner reports for a session's `impact`, `check` and `apply_fix` requests
// reach that session the same way, once each (AgentToolStore.deliver records the delivery).

import type { Assignment } from "@penguin/issues";
import { IDENTITY_HANDLE_MAX_LENGTH, SEGMENT_PATTERN } from "@penguin/protocol";

import type { ToolResultRef } from "./agent-tools.ts";
import type { Identity, IdentityStore } from "./identity-store.ts";
import type { AssignmentListener, SqlDatabase, SqlValue } from "./issue-index.ts";

type Row = Record<string, SqlValue>;

/** Without a heartbeat for this long, a session goes offline. Agents send one about every 30 seconds. */
export const SESSION_OFFLINE_AFTER_MS = 90_000;

export const SESSION_LIMITS = {
  vendorLength: 64,
  worktreeIdLength: 128,
  branchLength: 255,
} as const;

export type SessionStatus = "running" | "offline";

export interface Session {
  readonly id: string;
  readonly identityId: string;
  readonly handle: string;
  readonly vendor: string;
  readonly worktreeId: string;
  readonly branch: string;
  readonly status: SessionStatus;
  /** The fix task most recently delivered to the session at a checkpoint, or null. */
  readonly currentIssueId: string | null;
  /** When the session last registered or sent a heartbeat, as an ISO 8601 time. */
  readonly lastSeen: string;
}

export interface SessionInput {
  /** The identity's handle, such as "@jun/reports". */
  readonly identity: string;
  /** The agent product the session runs in, such as "claude-code" or "codex". */
  readonly vendor: string;
  /** The bridge's id for the session's worktree. */
  readonly worktreeId: string;
  readonly branch: string;
}

export type SessionRejectReason = "invalid" | "forbidden" | "not_found" | "offline";

export type SessionRejection = {
  readonly status: "rejected";
  readonly reason: SessionRejectReason;
  readonly message: string;
};

export type SessionOutcome = { readonly status: "ok"; readonly session: Session } | SessionRejection;

/** The issues routed to a session. Only accepted assignments are routed. */
export type SessionWork = { readonly status: "ok"; readonly issueIds: string[] } | SessionRejection;

/** An open thread on an issue, by the op_id of the operation that opened it. */
export interface ThreadRef {
  readonly issueId: string;
  readonly threadId: string;
}

/** The threads as references, for `threadsNeeding`. */
export function threadRefs(threads: readonly { readonly issueId: string; readonly thread: { readonly id: string } }[]): ThreadRef[] {
  return threads.map(({ issueId, thread }) => ({ issueId, threadId: thread.id }));
}

/** An open overlap lock: the covering feature and the feature whose start waits on its person. */
export interface OverlapRef {
  readonly featureId: string;
  readonly blockedFeatureId: string;
}

/** A lock on the session's feature that was approved or withdrawn, by its settlement id. */
export interface SettledRef extends OverlapRef {
  readonly id: number;
  readonly outcome: "approved" | "withdrawn";
}

/**
 * One session's safe checkpoint: the fix tasks it delivered, in the order they routed, and the
 * threads and overlapping starts needing its owner that the session hears of for the first time.
 */
export interface Delivery {
  readonly sessionId: string;
  readonly handle: string;
  readonly delivered: string[];
  readonly threads: ThreadRef[];
  readonly overlaps: OverlapRef[];
  /** Locks on the session's feature that stopped holding its start since the session last heard. */
  readonly settled: Omit<SettledRef, "id">[];
  /** The check runner's results of the session's tool requests, reported since it last heard. */
  readonly toolResults: ToolResultRef[];
}

export type CheckpointDelivery = ({ readonly status: "ok" } & Delivery) | SessionRejection;

export type AcceptOutcome =
  | {
      readonly status: "ok";
      /** The session the issue routed to, or null when the owner has been asked to start one. */
      readonly sessionId: string | null;
    }
  | SessionRejection;

/** "accept": the owner is asked to accept the assignment. "start": to start a session of the identity. */
export type OwnerRequestKind = "accept" | "start";

export interface OwnerRequest {
  readonly kind: OwnerRequestKind;
  readonly ownerId: string;
  readonly identityId: string;
  readonly handle: string;
  readonly issueId: string;
  readonly createdAt: string;
}

/** Where one identity assignment of an issue stands. */
export interface AssignmentRoute {
  readonly handle: string;
  /** The running session the issue is routed to, or null. */
  readonly sessionId: string | null;
  /** What the issue waits for before it routes, or null once routed or for an unknown identity. */
  readonly waitingFor: "acceptance" | "session" | null;
}

/**
 * Hears when an owner is first asked to start a session for an issue, and when no start request for
 * that owner and issue remains. Runs inside the caller's transaction and must not open one.
 */
export interface StartRequestListener {
  startRequested(ownerId: string, issueId: string): void;
  startWithdrawn(ownerId: string, issueId: string): void;
}

/**
 * Hears of routing changes for the live feed. Runs inside the caller's transaction and must not open
 * one; the feed only collects the names and sends after the transaction.
 */
export interface SessionListener {
  /** A session of the identity with this handle registered or went offline. */
  sessionChanged(handle: string): void;
  /** An issue's routed session or what it waits for may have changed. */
  routeChanged(issueId: string): void;
}

export interface SessionStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly offlineAfterMs?: number;
  /**
   * The owner who assigned an identity to an issue (IssueIndex.assigningOwner). A team identity's
   * requests go to that owner, and only that owner may accept for it.
   */
  readonly assigningOwner?: (issueId: string, handle: string) => string | undefined;
  /** The inbox (inbox-store.ts), which turns each request to start a session into an inbox item. */
  readonly startRequests?: StartRequestListener;
  readonly listener?: SessionListener;
  /**
   * True for an issue that reaches its session only at the session's next safe checkpoint: a
   * Huddle's fix sub-issue. Every other issue reaches the session as soon as it routes.
   */
  readonly deliverAtCheckpoint?: (issueId: string) => boolean;
  /** The open threads that need the person, on any issue (IssueIndex.threadsNeeding). None when absent. */
  readonly threadsNeeding?: (person: string) => readonly ThreadRef[];
  /** The open overlap locks the person is asked to approve (OverlapStore.openFor). None when absent. */
  readonly overlapsNeeding?: (person: string) => readonly OverlapRef[];
  /** The locks on the session's feature settled since it joined (OverlapStore.settledSince). None when absent. */
  readonly settledFor?: (sessionId: string) => readonly SettledRef[];
  /**
   * The tool results reported for the session and not yet delivered, each marked delivered by the
   * call (AgentToolStore.deliver). None when absent.
   */
  readonly toolResultsFor?: (sessionId: string) => readonly ToolResultRef[];
}

/** The routing tables. They hold live state only: a rebuild from the issues repo never routes. */
export const SESSION_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS Session (
    id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, vendor TEXT NOT NULL, worktree_id TEXT NOT NULL,
    branch TEXT NOT NULL, status TEXT NOT NULL, current_issue_id TEXT, last_seen INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS Session_identity ON Session (identity_id, status, last_seen)`,
  `CREATE INDEX IF NOT EXISTS Session_running ON Session (status, last_seen)`,
  // An owner's acceptance of an identity's assignment to an issue. Unassigning drops it.
  `CREATE TABLE IF NOT EXISTS AssignmentAcceptance (
    issue_id TEXT NOT NULL, identity_id TEXT NOT NULL, accepted_by TEXT NOT NULL, accepted_at INTEGER NOT NULL,
    PRIMARY KEY (issue_id, identity_id))`,
  // What an owner is asked to do so an assigned issue can route: accept it, or start a session.
  `CREATE TABLE IF NOT EXISTS OwnerRequest (
    kind TEXT NOT NULL, owner_id TEXT NOT NULL, identity_id TEXT NOT NULL, issue_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (kind, issue_id, identity_id, owner_id))`,
  `CREATE INDEX IF NOT EXISTS OwnerRequest_owner ON OwnerRequest (owner_id, created_at)`,
  // A fix task routed to a session and waiting for the session's next safe checkpoint.
  `CREATE TABLE IF NOT EXISTS PendingDelivery (
    session_id TEXT NOT NULL, issue_id TEXT NOT NULL, routed_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, issue_id))`,
  // A thread that needs the session's owner, which a checkpoint of the session has named.
  // An overlapping start awaiting the session's owner, which a checkpoint of the session has named.
  `CREATE TABLE IF NOT EXISTS OverlapNotice (
    session_id TEXT NOT NULL, feature_id TEXT NOT NULL, blocked_feature_id TEXT NOT NULL, told_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, feature_id, blocked_feature_id))`,
  // A settled lock on the session's feature that a checkpoint of the session has named.
  `CREATE TABLE IF NOT EXISTS SettledNotice (
    session_id TEXT NOT NULL, settled_id INTEGER NOT NULL, told_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, settled_id))`,
  `CREATE TABLE IF NOT EXISTS ThreadNotice (
    session_id TEXT NOT NULL, thread_id TEXT NOT NULL, issue_id TEXT NOT NULL, told_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, thread_id))`,
];

const VENDOR = new RegExp(`^${SEGMENT_PATTERN}$`, "u");
const WORKTREE_ID = /^[A-Za-z0-9_.-]+$/u;
// A Git branch name, after `git check-ref-format --branch`: no control characters, spaces or ~^:?*[\,
// no "..", "@{" or "//", and no leading "-" or "/", trailing "/" or ".", or ".lock" ending.
const BRANCH_FORBIDDEN = /[\u0000- \u007f~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|\.lock$|^@$/u;

class Invalid extends Error {}

export class SessionStore implements AssignmentListener {
  readonly #db: SqlDatabase;
  readonly #identities: IdentityStore;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #offlineAfterMs: number;
  readonly #assigningOwner: (issueId: string, handle: string) => string | undefined;
  readonly #startRequests: StartRequestListener | undefined;
  readonly #listener: SessionListener | undefined;
  readonly #deliverAtCheckpoint: (issueId: string) => boolean;
  readonly #threadsNeeding: (person: string) => readonly ThreadRef[];
  readonly #overlapsNeeding: (person: string) => readonly OverlapRef[];
  readonly #settledFor: (sessionId: string) => readonly SettledRef[];
  readonly #toolResultsFor: (sessionId: string) => readonly ToolResultRef[];

  /** Create after the IssueIndex on the same handle: routing reads and writes its Assignment table. */
  constructor(db: SqlDatabase, identities: IdentityStore, options: SessionStoreOptions = {}) {
    this.#db = db;
    this.#identities = identities;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => `ses_${crypto.randomUUID()}`);
    this.#offlineAfterMs = options.offlineAfterMs ?? SESSION_OFFLINE_AFTER_MS;
    this.#assigningOwner = options.assigningOwner ?? (() => undefined);
    this.#startRequests = options.startRequests;
    this.#listener = options.listener;
    this.#deliverAtCheckpoint = options.deliverAtCheckpoint ?? (() => false);
    this.#threadsNeeding = options.threadsNeeding ?? (() => []);
    this.#overlapsNeeding = options.overlapsNeeding ?? (() => []);
    this.#settledFor = options.settledFor ?? (() => []);
    this.#toolResultsFor = options.toolResultsFor ?? (() => []);
    for (const statement of SESSION_SCHEMA) db.exec(statement);
  }

  /**
   * Registers a session of an identity for `caller`, the owner the gateway authenticated by token.
   * The caller must own the identity, or be one of a team identity's owners. The identity's waiting
   * assignments route to the new session.
   */
  register(caller: string, input: SessionInput): SessionOutcome {
    return this.#db.transaction(() => {
      this.#expire();
      let fields: SessionInput;
      try {
        fields = sessionFields(input);
      } catch (error) {
        if (error instanceof Invalid) return { status: "rejected", reason: "invalid", message: error.message };
        throw error;
      }
      const identity = this.#identities.byHandle(fields.identity);
      if (identity === undefined) return notFound(`no identity has handle ${fields.identity}`);
      const denied = ownerDenied(caller, identity, "register a session of");
      if (denied !== undefined) return denied;
      const id = this.#newId();
      this.#db.exec(
        `INSERT INTO Session (id, identity_id, vendor, worktree_id, branch, status, current_issue_id, last_seen)
         VALUES (?, ?, ?, ?, ?, 'running', NULL, ?)`,
        id,
        identity.id,
        fields.vendor,
        fields.worktreeId,
        fields.branch,
        this.#now(),
      );
      this.#listener?.sessionChanged(identity.handle);
      // A new session has nothing in progress, so its fix tasks need no later checkpoint.
      this.#routeIdentity(identity, id);
      return { status: "ok", session: this.#session(id) as Session };
    });
  }

  /** Records a heartbeat. An offline session is refused: its agent registers again. */
  heartbeat(caller: string, sessionId: string): SessionOutcome {
    return this.#db.transaction(() => {
      this.#expire();
      const found = this.#ownSession(caller, sessionId, "send a heartbeat for");
      if (found.status === "rejected") return found;
      if (found.session.status === "offline") return offline(sessionId);
      this.#db.exec(`UPDATE Session SET last_seen = ? WHERE id = ?`, this.#now(), sessionId);
      return { status: "ok", session: this.#session(sessionId) as Session };
    });
  }

  /** The session with this id, or undefined. */
  get(sessionId: string): Session | undefined {
    return this.#db.transaction(() => {
      this.#expire();
      return this.#session(sessionId);
    });
  }

  /** Every running session, most recently seen first. */
  running(): Session[] {
    return this.#db.transaction(() => {
      this.#expire();
      return this.#db
        .exec(`SELECT id FROM Session WHERE status = 'running' ORDER BY last_seen DESC, rowid DESC`)
        .flatMap((row) => this.#session(row["id"] as string) ?? []);
    });
  }

  /**
   * Every identity's sessions, running and offline, keyed by identity id: the `perIdentity` most
   * recently seen of each, most recent first.
   */
  byIdentity(perIdentity: number): Map<string, Session[]> {
    return this.#db.transaction(() => {
      this.#expire();
      const sessions = new Map<string, Session[]>();
      const rows = this.#db.exec(
        `SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY identity_id ORDER BY last_seen DESC, rowid DESC) AS n
           FROM Session) WHERE n <= ? ORDER BY n`,
        perIdentity,
      );
      for (const row of rows) {
        const session = this.#session(row["id"] as string);
        if (session !== undefined) sessions.set(session.identityId, [...(sessions.get(session.identityId) ?? []), session]);
      }
      return sessions;
    });
  }

  /**
   * Marks the sessions whose offline window has passed, and returns when the next running session's
   * window ends, in epoch milliseconds, or undefined when no session is running.
   */
  sweep(): number | undefined {
    return this.#db.transaction(() => {
      this.#expire();
      const [row] = this.#db.exec(`SELECT MIN(last_seen) AS oldest FROM Session WHERE status = 'running'`);
      const oldest = row?.["oldest"];
      return oldest === null || oldest === undefined ? undefined : Number(oldest) + this.#offlineAfterMs;
    });
  }

  /**
   * The issues routed to a running session, for the owner of its identity. A fix task waiting for
   * the session's next safe checkpoint is left out.
   */
  work(caller: string, sessionId: string): SessionWork {
    return this.#db.transaction(() => {
      this.#expire();
      const found = this.#ownSession(caller, sessionId, "read the work of");
      if (found.status === "rejected") return found;
      if (found.session.status === "offline") return offline(sessionId);
      const rows = this.#db.exec(
        `SELECT a.issue_id FROM Assignment a WHERE a.session_id = ? AND NOT EXISTS (
           SELECT 1 FROM PendingDelivery p WHERE p.session_id = a.session_id AND p.issue_id = a.issue_id)
         ORDER BY a.rowid`,
        sessionId,
      );
      return { status: "ok", issueIds: rows.map((row) => row["issue_id"] as string) };
    });
  }

  /**
   * A safe checkpoint of a running session, reported by `caller`, the owner of its identity: the fix
   * tasks waiting for it are delivered, so `work` lists them from now on. Counts as a heartbeat.
   */
  checkpoint(caller: string, sessionId: string): CheckpointDelivery {
    return this.#db.transaction((): CheckpointDelivery => {
      this.#expire();
      const found = this.#ownSession(caller, sessionId, "report a checkpoint of");
      if (found.status === "rejected") return found;
      if (found.session.status === "offline") return offline(sessionId);
      return { status: "ok", ...this.#deliver(found.session, caller) };
    });
  }

  /**
   * A safe checkpoint of every running session in the worktree `worktreeId` whose identity `caller`
   * owns: the bridge's hook before an agent's next tool action, or an explicit bridge checkpoint. The
   * bridge knows the worktree but not which session runs in it. Each session's checkpoint counts as
   * its heartbeat. Sessions of other owners in a worktree with the same id are left alone.
   */
  checkpointWorktree(caller: string, worktreeId: string): Delivery[] {
    return this.#db.transaction(() => {
      this.#expire();
      if (typeof worktreeId !== "string") return [];
      return this.#db
        .exec(
          `SELECT id FROM Session WHERE worktree_id = ? AND status = 'running' ORDER BY last_seen DESC, rowid DESC`,
          worktreeId,
        )
        .flatMap((row) => {
          const found = this.#ownSession(caller, row["id"] as string, "report a checkpoint of");
          return found.status === "ok" ? [this.#deliver(found.session, caller)] : [];
        });
    });
  }

  /**
   * Accepts an identity's assignment to an issue on behalf of the identity's owner, and routes it.
   * For a team identity the owner who assigned it accepts.
   */
  accept(caller: string, issueId: string, handle: string): AcceptOutcome {
    return this.#db.transaction((): AcceptOutcome => {
      this.#expire();
      const identity = typeof handle === "string" ? this.#identities.byHandle(handle) : undefined;
      if (identity === undefined) return notFound(`no identity has handle ${String(handle)}`);
      if (typeof issueId !== "string" || !this.#assigned(issueId, identity)) {
        return notFound(`${identity.handle} is not assigned to issue ${String(issueId)}`);
      }
      const owners = this.#responsibleOwners(issueId, identity);
      if (!owners.includes(caller)) {
        return {
          status: "rejected",
          reason: "forbidden",
          message: `only ${owners.join(" or ")} can accept ${identity.handle}'s assignment; ${String(caller)} cannot`,
        };
      }
      this.#db.exec(
        `INSERT OR IGNORE INTO AssignmentAcceptance (issue_id, identity_id, accepted_by, accepted_at)
         VALUES (?, ?, ?, ?)`,
        issueId,
        identity.id,
        caller,
        this.#now(),
      );
      this.#dropRequests(issueId, identity.id, "accept");
      this.#listener?.routeChanged(issueId);
      // Accepting again, or accepting an auto-accepted assignment, leaves a routed issue where it is.
      const routed = this.#routedSession(issueId, identity);
      return { status: "ok", sessionId: routed ?? this.#route(issueId, identity) };
    });
  }

  /** The requests waiting on `caller`: assignments to accept and sessions to start. */
  requests(caller: string): OwnerRequest[] {
    return this.#db.transaction(() => {
      this.#expire();
      return this.#db
        .exec(
          `SELECT r.*, i.handle FROM OwnerRequest r JOIN Identity i ON i.id = r.identity_id
           WHERE r.owner_id = ? ORDER BY r.created_at, r.rowid`,
          caller,
        )
        .map((row) => ({
          kind: row["kind"] as OwnerRequestKind,
          ownerId: row["owner_id"] as string,
          identityId: row["identity_id"] as string,
          handle: row["handle"] as string,
          issueId: row["issue_id"] as string,
          createdAt: new Date(Number(row["created_at"])).toISOString(),
        }));
    });
  }

  /** Where each identity assignment of an issue stands. */
  routes(issueId: string): AssignmentRoute[] {
    return this.#db.transaction(() => {
      this.#expire();
      return this.#db
        .exec(
          `SELECT a.assignee_id, a.session_id, i.id AS identity_id,
             (SELECT kind FROM OwnerRequest r WHERE r.issue_id = a.issue_id AND r.identity_id = i.id LIMIT 1) AS waiting
           FROM Assignment a LEFT JOIN Identity i ON i.handle = a.assignee_id
           WHERE a.issue_id = ? AND a.assignee_kind = 'identity' ORDER BY a.rowid`,
          issueId,
        )
        .map((row) => ({
          handle: row["assignee_id"] as string,
          sessionId: (row["session_id"] as string | null) ?? null,
          waitingFor: row["waiting"] === "accept" ? "acceptance" : row["waiting"] === "start" ? "session" : null,
        }));
    });
  }

  /** Routes identity assignments an applied operation added and forgets the ones it removed. */
  assignmentsChanged(issueId: string, added: readonly Assignment[], removed: readonly Assignment[]): void {
    this.#expire();
    for (const assignment of removed) {
      const identity = this.#identityOf(assignment);
      if (identity === undefined) continue;
      this.#db.exec(`DELETE FROM AssignmentAcceptance WHERE issue_id = ? AND identity_id = ?`, issueId, identity.id);
      this.#dropRequests(issueId, identity.id);
      this.#db.exec(
        `DELETE FROM PendingDelivery WHERE issue_id = ? AND session_id IN (SELECT id FROM Session WHERE identity_id = ?)`,
        issueId,
        identity.id,
      );
      this.#db.exec(
        `UPDATE Session SET current_issue_id = NULL WHERE current_issue_id = ? AND identity_id = ?`,
        issueId,
        identity.id,
      );
    }
    for (const assignment of added) {
      const identity = this.#identityOf(assignment);
      if (identity !== undefined) this.#route(issueId, identity);
    }
  }

  /**
   * Delivers a running session's waiting fix tasks, names the threads needing `owner` it was not yet
   * told of, and records its heartbeat. `owner` is the person who reported the checkpoint, an owner
   * of the session's identity.
   */
  #deliver(session: Session, owner: string): Delivery {
    const now = this.#now();
    const delivered = this.#db
      .exec(`DELETE FROM PendingDelivery WHERE session_id = ? RETURNING issue_id, routed_at`, session.id)
      // RETURNING follows no order; routing order, then issue number, is the order the tasks arrived in.
      .sort((a, b) => Number(a["routed_at"]) - Number(b["routed_at"]) || Number(a["issue_id"]) - Number(b["issue_id"]))
      .map((row) => row["issue_id"] as string);
    const latest = delivered.at(-1);
    this.#db.exec(
      `UPDATE Session SET last_seen = ?, current_issue_id = COALESCE(?, current_issue_id) WHERE id = ?`,
      now,
      latest ?? null,
      session.id,
    );
    for (const issueId of delivered) this.#listener?.routeChanged(issueId);
    const threads = this.#threadsNeeding(owner).filter(
      ({ issueId, threadId }) =>
        // RETURNING yields the row only when it is new, so a thread the session heard of stays quiet.
        this.#db.exec(
          `INSERT OR IGNORE INTO ThreadNotice (session_id, thread_id, issue_id, told_at) VALUES (?, ?, ?, ?)
           RETURNING thread_id`,
          session.id,
          threadId,
          issueId,
          now,
        ).length > 0,
    );
    const overlaps = this.#overlapsNeeding(owner).filter(
      ({ featureId, blockedFeatureId }) =>
        this.#db.exec(
          `INSERT OR IGNORE INTO OverlapNotice (session_id, feature_id, blocked_feature_id, told_at) VALUES (?, ?, ?, ?)
           RETURNING feature_id`,
          session.id,
          featureId,
          blockedFeatureId,
          now,
        ).length > 0,
    );
    const settled = this.#settledFor(session.id).filter(
      ({ id }) =>
        this.#db.exec(
          `INSERT OR IGNORE INTO SettledNotice (session_id, settled_id, told_at) VALUES (?, ?, ?) RETURNING settled_id`,
          session.id,
          id,
          now,
        ).length > 0,
    );
    return {
      sessionId: session.id,
      handle: session.handle,
      delivered,
      threads: threads.map((ref) => ({ ...ref })),
      overlaps: overlaps.map(({ featureId, blockedFeatureId }) => ({ featureId, blockedFeatureId })),
      settled: settled.map(({ featureId, blockedFeatureId, outcome }) => ({ featureId, blockedFeatureId, outcome })),
      toolResults: this.#toolResultsFor(session.id).map((ref) => ({ ...ref })),
    };
  }

  /**
   * Routes one assignment and returns the session it went to. It waits for the owner's acceptance
   * when the identity does not accept automatically, and for a session when none is running. A fix
   * task routed to any session but `deliveredTo` waits for that session's next safe checkpoint.
   */
  #route(issueId: string, identity: Identity, deliveredTo?: string): string | null {
    if (!identity.autoAccept && !this.#accepted(issueId, identity.id)) {
      this.#request("accept", issueId, identity);
      return null;
    }
    // Open question in #24: the PRD does not say which of several running sessions gets the issue.
    // The most recently seen one does, as the ticket recommends.
    const [session] = this.#db.exec(
      `SELECT id FROM Session WHERE identity_id = ? AND status = 'running' ORDER BY last_seen DESC, rowid DESC LIMIT 1`,
      identity.id,
    );
    const sessionId = (session?.["id"] as string | undefined) ?? null;
    this.#db.exec(
      `UPDATE Assignment SET session_id = ? WHERE issue_id = ? AND assignee_kind = 'identity' AND assignee_id = ?`,
      sessionId,
      issueId,
      identity.handle,
    );
    if (sessionId === null) this.#request("start", issueId, identity);
    else this.#dropRequests(issueId, identity.id, "start");
    if (sessionId !== null && sessionId !== deliveredTo && this.#deliverAtCheckpoint(issueId)) {
      this.#db.exec(
        `INSERT OR IGNORE INTO PendingDelivery (session_id, issue_id, routed_at) VALUES (?, ?, ?)`,
        sessionId,
        issueId,
        this.#now(),
      );
    }
    this.#listener?.routeChanged(issueId);
    return sessionId;
  }

  /** Routes every assignment of the identity that no session holds. */
  #routeIdentity(identity: Identity, deliveredTo?: string): void {
    const rows = this.#db.exec(
      `SELECT issue_id FROM Assignment
       WHERE assignee_kind = 'identity' AND assignee_id = ? AND session_id IS NULL ORDER BY rowid`,
      identity.handle,
    );
    for (const row of rows) this.#route(row["issue_id"] as string, identity, deliveredTo);
  }

  /**
   * Marks running sessions past the offline window as offline. Their issues stay open and assigned;
   * each routes again, to another running session of its identity or to a request to start one.
   */
  #expire(): void {
    const expired = this.#db.exec(
      `UPDATE Session SET status = 'offline' WHERE status = 'running' AND last_seen < ? RETURNING id, identity_id`,
      this.#now() - this.#offlineAfterMs,
    );
    if (expired.length === 0) return;
    const identities = new Set<string>();
    for (const row of expired) {
      // A fix task the session never received waits for the next session's checkpoint instead.
      this.#db.exec(`DELETE FROM PendingDelivery WHERE session_id = ?`, row["id"] as string);
      this.#db.exec(`DELETE FROM ThreadNotice WHERE session_id = ?`, row["id"] as string);
      this.#db.exec(`DELETE FROM OverlapNotice WHERE session_id = ?`, row["id"] as string);
      this.#db.exec(`DELETE FROM SettledNotice WHERE session_id = ?`, row["id"] as string);
      const unrouted = this.#db.exec(
        `UPDATE Assignment SET session_id = NULL WHERE session_id = ? RETURNING issue_id`,
        row["id"] as string,
      );
      for (const issue of unrouted) this.#listener?.routeChanged(issue["issue_id"] as string);
      identities.add(row["identity_id"] as string);
    }
    for (const id of identities) {
      const identity = this.#identities.get(id);
      if (identity === undefined) continue;
      this.#listener?.sessionChanged(identity.handle);
      this.#routeIdentity(identity);
    }
  }

  /** Asks each responsible owner, once, to accept the assignment or start a session. */
  #request(kind: OwnerRequestKind, issueId: string, identity: Identity): void {
    for (const owner of this.#responsibleOwners(issueId, identity)) {
      // RETURNING yields the row only when it is new, so a request already waiting is not raised again.
      const inserted = this.#db.exec(
        `INSERT OR IGNORE INTO OwnerRequest (kind, owner_id, identity_id, issue_id, created_at) VALUES (?, ?, ?, ?, ?)
         RETURNING owner_id`,
        kind,
        owner,
        identity.id,
        issueId,
        this.#now(),
      );
      if (kind === "start" && inserted.length > 0) this.#startRequests?.startRequested(owner, issueId);
    }
  }

  #dropRequests(issueId: string, identityId: string, kind?: OwnerRequestKind): void {
    const dropped =
      kind === undefined
        ? this.#db.exec(
            `DELETE FROM OwnerRequest WHERE issue_id = ? AND identity_id = ? RETURNING kind, owner_id`,
            issueId,
            identityId,
          )
        : this.#db.exec(
            `DELETE FROM OwnerRequest WHERE kind = ? AND issue_id = ? AND identity_id = ? RETURNING kind, owner_id`,
            kind,
            issueId,
            identityId,
          );
    for (const row of dropped) {
      if (row["kind"] !== "start" || this.#startRequests === undefined) continue;
      const owner = row["owner_id"] as string;
      // Another identity of the same owner may still wait for a session on this issue.
      const remaining = this.#db.exec(
        `SELECT 1 FROM OwnerRequest WHERE kind = 'start' AND owner_id = ? AND issue_id = ? LIMIT 1`,
        owner,
        issueId,
      );
      if (remaining.length === 0) this.#startRequests.startWithdrawn(owner, issueId);
    }
  }

  /** The owners an identity's assignment to the issue answers to (see responsibleOwners). */
  #responsibleOwners(issueId: string, identity: Identity): string[] {
    return responsibleOwners(identity, () => this.#assigningOwner(issueId, identity.handle));
  }

  #accepted(issueId: string, identityId: string): boolean {
    return (
      this.#db.exec(`SELECT 1 FROM AssignmentAcceptance WHERE issue_id = ? AND identity_id = ?`, issueId, identityId)
        .length > 0
    );
  }

  #assigned(issueId: string, identity: Identity): boolean {
    return this.#assignment(issueId, identity) !== undefined;
  }

  #routedSession(issueId: string, identity: Identity): string | null {
    return (this.#assignment(issueId, identity)?.["session_id"] as string | null | undefined) ?? null;
  }

  #assignment(issueId: string, identity: Identity): Row | undefined {
    const [row] = this.#db.exec(
      `SELECT session_id FROM Assignment WHERE issue_id = ? AND assignee_kind = 'identity' AND assignee_id = ?`,
      issueId,
      identity.handle,
    );
    return row;
  }

  #identityOf(assignment: Assignment): Identity | undefined {
    return assignment.assigneeKind === "identity" ? this.#identities.byHandle(assignment.assigneeId) : undefined;
  }

  #ownSession(
    caller: string,
    sessionId: string,
    action: string,
  ): { readonly status: "ok"; readonly session: Session } | SessionRejection {
    const session = typeof sessionId === "string" ? this.#session(sessionId) : undefined;
    if (session === undefined) return notFound(`no session has id ${String(sessionId)}`);
    const identity = this.#identities.get(session.identityId);
    if (identity === undefined) return notFound(`session ${sessionId}'s identity no longer exists`);
    return ownerDenied(caller, identity, action) ?? { status: "ok", session };
  }

  #session(id: string): Session | undefined {
    const [row] = this.#db.exec(
      `SELECT s.*, i.handle FROM Session s JOIN Identity i ON i.id = s.identity_id WHERE s.id = ?`,
      id,
    );
    if (row === undefined) return undefined;
    return {
      id: row["id"] as string,
      identityId: row["identity_id"] as string,
      handle: row["handle"] as string,
      vendor: row["vendor"] as string,
      worktreeId: row["worktree_id"] as string,
      branch: row["branch"] as string,
      status: row["status"] as SessionStatus,
      currentIssueId: (row["current_issue_id"] as string | null) ?? null,
      lastSeen: new Date(Number(row["last_seen"])).toISOString(),
    };
  }
}

/**
 * The owners an identity's assignment answers to: a personal identity's owner; for a team identity,
 * the owner who assigned it, or every team owner when Penguin assigned it. `assigner` is read only
 * for a team identity.
 */
export function responsibleOwners(identity: Identity, assigner: () => string | undefined): string[] {
  if (identity.ownerId !== null) return [identity.ownerId];
  const owner = assigner();
  return owner !== undefined && identity.teamOwners.includes(owner) ? [owner] : [...identity.teamOwners];
}

/** A personal identity's owner, or any of a team identity's owners, may act for its sessions. */
function ownerDenied(caller: string, identity: Identity, action: string): SessionRejection | undefined {
  const owners = identity.ownerId === null ? identity.teamOwners : [identity.ownerId];
  if (owners.includes(caller)) return undefined;
  return {
    status: "rejected",
    reason: "forbidden",
    message: `only ${identity.handle}'s owner (${owners.join(", ")}) can ${action} it; ${String(caller)} cannot`,
  };
}

function notFound(message: string): SessionRejection {
  return { status: "rejected", reason: "not_found", message };
}

function offline(sessionId: string): SessionRejection {
  return { status: "rejected", reason: "offline", message: `session ${sessionId} is offline; register a new session` };
}

/** The registration fields, checked against their caps and formats. RPC callers are untyped. */
function sessionFields(input: unknown): SessionInput {
  if (typeof input !== "object" || input === null) throw new Invalid("the session must be an object");
  const { identity, vendor, worktreeId, branch } = input as Partial<Record<keyof SessionInput, unknown>>;
  if (typeof identity !== "string" || identity.length === 0 || identity.length > IDENTITY_HANDLE_MAX_LENGTH) {
    throw new Invalid("identity must be an identity handle");
  }
  if (typeof vendor !== "string" || vendor.length > SESSION_LIMITS.vendorLength || !VENDOR.test(vendor)) {
    throw new Invalid(
      `vendor must be lowercase letters, digits, dots and hyphens, at most ${SESSION_LIMITS.vendorLength} characters`,
    );
  }
  if (
    typeof worktreeId !== "string" ||
    worktreeId.length > SESSION_LIMITS.worktreeIdLength ||
    !WORKTREE_ID.test(worktreeId)
  ) {
    throw new Invalid(`worktreeId must be a worktree id of at most ${SESSION_LIMITS.worktreeIdLength} characters`);
  }
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > SESSION_LIMITS.branchLength ||
    BRANCH_FORBIDDEN.test(branch)
  ) {
    throw new Invalid(`branch must be a valid Git branch name of at most ${SESSION_LIMITS.branchLength} characters`);
  }
  return { identity, vendor, worktreeId, branch };
}
