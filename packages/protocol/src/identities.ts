// What GET /api/identities returns to the dashboard: every identity with its charter, sessions and
// issue history, the scopes a charter may name and the length caps the ProjectAgent enforces. The
// ProjectAgent builds it (services/project-agent/src/identities-page.ts); the identities page renders
// it (apps/dashboard/src/identities-page.tsx).

import type { IssuePageState } from "./issue-page.ts";

/** A session of an identity, running or offline. */
export interface IdentitySession {
  readonly id: string;
  readonly vendor: string;
  readonly branch: string;
  readonly status: "running" | "offline";
  /** When the session last registered or sent a heartbeat, as an ISO 8601 time. */
  readonly lastSeen: string;
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
