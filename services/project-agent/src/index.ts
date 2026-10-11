import { Agent } from "agents";

import {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type BridgeCaller,
  type PendingListing,
  type PendingSource,
  type SqlDatabase,
  type SqlValue,
  type SubmitOutcome,
  type TimelineEntry,
} from "./issue-index.ts";
import { importServiceKey, type ServiceKey } from "./service-key.ts";
import type { IssueRecord } from "@penguin/issues";
import type { Author } from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

export {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type BridgeCaller,
  type OperationKeys,
  type PendingFile,
  type PendingListing,
  type PendingSource,
  type SqlDatabase,
  type SubmitInput,
  type SubmitOutcome,
  type TimelineEntry,
} from "./issue-index.ts";
export { importServiceKey, type ServiceKey } from "./service-key.ts";

/** The Worker secret this class reads. `wrangler types` does not list secrets, so it is declared here. */
interface ServiceKeyEnv {
  readonly PENGUIN_OP_SIGNING_KEY?: string;
}

/**
 * Holds the project-wide state: issue index, scope map, owners, identities and sessions.
 * It keeps a counter in its SQL storage beside the issue index.
 */
export class ProjectAgent extends Agent {
  #issues: IssueIndex | undefined;
  #serviceKey: Promise<ServiceKey> | undefined;

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
  applyOperation(input: ApplyInput): Promise<ApplyOutcome> {
    return this.#index().apply(input);
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
      keys: { bridges: [], serviceKey: serviceKey.publicKey, scopeMap },
    });
  }

  /**
   * For the integration runner only: every pending operation as the signed file to push and its
   * path. The push event for those files then reaches `applyOperation`, which clears the rows.
   */
  pendingOperations(caller: BridgeCaller): PendingListing {
    return this.#index().pendingFiles(caller);
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

  #index(): IssueIndex {
    this.#issues ??= new IssueIndex(durableObjectSql(this.ctx.storage));
    return this.#issues;
  }
}

function durableObjectSql(storage: DurableObjectStorage): SqlDatabase {
  return {
    exec: (query: string, ...bindings: SqlValue[]) =>
      storage.sql.exec<Record<string, SqlValue>>(query, ...bindings).toArray(),
    transaction: (body) => storage.transactionSync(body),
  };
}
