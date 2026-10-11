// What GET /api/identities returns to the dashboard: every identity with its charter, sessions,
// issue history, last checkpoint and recent operations, the scopes a charter may name and the length caps the ProjectAgent enforces. The
// ProjectAgent builds it (services/project-agent/src/identities-page.ts); the identities page renders
// it (apps/dashboard/src/identities-page.tsx).

import type { IssuePageState } from "./issue-page.ts";

/** A session of an identity, running or offline. */
export interface IdentitySession {
  readonly id: string;
  readonly vendor: string;
  readonly branch: string;
  /** The bridge's id for the session's worktree. */
  readonly worktreeId: string;
  readonly status: "running" | "offline";
  /** The fix task most recently delivered to the session at a checkpoint, or null. */
  readonly currentIssueId: string | null;
  /** When the session last registered or sent a heartbeat, as an ISO 8601 time. */
  readonly lastSeen: string;
}

/** A checkpoint a session of the identity reported through `report_checkpoint`. */
export interface IdentityCheckpoint {
  /** The checkpoint commit in the owner's fork. */
  readonly sha: string;
  readonly sessionId: string;
  /** When the checkpoint was reported, as an ISO 8601 time. */
  readonly reportedAt: string;
}

/** An applied operation the identity wrote, as its issue's timeline records it. */
export interface IdentityOperation {
  readonly seq: number;
  readonly opId: string;
  readonly issueId: string;
  readonly type: string;
  readonly payload: unknown;
}

/** An issue the identity was assigned to or wrote an operation on. */
export interface IdentityHistoryEntry {
  readonly issueId: string;
  readonly title: string;
  readonly state: IssuePageState;
}

export interface IdentityEntry {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  /** The avatar as a `data:` URL of a PNG, JPEG, GIF or WebP image, or null. */
  readonly avatar: string | null;
  readonly job: string;
  readonly team: boolean;
  /** The personal identity's owner, or a team identity's owners. Only they may edit or duplicate it. */
  readonly owners: readonly string[];
  readonly charterScopes: readonly string[];
  readonly charterPaths: readonly string[];
  readonly charterRules: readonly string[];
  readonly autoAccept: boolean;
  /** The handle of the identity this one was duplicated from, or null. */
  readonly duplicatedFrom: string | null;
  /** The identity's sessions, most recently seen first. */
  readonly sessions: readonly IdentitySession[];
  /** The issues in the identity's history, most recent activity first. */
  readonly history: readonly IdentityHistoryEntry[];
  /**
   * The owner fork's latest checkpoint while a session of this identity is the one that reported it;
   * null before any report and once another session or the owner's bridge reports a newer one.
   */
  readonly lastCheckpoint: IdentityCheckpoint | null;
  /** The identity's most recent applied operations, newest first. */
  readonly recentOperations: readonly IdentityOperation[];
}

/** A scope of the scope map, which a charter may name when its owner is the identity's owner. */
export interface IdentityScope {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  /** The scope's `test_command` from penguin/scopes.json, which owners edit there and not here. */
  readonly testCommand: string;
}

/** The caps the ProjectAgent checks every identity field against. */
export interface IdentityLimits {
  readonly nameLength: number;
  readonly jobLength: number;
  readonly rules: number;
  readonly ruleLength: number;
  readonly scopes: number;
  readonly paths: number;
  readonly pathLength: number;
  readonly teamOwners: number;
  readonly avatarBytes: number;
}

export interface IdentitiesPage {
  readonly identities: readonly IdentityEntry[];
  readonly scopes: readonly IdentityScope[];
  /** Every owner in the scope map or holding an identity, in id order: the choices for a team identity. */
  readonly owners: readonly string[];
  readonly limits: IdentityLimits;
}

/** What creating, editing or duplicating an identity returns. */
export type IdentityWriteOutcome =
  | { readonly status: "ok"; readonly id: string; readonly handle: string }
  | {
      readonly status: "rejected";
      readonly reason: "invalid" | "forbidden" | "not_found" | "handle_taken";
      readonly message: string;
    };
