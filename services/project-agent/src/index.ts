import { Agent } from "agents";

import {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type BridgeCaller,
  type OperationKeys,
  type PendingListing,
  type PendingSource,
  type SqlDatabase,
  type SqlValue,
  type SubmitOutcome,
  type TimelineEntry,
} from "./issue-index.ts";
import { IngestLedger, ingestPush, type IngestReport } from "./push-ingest.ts";
import { rebuildIndex, type RebuildReport } from "./rebuild.ts";
import { parseScopeFile, SCOPE_MAP_PATH } from "./scope-file.ts";
import {
  IdentityStore,
  type Identity,
  type IdentityChanges,
  type IdentityInput,
  type IdentityOutcome,
  type TeamIdentityInput,
} from "./identity-store.ts";
import { importServiceKey, type ServiceKey } from "./service-key.ts";
import type { IssueRecord } from "@penguin/issues";
import type { Author } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import {
  BridgeRegistry,
  type BridgeIdentity,
  type BridgeRole,
  type RegisterOutcome,
  type RegistrationCode,
} from "./bridge-registry.ts";

export {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type BridgeCaller,
  type IdentitySource,
  type OperationKeys,
  type PendingFile,
  type PendingListing,
  type PendingSource,
  type SqlDatabase,
  type SubmitInput,
  type SubmitOutcome,
  type TimelineEntry,
} from "./issue-index.ts";
export {
  IDENTITY_LIMITS,
  IdentityStore,
  type Avatar,
  type AvatarMediaType,
  type Identity,
  type IdentityChanges,
  type IdentityInput,
  type IdentityOutcome,
  type IdentityRejectReason,
  type TeamIdentityInput,
} from "./identity-store.ts";
export { importServiceKey, type ServiceKey } from "./service-key.ts";
export type { IngestReport } from "./push-ingest.ts";
export type { IndexComparison, RebuildReport, RowDifference, TableComparison } from "./rebuild.ts";

/** The Worker secret this class reads. `wrangler types` does not list secrets, so it is declared here. */
interface ServiceKeyEnv {
  readonly PENGUIN_OP_SIGNING_KEY?: string;
}
export {
  BRIDGE_ROLES,
  BridgeRegistry,
  type BridgeIdentity,
  type BridgeRole,
  type RegisterOutcome,
  type RegisteredBridge,
  type RegistrationCode,
} from "./bridge-registry.ts";

/** The project's repos the agent reads, named by the Worker from its configuration. */
export interface ProjectRepos {
  /** The issues repo, which holds the operation log. */
  readonly issues: string;
  /** The base repo, whose `penguin/scopes.json` decides review rights. */
  readonly base: string;
}

/**
 * An operation handed to the agent directly. A CryptoKey cannot cross Durable Object RPC
 * (`wrangler dev` 4.149.0: "DataCloneError: Could not serialize object of type CryptoKey"), so the
 * agent loads the keys itself.
 */
export type OperationInput = Omit<ApplyInput, "keys">;

/** A push to the issues repo's main branch, taken from a `cf.artifacts.repo.pushed` event. */
export interface IssuesPush {
  readonly before: string;
  readonly after: string;
}

export type IngestResult = IngestReport & { readonly durationMs: number };

/**
 * Holds the project-wide state: issue index, scope map, owners, identities and sessions.
 * It keeps a counter in its SQL storage beside the issue index.
 */
