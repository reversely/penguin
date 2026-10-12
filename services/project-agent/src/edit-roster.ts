// Stewards and builders (PRD 0.5 core concepts). Both are ordinary identities in the IdentityStore,
// created by Penguin for a person; this module only remembers which identity plays which role.
//
// - A person's steward, `@<person>/steward`, is chartered on every scope the person is DRI for in the
//   scope map (#135), and on nothing else: IdentityStore refuses a charter scope whose DRI is not its
//   owner, so the steward's charter never exceeds its person's scopes. An identity the person already
//   made under that handle is taken as the steward.
// - A feature's builder, `@<person>/<feature>`, is created when the feature first routes a task or opens,
//   chartered on the feature's declared area: the area's scopes the person is DRI for, and as paths the
//   area's paths plus the paths of the area's other scopes. The charter follows the area as the
//   area grows. A handle another identity holds moves the builder to `-2`, `-3`.
//
// Charters are cut at IDENTITY_LIMITS (32 scopes, 64 paths), sorted first, so a place past the cut
// routes to a steward instead of the builder.

import { builderHandle, builderJob, PENGUIN_AUTHOR_SEGMENT, STEWARD_JOB, stewardHandle, type EditCharter } from "@penguin/protocol";
import { driScopes, type ScopeMap } from "@penguin/scope-map";

import type { Feature } from "./feature-store.ts";
import { IDENTITY_LIMITS, type Identity, type IdentityStore } from "./identity-store.ts";
import type { SqlDatabase } from "./issue-index.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";

export const EDIT_ROSTER_SCHEMA: readonly string[] = [
  // feature_id is '' for a steward, so the unique key holds for both roles.
  `CREATE TABLE IF NOT EXISTS PenguinIdentity (
    identity_id TEXT PRIMARY KEY, role TEXT NOT NULL, person TEXT NOT NULL, feature_id TEXT NOT NULL,
    UNIQUE (role, person, feature_id))`,
];

export type RosterRole = "steward" | "builder";

/** How many handles a builder tries before it gives up on a feature. */
const BUILDER_HANDLE_ATTEMPTS = 5;

export class EditRoster {
  readonly #db: SqlDatabase;
  readonly #identities: IdentityStore;

  constructor(db: SqlDatabase, identities: IdentityStore) {
    this.#db = db;
    this.#identities = identities;
    for (const statement of EDIT_ROSTER_SCHEMA) db.exec(statement);
  }

  /** Creates every scope DRI's steward and every running feature's builder, and keeps each charter current. */
  sync(scopeMap: ScopeMap, features: readonly Feature[]): void {
    for (const person of new Set([...scopeMap.scopes.values()].map((scope) => scope.driId))) this.steward(person, scopeMap);
    for (const feature of features) if (RUNNING_STATES.has(feature.state)) this.builder(feature, scopeMap);
  }

  /** The person's steward, created or brought up to date; undefined when the person id cannot own an identity. */
  steward(person: string, scopeMap: ScopeMap): Identity | undefined {
    const charterScopes = driScopes(scopeMap, person).slice(0, IDENTITY_LIMITS.scopes);
    const known = this.#identityOf("steward", person, "");
    const existing = known ?? this.#identities.byHandle(stewardHandle(person));
    if (existing !== undefined && existing.ownerId === person) {
      if (known === undefined) this.#remember(existing.id, "steward", person, "");
      return this.#keepCharter(existing, charterScopes, [], scopeMap);
    }
    if (person === PENGUIN_AUTHOR_SEGMENT) return undefined;
    const created = this.#identities.create(
      person,
      { handle: stewardHandle(person), name: "Steward", job: STEWARD_JOB, charterScopes, autoAccept: true },
      scopeMap,
    );
    if (created.status !== "ok") return undefined;
    this.#remember(created.identity.id, "steward", person, "");
    return created.identity;
  }

  /** The feature's builder, created or brought up to date with the feature's area. */
  builder(feature: Feature, scopeMap: ScopeMap): Identity | undefined {
    const person = feature.personId;
    const owned = (scope: string) => scopeMap.scopes.get(scope)?.driId === person;
    const charterScopes = feature.area.scopes.filter(owned).sort().slice(0, IDENTITY_LIMITS.scopes);
    const borrowed = feature.area.scopes.filter((scope) => !owned(scope)).flatMap((scope) => [...(scopeMap.scopes.get(scope)?.paths ?? [])]);
    const charterPaths = [...new Set([...feature.area.paths, ...borrowed])].filter((path) => path !== "").sort().slice(0, IDENTITY_LIMITS.paths);
    const known = this.#identityOf("builder", person, feature.id);
    if (known !== undefined) return this.#keepCharter(known, charterScopes, charterPaths, scopeMap);
    for (let attempt = 1; attempt <= BUILDER_HANDLE_ATTEMPTS; attempt += 1) {
      const created = this.#identities.create(
        person,
        { handle: builderHandle(person, feature.id, attempt), name: feature.id, job: builderJob(feature.id), charterScopes, charterPaths, autoAccept: true },
        scopeMap,
      );
      if (created.status === "ok") {
        this.#remember(created.identity.id, "builder", person, feature.id);
        return created.identity;
      }
      if (created.reason !== "handle_taken") return undefined;
    }
    return undefined;
  }

  /** The person's steward as routing reads it, without creating one. */
  stewardOf(person: string): EditCharter | undefined {
    return charterOf(this.#identityOf("steward", person, ""));
  }

  /** The feature's builder as routing reads it, without creating one. */
  builderOf(person: string, featureId: string): EditCharter | undefined {
    return charterOf(this.#identityOf("builder", person, featureId));
  }

  /** The role Penguin gave an identity, or undefined for one it did not create. */
  roleOf(identityId: string): { readonly role: RosterRole; readonly person: string; readonly featureId: string | null } | undefined {
    const [row] = this.#db.exec(`SELECT role, person, feature_id FROM PenguinIdentity WHERE identity_id = ?`, identityId);
    if (row === undefined) return undefined;
    const featureId = row["feature_id"] as string;
    return { role: row["role"] as RosterRole, person: row["person"] as string, featureId: featureId === "" ? null : featureId };
  }

  #identityOf(role: RosterRole, person: string, featureId: string): Identity | undefined {
    const [row] = this.#db.exec(`SELECT identity_id FROM PenguinIdentity WHERE role = ? AND person = ? AND feature_id = ?`, role, person, featureId);
    return row === undefined ? undefined : this.#identities.get(row["identity_id"] as string);
  }

  #remember(identityId: string, role: RosterRole, person: string, featureId: string): void {
    this.#db.exec(`INSERT OR IGNORE INTO PenguinIdentity (identity_id, role, person, feature_id) VALUES (?, ?, ?, ?)`, identityId, role, person, featureId);
  }

  /** Edits the identity's charter only when it differs, as its owner. */
  #keepCharter(identity: Identity, charterScopes: readonly string[], charterPaths: readonly string[], scopeMap: ScopeMap): Identity {
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
    if (same([...identity.charterScopes].sort(), charterScopes) && same([...identity.charterPaths].sort(), charterPaths)) return identity;
    const edited = this.#identities.edit(identity.ownerId as string, identity.id, { charterScopes, charterPaths }, scopeMap);
    return edited.status === "ok" ? edited.identity : identity;
  }
}

function charterOf(identity: Identity | undefined): EditCharter | undefined {
  if (identity === undefined || identity.ownerId === null) return undefined;
  return { handle: identity.handle, person: identity.ownerId, scopes: identity.charterScopes, paths: identity.charterPaths };
}
