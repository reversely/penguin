import { Agent } from "agents";

import {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type SqlDatabase,
  type SqlValue,
  type TimelineEntry,
} from "./issue-index.ts";
import type { IssueRecord } from "@penguin/issues";

export {
  IssueIndex,
  type ApplyInput,
  type ApplyOutcome,
  type OperationKeys,
  type SqlDatabase,
  type TimelineEntry,
} from "./issue-index.ts";

/**
 * Holds the project-wide state: issue index, scope map, owners, identities and sessions.
 * It keeps a counter in its SQL storage beside the issue index.
 */
export class ProjectAgent extends Agent {
  #issues: IssueIndex | undefined;

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

  /** Validates one operation, applies it to the issue index and records it in AppliedOp. */
  applyOperation(input: ApplyInput): Promise<ApplyOutcome> {
    return this.#index().apply(input);
  }

  /** One issue's state and its timeline of applied and rejected operations. */
  readIssue(id: string): { readonly issue: IssueRecord | undefined; readonly timeline: TimelineEntry[] } {
    return this.#index().read(id);
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