export class ProjectAgent extends Agent {
  #sql: SqlDatabase | undefined;
  #issues: IssueIndex | undefined;
  #identities: IdentityStore | undefined;
  #serviceKey: Promise<ServiceKey> | undefined;
  #bridges: BridgeRegistry | undefined;
  #ledger: IngestLedger | undefined;
  /** Ingests run one at a time, so two pushes never interleave their walks and applies. */
  #ingests: Promise<unknown> = Promise.resolve();

  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    this.sql`INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)`;
  }

  /** POST increments the counter; any other method reads it. */
  override onRequest(request: Request): Response {
    if (request.method === "POST") {
      this.sql`UPDATE counter SET value = value + 1 WHERE id = 1`;
    }
    const [row] = this.sql<{ value: number }>`SELECT value FROM counter WHERE id = 1`;
    return Response.json({ agent: "ProjectAgent", name: this.name, counter: row?.value ?? 0 });
  }

  /**
   * Validates one operation, applies it to the issue index and records it in AppliedOp. A pushed
   * file that matches a pending operation instead records its commit and clears the PendingOp row.
   */
  async applyOperation(input: OperationInput, repos: ProjectRepos): Promise<ApplyOutcome> {
    return this.#index().apply({ ...input, keys: await this.#operationKeys(repos) });
  }

  /**
   * Applies the operation files added on the issues repo's main branch up to `push.after`, in
   * coordination order, and resolves once every one is recorded in AppliedOp. Commits already
   * ingested are skipped, so a repeated or late event applies nothing twice. `push.before` is not a
   * stopping point: see push-ingest.ts for why the walk ends at the last ingested commit instead.
   *
   * Rejects when key material or a Git object is missing, so no operation is judged without its
   * keys, and the caller retries.
   */
  ingestPush(push: IssuesPush, repos: ProjectRepos): Promise<IngestResult> {
    const run = this.#ingests.then(() => this.#ingest(push, repos));
    this.#ingests = run.catch(() => undefined);
    return run;
  }

  /**
   * Rebuilds the issue index from the issues repo into shadow tables and compares them row by row
   * with the live tables; see rebuild.ts. The live index is first caught up to the repo's head. Runs
   * in the ingest queue, so no push is applied part way through the rebuild.
   */
  rebuildIndex(repos: ProjectRepos): Promise<RebuildReport> {
    const run = this.#ingests.then(() => this.#rebuild(repos));
    this.#ingests = run.catch(() => undefined);
    return run;
  }

  /** One issue's state and its timeline of applied and rejected operations. */
  readIssue(id: string): { readonly issue: IssueRecord | undefined; readonly timeline: TimelineEntry[] } {
    return this.#index().read(id);
  }

  /**
   * Applies an operation from MCP, the dashboard or Penguin at once and queues it for the Git log.
   * `author` is the caller the gateway authenticated; the operation cannot name anyone else. The
   * operation is signed here with the service key (K5), which never leaves the Worker.
   */
  async submit(operation: unknown, author: Author, source: PendingSource, scopeMap: ScopeMap): Promise<SubmitOutcome> {
    const serviceKey = await this.#loadServiceKey();
    return this.#index().submit({
      operation,
      author,
      source,
      signingKey: serviceKey.privateKey,
      // Service-signed operations verify under the service key alone, so no bridge key is needed.
      keys: { bridges: [], serviceKey: serviceKey.publicKey, scopeMap, identities: this.#identityStore() },
    });
  }

  /**
   * For the integration runner only: every pending operation as the signed file to push and its
   * path. The push event for those files then reaches `ingestPush`, which clears the rows.
   */
  pendingOperations(caller: BridgeCaller): PendingListing {
    return this.#index().pendingFiles(caller);
  }

  /**
   * Creates an identity owned by `caller`, the person the gateway authenticated. The handle must be
   * "@<caller>/<name>", and each charter scope must be one of the caller's scopes in `scopeMap`.
   */
  createIdentity(caller: string, input: IdentityInput, scopeMap: ScopeMap): IdentityOutcome {
    return this.#identityStore().create(caller, input, scopeMap);
  }

  /**
   * Creates a team identity that serves `input.owners`, the caller among them. It works only within
   * the scopes of the owner who assigns it to an issue.
   */
  createTeamIdentity(caller: string, input: TeamIdentityInput, scopeMap: ScopeMap): IdentityOutcome {
    return this.#identityStore().createTeam(caller, input, scopeMap);
  }

  /** Changes an identity's fields. Only its owner, or one of a team identity's owners, may. */
  editIdentity(caller: string, id: string, changes: IdentityChanges, scopeMap: ScopeMap): IdentityOutcome {
    return this.#identityStore().edit(caller, id, changes, scopeMap);
  }

  /** Copies an identity under a new handle; the charter carries over and the history stays with the original. */
  duplicateIdentity(
    caller: string,
    id: string,
    copy: { readonly handle: string; readonly name?: string },
  ): IdentityOutcome {
    return this.#identityStore().duplicate(caller, id, copy);
  }

  readIdentity(id: string): Identity | undefined {
    return this.#identityStore().get(id);
  }

  #loadServiceKey(): Promise<ServiceKey> {
    if (this.#serviceKey === undefined) {
      const loading = importServiceKey((this.env as unknown as ServiceKeyEnv).PENGUIN_OP_SIGNING_KEY);
      // A failed import is retried on the next call, once the secret is set.
      loading.catch(() => (this.#serviceKey = undefined));
      this.#serviceKey = loading;
    }
    return this.#serviceKey;
  }

  /** Issues a one-time code that registers one bridge for `ownerId`. */
  issueBridgeRegistrationCode(ownerId: string, role: BridgeRole, ttlSeconds: number): Promise<RegistrationCode> {
    return this.#registry().issueCode(ownerId, role, ttlSeconds);
  }

  /** Spends a registration code and records the bridge's owner, role, public key and token hash. */
  registerBridge(code: string, publicKey: unknown): Promise<RegisterOutcome> {
    return this.#registry().register(code, publicKey);
  }

  /** The registered, unrevoked bridge holding `bridgeToken`, or undefined. */
  authenticateBridge(bridgeToken: string): Promise<BridgeIdentity | undefined> {
    return this.#registry().authenticate(bridgeToken);
  }

  /** Revokes a bridge. Returns false when no unrevoked bridge has that id. */
  revokeBridge(bridgeId: string): boolean {
    return this.#registry().revoke(bridgeId);
  }

  async #ingest(push: IssuesPush, repos: ProjectRepos): Promise<IngestResult> {
    const started = Date.now();
    const keys = await this.#operationKeys(repos);
    const index = this.#index();
    this.#ledger ??= new IngestLedger(this.#database());
    const ledger = this.#ledger;
    const report = await withRepo(this.env.ARTIFACTS, repos.issues, (repo) =>
      ingestPush(repo, push.after, ledger, (file, commit) =>
        index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys }),
      ),
    );
    return { ...report, durationMs: Date.now() - started };
  }

  async #rebuild(repos: ProjectRepos): Promise<RebuildReport> {
    const keys = await this.#operationKeys(repos);
    this.#ledger ??= new IngestLedger(this.#database());
    const live = { index: this.#index(), ledger: this.#ledger };
    return withRepo(this.env.ARTIFACTS, repos.issues, (repo) =>
      rebuildIndex({ repo, db: this.#database(), live, keys }),
    );
  }

  /**
   * The keys operations are judged by, read fresh for each call: the service key (K5), the signing
   * keys of unrevoked bridges only, so a revoked bridge's key no longer verifies, and the scope map.
   * The identity store supplies the charters of identity-authored operations.
   */
  async #operationKeys(repos: ProjectRepos): Promise<OperationKeys> {
    const [serviceKey, bridges, scopeFile] = await Promise.all([
      this.#loadServiceKey(),
      this.#registry().bridgeKeys(),
      withRepo(this.env.ARTIFACTS, repos.base, async (repo) => {
        const blob = await repo.readFile({ ref: "HEAD", path: SCOPE_MAP_PATH });
        return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
      }),
    ]);
    return {
      serviceKey: serviceKey.publicKey,
      bridges,
      scopeMap: parseScopeFile(scopeFile),
      identities: this.#identityStore(),
    };
  }

  #database(): SqlDatabase {
    this.#sql ??= durableObjectSql(this.ctx.storage);
    return this.#sql;
  }

  #registry(): BridgeRegistry {
    this.#bridges ??= new BridgeRegistry(this.#database());
    return this.#bridges;
  }

  #index(): IssueIndex {
    this.#issues ??= new IssueIndex(this.#database());
    return this.#issues;
  }

  #identityStore(): IdentityStore {
    this.#identities ??= new IdentityStore(this.#database());
    return this.#identities;
  }
}

/** Opens a repo through the binding, runs `use` with it and releases the RPC stub afterwards. */
async function withRepo<T>(artifacts: Artifacts, name: string, use: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  const repo = await artifacts.get(name);
  try {
    return await use(repo);
  } finally {
    repo[Symbol.dispose]();
  }
}

function durableObjectSql(storage: DurableObjectStorage): SqlDatabase {
  return {
    exec: (query: string, ...bindings: SqlValue[]) =>
      storage.sql.exec<Record<string, SqlValue>>(query, ...bindings).toArray(),
    transaction: (body) => storage.transactionSync(body),
  };
}
