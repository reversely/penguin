// Test support for opening Huddle issues: one ProjectAgent's stores over one in-memory database,
// wired the way the agent wires them, with `openHuddle` called through the same dependencies.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateSigningKeyPair } from "@penguin/issues";
import type { CombinedRunEvent } from "@penguin/protocol";
import { parseScopeMap, type ScopeMap } from "@penguin/scope-map";

import { openHuddle, type HuddleOpenDeps, type HuddleOpenOutcome } from "../src/huddle-open.ts";
import { HuddleStore } from "../src/huddle-store.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { InboxStore } from "../src/inbox-store.ts";
import { IssueIndex, type IndexListener, type OperationKeys } from "../src/issue-index.ts";
import { OwnerForkStore } from "../src/owner-forks.ts";
import { importServiceKey, type ServiceKey } from "../src/service-key.ts";
import { SessionStore } from "../src/session-store.ts";
import { sqlite } from "./issues-repo.ts";

const FIXTURE = join(import.meta.dirname, "../../../examples/identity-unification/base/penguin");

/**
 * The fixture's scope map plus a billing scope owned by Lee that depends on nothing, so a test can
 * check that an unrelated owner hears nothing of a Huddle.
 */
export function fixtureScopeMap(): ScopeMap {
  const scopes = JSON.parse(readFileSync(join(FIXTURE, "scopes.json"), "utf8")) as { scopes: unknown[] };
  const billing = {
    id: "billing",
    name: "Billing",
    owner: "lee",
    paths: ["billing/"],
    test_command: "python -m pytest billing",
    depends_on: [],
  };
  return parseScopeMap({ scopes: [...scopes.scopes, billing] });
}

/** The fixture's seed identities: @priya/merge-rules, @jun/reports and @sam/campaigns. */
function seedIdentities(): { handle: string; owner: string; job: string; charter_scopes: string[] }[] {
  return (JSON.parse(readFileSync(join(FIXTURE, "identities.json"), "utf8")) as { identities: [] }).identities;
}

let service: ServiceKey | undefined;

async function serviceKey(): Promise<ServiceKey> {
  if (service === undefined) {
    const pair = await generateSigningKeyPair();
    service = await importServiceKey(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
  }
  return service;
}

export class HuddleProject {
  readonly sql = sqlite().sql;
  readonly scopeMap = fixtureScopeMap();
  readonly identities: IdentityStore;
  readonly index: IssueIndex;
  readonly sessions: SessionStore;
  readonly inbox: InboxStore;
  readonly forks: OwnerForkStore;
  readonly huddles: HuddleStore;
  /** Commits in each owner's fork, by owner id, as the Artifacts binding's readCommit would find them. */
  readonly published = new Map<string, Set<string>>();
  /** The sessions' clock in epoch milliseconds; the real clock while undefined. */
  clock: number | undefined;

  constructor(options: { readonly seedIdentities?: boolean } = {}) {
    let nextIdentity = 0;
    let nextSession = 0;
    this.identities = new IdentityStore(this.sql, () => `identity-${++nextIdentity}`);
    let sessions: SessionStore | undefined;
    let inbox: InboxStore | undefined;
    const listener: IndexListener = {
      assignmentsChanged: (issueId, added, removed) => sessions?.assignmentsChanged(issueId, added, removed),
      issueChanged: (change) => inbox?.issueChanged(change),
    };
    const index = new IssueIndex(this.sql, listener);
    inbox = new InboxStore(this.sql, this.identities, {
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
    });
    sessions = new SessionStore(this.sql, this.identities, {
      newId: () => `session-${++nextSession}`,
      now: () => this.clock ?? Date.now(),
      assigningOwner: (issueId, handle) => index.assigningOwner(issueId, handle),
      startRequests: inbox,
      deliverAtCheckpoint: (issueId) => this.huddles.isFix(issueId),
    });
    [this.index, this.sessions, this.inbox] = [index, sessions, inbox];
    this.forks = new OwnerForkStore(this.sql);
    this.huddles = new HuddleStore(this.sql);
    if (options.seedIdentities ?? true) {
      for (const seed of seedIdentities()) this.identity(seed.owner, seed.handle, seed.charter_scopes);
    }
  }

  identity(owner: string, handle: string, charterScopes: string[]): void {
    const name = handle.slice(handle.indexOf("/") + 1);
    const input = { handle, name, job: "Fix things", charterScopes, autoAccept: true };
    const outcome = this.identities.create(owner, input, this.scopeMap);
    assert.equal(outcome.status, "ok", JSON.stringify(outcome));
  }

  /** Records `sha` as published to `owner`'s fork, optionally reported by an agent session. */
  publish(owner: string, sha: string, sessionId: string | null = null): void {
    const commits = this.published.get(owner) ?? new Set();
    commits.add(sha);
    this.published.set(owner, commits);
    this.forks.recordCheckpoint(owner, `owner-${owner}`, sha, sessionId);
  }

  /** The dependencies ProjectAgent.openHuddle passes, with `overrides` replacing any of them. */
  async deps(overrides: Partial<HuddleOpenDeps> = {}): Promise<HuddleOpenDeps> {
    const key = await serviceKey();
    const keys: OperationKeys = {
      bridges: [],
      serviceKey: key.publicKey,
      scopeMap: this.scopeMap,
      identities: this.identities,
    };
    return {
      huddles: this.huddles,
      scopeMap: this.scopeMap,
      issue: (issueId) => this.index.issue(issueId),
      issueIds: () => this.index.ids(),
      submit: (operation) =>
        this.index.submit({
          operation,
          author: { penguin: true },
          source: "penguin",
          signingKey: key.privateKey,
          keys,
        }),
      ownerFork: (ownerId) => this.forks.get(ownerId),
      session: (sessionId) => this.sessions.get(sessionId),
      identities: () => this.identities.list(),
      triggerPublished: async ({ trigger }) => this.published.get(trigger.ownerId)?.has(trigger.sha) ?? false,
      ...overrides,
    };
  }

  async open(event: CombinedRunEvent | unknown, overrides: Partial<HuddleOpenDeps> = {}): Promise<HuddleOpenOutcome> {
    return openHuddle(await this.deps(overrides), event);
  }

  /** Issues labelled `huddle`. */
  huddleIssues(): string[] {
    return this.index.ids().filter((id) => this.index.issue(id)?.labels.includes("huddle"));
  }

  appliedCount(): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM AppliedOp`)[0]?.["n"]);
  }

  /** Each sub-issue of the Huddle issue as "<first assignee> <first check's test> <fingerprint>". */
  fixes(huddleId: string): string[] {
    const huddle = this.index.issue(huddleId);
    assert.ok(huddle);
    return [...huddle.subIssues.keys()].map((subId) => {
      const sub = this.index.issue(subId);
      assert.ok(sub);
      const [assignee] = [...sub.assignments.values()];
      const [check] = [...sub.checks.values()];
      return `${assignee?.assigneeId} ${check?.test} ${check?.fingerprint}`;
    });
  }
}
