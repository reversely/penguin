// Test support for merge plans: the ProjectAgent's stores on node:sqlite, a feature's plan store, a
// Git repository on disk read through the binding's object reads, and helpers that open features and
// record their checkpoints the way feature-open.ts records them.

import { generateSigningKeyPair } from "@penguin/issues";
import type { ScopeMap } from "@penguin/scope-map";

import { FeatureStore, signFeatureRecord, type FeatureArea, type FeatureRecord } from "../src/feature-store.ts";
import { InboxStore } from "../src/inbox-store.ts";
import { IdentityStore } from "../src/identity-store.ts";
import { OverlapStore } from "../src/overlap-lock.ts";
import { PlanFactsStore } from "../src/plan-facts.ts";
import { PlanStore } from "../src/plan-store.ts";
import { proposePlan, type ProposePlanDeps, type ProposePlanOutcome } from "../src/propose-plan.ts";
import type { Session, SessionOutcome } from "../src/session-store.ts";
import { gitReader } from "./git-reader.ts";
import { sqlite } from "./issues-repo.ts";

export class PlanProject {
  readonly sql = sqlite().sql;
  readonly features = new FeatureStore(this.sql);
  readonly facts = new PlanFactsStore(this.sql);
  readonly plans = new PlanStore(this.sql);
  readonly overlaps = new OverlapStore(this.sql);
  readonly inbox = new InboxStore(this.sql, new IdentityStore(this.sql));
  /** Each session: its person and identity handle. */
  readonly sessions = new Map<string, { readonly person: string; readonly handle: string }>();
  readonly exceptions: { readonly person: string; readonly feature: string }[] = [];
  /** Each repo the plan read, and every binding call through it. */
  readonly reads: { readonly repo: string; readonly calls: string[] }[] = [];
  breakLimit: number | undefined = 10;
  /** Sends a stored plan to its authors, as the ProjectAgent does (plan-approval.ts); none when unset. */
  announce: ProposePlanDeps["announce"];
  invariants: string | null = null;
  #key: Promise<CryptoKeyPair> = generateSigningKeyPair();

  readonly scopeMap: ScopeMap;
  /** The repository that holds every fork's objects. */
  readonly repoDir: string;

  constructor(scopeMap: ScopeMap, repoDir: string) {
    this.scopeMap = scopeMap;
    this.repoDir = repoDir;
  }

  publicKey(): Promise<CryptoKey> {
    return this.#key.then((pair) => pair.publicKey);
  }

  async sign(draft: Parameters<typeof signFeatureRecord>[0]): Promise<FeatureRecord> {
    return signFeatureRecord(draft, (await this.#key).privateKey);
  }

  /** Opens feature `id` for `person` with a fork and joins `session` as `handle`, when given. */
  async open(id: string, person: string, area: Partial<FeatureArea>, session?: { id: string; handle: string }): Promise<void> {
    const full = { scopes: [], paths: [], contracts: [], ...area };
    this.features.insert(id, person, full, await this.sign(this.features.draftRecord(id, "open_feature", { person }, {})));
    this.features.setRepo(id, `feature-${id}`);
    if (session !== undefined) {
      this.sessions.set(session.id, { person, handle: session.handle });
      this.features.join(id, session.id);
    }
  }

  /** Records `sha`, built on `baseline`, as feature `id`'s latest checkpoint, reported by `handle`. */
  async checkpoint(id: string, sha: string, baseline: string, handle: string): Promise<void> {
    const feature = this.features.get(id);
    if (feature === undefined) throw new Error(`no feature ${id}`);
    const draft = this.features.draftRecord(id, "checkpoint_area", { identity: handle }, { checkpoint: sha, baseline, added_scopes: [], added_paths: [] });
    this.features.setArea(id, feature.area, await this.sign(draft), sha);
  }

  heartbeat(caller: string, sessionId: string): SessionOutcome {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.person !== caller) {
      return { status: "rejected", reason: "not_found", message: `no session ${sessionId} of ${caller}` } as SessionOutcome;
    }
    const view: Session = {
      id: sessionId,
      identityId: session.handle,
      handle: session.handle,
      vendor: "test",
      worktreeId: "wt",
      branch: "main",
      status: "running",
      currentIssueId: null,
      lastSeen: new Date(0).toISOString(),
    };
    return { status: "ok", session: view };
  }

  propose(caller: string, sessionId: string, feature: string, parts: unknown): Promise<ProposePlanOutcome> {
    return proposePlan(
      {
        features: this.features,
        facts: this.facts,
        keeper: () => this.plans,
        scopeMap: async () => this.scopeMap,
        invariantsFile: async () => (this.invariants === null ? null : new TextEncoder().encode(this.invariants)),
        dependents: (id) => this.overlaps.dependents(id),
        readRepo: async (repo, use) => {
          const reader = gitReader(this.repoDir);
          this.reads.push({ repo, calls: reader.calls });
          return use(reader);
        },
        heartbeat: (who, session) => this.heartbeat(who, session),
        sign: (draft) => this.sign(draft),
        breakLimit: this.breakLimit,
        exception: (person, feature) => {
          this.exceptions.push({ person, feature });
          this.inbox.planReturned(person, feature);
        },
        ...(this.announce === undefined ? {} : { announce: this.announce }),
      },
      caller,
      sessionId,
      { feature, parts },
    );
  }

  /** The feature's signed records of one type, parsed. */
  records(featureId: string, type: string): FeatureRecord[] {
    return this.features
      .records(featureId)
      .map((stored) => JSON.parse(stored.file) as FeatureRecord)
      .filter((record) => record.type === type);
  }
}
