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
// no scheduled task is needed and every read sees the current state.

import type { Assignment } from "@penguin/issues";
import { IDENTITY_HANDLE_MAX_LENGTH, SEGMENT_PATTERN } from "@penguin/protocol";

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
  /** The issue the session is working on. Set once fix delivery (#39) tracks it; null until then. */
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

export interface SessionStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly offlineAfterMs?: number;
  /**
   * The owner who assigned an identity to an issue (IssueIndex.assigningOwner). A team identity's
   * requests go to that owner, and only that owner may accept for it.
   */
  readonly assigningOwner?: (issueId: string, handle: string) => string | undefined;
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

  /** Create after the IssueIndex on the same handle: routing reads and writes its Assignment table. */
  constructor(db: SqlDatabase, identities: IdentityStore, options: SessionStoreOptions = {}) {
    this.#db = db;
    this.#identities = identities;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => `ses_${crypto.randomUUID()}`);
    this.#offlineAfterMs = options.offlineAfterMs ?? SESSION_OFFLINE_AFTER_MS;
    this.#assigningOwner = options.assigningOwner ?? (() => undefined);
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
      this.#routeIdentity(identity);
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

  /** The issues routed to a running session, for the owner of its identity. */
  work(caller: string, sessionId: string): SessionWork {
    return this.#db.transaction(() => {
      this.#expire();
      const found = this.#ownSession(caller, sessionId, "read the work of");
      if (found.status === "rejected") return found;
      if (found.session.status === "offline") return offline(sessionId);
      const rows = this.#db.exec(`SELECT issue_id FROM Assignment WHERE session_id = ? ORDER BY rowid`, sessionId);
      return { status: "ok", issueIds: rows.map((row) => row["issue_id"] as string) };
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
    }
    for (const assignment of added) {
      const identity = this.#identityOf(assignment);
      if (identity !== undefined) this.#route(issueId, identity);
    }
  }

  /**
   * Routes one assignment and returns the session it went to. It waits for the owner's acceptance
   * when the identity does not accept automatically, and for a session when none is running.
   */
  #route(issueId: string, identity: Identity): string | null {
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
    return sessionId;
  }

  /** Routes every assignment of the identity that no session holds. */
  #routeIdentity(identity: Identity): void {
    const rows = this.#db.exec(
      `SELECT issue_id FROM Assignment
       WHERE assignee_kind = 'identity' AND assignee_id = ? AND session_id IS NULL ORDER BY rowid`,
      identity.handle,
    );
    for (const row of rows) this.#route(row["issue_id"] as string, identity);
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
      this.#db.exec(`UPDATE Assignment SET session_id = NULL WHERE session_id = ?`, row["id"] as string);
      identities.add(row["identity_id"] as string);
    }
    for (const id of identities) {
      const identity = this.#identities.get(id);
      if (identity !== undefined) this.#routeIdentity(identity);
    }
  }

  /** Asks each responsible owner, once, to accept the assignment or start a session. */
  #request(kind: OwnerRequestKind, issueId: string, identity: Identity): void {
    for (const owner of this.#responsibleOwners(issueId, identity)) {
      this.#db.exec(
        `INSERT OR IGNORE INTO OwnerRequest (kind, owner_id, identity_id, issue_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        kind,
        owner,
        identity.id,
        issueId,
        this.#now(),
      );
    }
  }

  #dropRequests(issueId: string, identityId: string, kind?: OwnerRequestKind): void {
    if (kind === undefined) {
      this.#db.exec(`DELETE FROM OwnerRequest WHERE issue_id = ? AND identity_id = ?`, issueId, identityId);
    } else {
      this.#db.exec(
        `DELETE FROM OwnerRequest WHERE kind = ? AND issue_id = ? AND identity_id = ?`,
        kind,
        issueId,
        identityId,
      );
    }
  }

  /**
   * The owners an identity's assignment answers to: a personal identity's owner; for a team identity,
   * the owner who assigned it, or every team owner when Penguin assigned it.
   */
  #responsibleOwners(issueId: string, identity: Identity): string[] {
    if (identity.ownerId !== null) return [identity.ownerId];
    const assigner = this.#assigningOwner(issueId, identity.handle);
    return assigner !== undefined && identity.teamOwners.includes(assigner) ? [assigner] : [...identity.teamOwners];
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
