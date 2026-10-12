// Rebuilds the issue index from the issues repo into shadow tables and compares them row by row
// with the live tables (PRD section 5: "It can rebuild the index from the issues repo at any time").
//
// The shadow index is a second IssueIndex over the same SQLite database, whose table and SQL index
// names carry the `Shadow_` prefix. It applies every operation file on the issues repo's main branch,
// read through the binding by the same walk the push events use (push-ingest.ts), so it follows the
// same coordination order (packages/protocol/src/order.ts) and the same validator and reducer.
//
// Before the shadow index is built, the live index is caught up to the same head, as a push event
// for that head would. Without that, a push event still in the Queue, or one that was missed, would
// show up as a difference that is only a delay.
//
// Where a rebuilt index can rightly differ from the live one:
//
// - Operations from MCP and the dashboard are applied live at once and reach the issues repo only
//   when the runner pushes them (#21). Until then the live tables hold them and the repo does not;
//   the report lists them under `pendingOps`.
// - Live order is not always Git order. A pending operation is applied live before any bridge
//   operation pushed after it, but the runner's commit lands after that bridge operation's commit.
//   When both are based on the same issue version, the live index applies the pending one and
//   rejects the bridge one as superseded; Git order, and so the rebuild, does the opposite. The
//   comparison reports both AppliedOp rows and the issue rows they touch.
// - An issue created offline takes the next number when its create is applied (#48). The rebuild
//   applies the same files in the same Git order, so it assigns the same numbers, with one exception
//   from the order gap above: a pending create that names its own number is in the live index at
//   once but in the rebuild only from the runner's commit. An offline create applied between the two
//   takes a different number live than in the rebuild.
// - An issue created offline and applied before #48 is stored live under its temporary ID; the
//   rebuild gives it a number and keeps the temporary ID as its alias.
// - The rebuild judges every operation with today's keys, scope map and delegates. An operation from
//   a bridge revoked since verifies live but not in the rebuild. A review by an owner whose scope has
//   moved, or by a delegate named or dropped since, counts live but not in the rebuild, or the other
//   way round: the Review rows differ in `counts` and `counts_for`.
// - A review without rights applied before #49 was rejected live with `no_right`; the rebuild keeps
//   it as a review that does not count.
//
// The comparison is a check; it never changes the live tables.

import type { SqlDatabase, SqlValue } from "./issue-index.ts";
import { ISSUE_INDEX_SCHEMA, IssueIndex, type OperationKeys } from "./issue-index.ts";
import {
  countCalls,
  INGEST_LEDGER_SCHEMA,
  IngestLedger,
  ingestPush,
  type IngestReport,
  type IssuesRepoReader,
} from "./push-ingest.ts";

type Row = Record<string, SqlValue>;

/** The issues repo branch the index follows (packages/protocol/src/order.ts, rule 1). */
const ISSUES_BRANCH = "main";

/** The prefix of every shadow table and SQL index name. */
export const SHADOW_PREFIX = "Shadow_";

export interface ComparedTable {
  /** The columns that identify a row. */
  readonly key: readonly string[];
  /** Columns left out of the comparison. */
  readonly ignore?: readonly string[];
}

/**
 * The index tables the comparison reads, each with the columns that identify a row. AppliedOp.seq is
 * the live apply sequence, which counts submissions that were never pushed, so it is not compared.
 * Assignment.session_id is live routing state (session-store.ts): the shadow index never routes.
 */
export const COMPARED_TABLES: Readonly<Record<string, ComparedTable>> = {
  Issue: { key: ["id"] },
  Assignment: { key: ["issue_id", "assignee_kind", "assignee_id"], ignore: ["session_id"] },
  Comment: { key: ["id"] },
  CommentRevision: { key: ["comment_id", "rev"] },
  Mention: { key: ["op_id"] },
  LinkedCommit: { key: ["op_id"] },
  IssueCheck: { key: ["op_id"] },
  SubIssue: { key: ["child_id"] },
  Review: { key: ["op_id"] },
  Thread: { key: ["id"] },
  AppliedOp: { key: ["op_id"], ignore: ["seq"] },
};

/**
 * Tables in the agent's database with no counterpart in the repo: PendingOp holds operations not yet
 * pushed, the session router's tables (session-store.ts) hold sessions, acceptances, requests,
 * fix tasks waiting for a session's checkpoint and the threads, overlapping starts, settled
 * locks and advance notice each session was told of, and InboxItem (inbox-store.ts) holds read flags and items for those requests.
 */
export const LIVE_ONLY_TABLES: readonly string[] = [
  "PendingOp",
  "Session",
  "AssignmentAcceptance",
  "OwnerRequest",
  "PendingDelivery",
  "ThreadNotice",
  "OverlapNotice",
  "SettledNotice",
  "PlanNotice",
  "InboxItem",
];

/** The comparison lists at most this many differing rows; `differing` counts them all. */
const MAX_LISTED_DIFFERENCES = 100;

export interface RowDifference {
  readonly table: string;
  /** The key columns of the differing row. */
  readonly key: Readonly<Record<string, SqlValue>>;
  /** The live row, or null when only the rebuild has it. */
  readonly live: Row | null;
  /** The rebuilt row, or null when only the live index has it. */
  readonly shadow: Row | null;
}

export interface TableComparison {
  readonly live: number;
  readonly shadow: number;
  readonly differing: number;
}

export interface IndexComparison {
  readonly equal: boolean;
  readonly tables: Readonly<Record<string, TableComparison>>;
  /** The first differing rows, table by table in the order of COMPARED_TABLES. */
  readonly differences: readonly RowDifference[];
  /** True when more rows differ than `differences` lists. */
  readonly truncated: boolean;
}

export interface RebuildReport {
  /** The issues repo commit both indexes were brought to, or null when the repo has no commits. */
  readonly head: string | null;
  /** Commits and files the live index had not yet ingested, applied before the rebuild. */
  readonly caughtUp: IngestReport | null;
  /** The rebuild's walk of the whole first-parent history. */
  readonly rebuilt: IngestReport | null;
  /** Live operations still waiting for the runner, which the repo cannot hold yet. */
  readonly pendingOps: readonly string[];
  readonly comparison: IndexComparison;
  /** Binding calls of the whole rebuild, head lookup included, by method name. */
  readonly bindingCalls: Readonly<Record<string, number>>;
  readonly durationMs: number;
}

export interface RebuildInput {
  readonly repo: IssuesRepoReader;
  /** The database holding the live index; the shadow tables are created beside it. */
  readonly db: SqlDatabase;
  readonly live: { readonly index: IssueIndex; readonly ledger: IngestLedger };
  /** The keys both the catch-up and the rebuild judge operations by. */
  readonly keys: OperationKeys;
  readonly now?: () => number;
}

/**
 * Catches the live index up to the head of the issues repo's main branch, rebuilds the index from
 * the whole history into fresh shadow tables, and compares the two. The shadow tables stay until the
 * next rebuild, for inspection.
 *
 * Throws when a Git object is missing, like a push ingest, so the caller can retry.
 */
export async function rebuildIndex({ repo, db, live, keys, now = Date.now }: RebuildInput): Promise<RebuildReport> {
  const started = now();
  const counted = countCalls(repo);
  const [latest] = await counted.repo.log({ ref: ISSUES_BRANCH, limit: 1, offset: 0 });
  const head = latest?.hash ?? null;

  let caughtUp: IngestReport | null = null;
  let rebuilt: IngestReport | null = null;
  const shadowDb = shadowDatabase(db);
  dropShadowTables(shadowDb);
  const shadow = { index: new IssueIndex(shadowDb), ledger: new IngestLedger(shadowDb) };

  if (head !== null) {
    caughtUp = await ingestPush(repo, head, live.ledger, (file, commit) =>
      live.index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys }),
    );
    rebuilt = await ingestPush(repo, head, shadow.ledger, (file, commit) =>
      shadow.index.apply({ file: file.bytes, gitCommit: commit, path: file.path, keys }),
    );
  }

  return {
    head,
    caughtUp,
    rebuilt,
    pendingOps: db.exec(`SELECT op_id FROM PendingOp ORDER BY rowid`).map((row) => row["op_id"] as string),
    comparison: compareIndexes(db),
    bindingCalls: sumCalls([counted.calls, caughtUp?.bindingCalls ?? {}, rebuilt?.bindingCalls ?? {}]),
    durationMs: now() - started,
  };
}

/** Compares each table in COMPARED_TABLES with its shadow copy, row by row on the table's key. */
export function compareIndexes(db: SqlDatabase): IndexComparison {
  const tables: Record<string, TableComparison> = {};
  const differences: RowDifference[] = [];
  let total = 0;
  for (const [table, { key, ignore = [] }] of Object.entries(COMPARED_TABLES)) {
    // Table names come from the constant above, never from input.
    const liveRows = keyedRows(db.exec(`SELECT * FROM ${table} ORDER BY rowid`), key, ignore);
    const shadowRows = keyedRows(db.exec(`SELECT * FROM ${SHADOW_PREFIX}${table} ORDER BY rowid`), key, ignore);
    let differing = 0;
    const note = (live: Row | null, shadow: Row | null): void => {
      differing += 1;
      const row = (live ?? shadow) as Row;
      if (differences.length < MAX_LISTED_DIFFERENCES) {
        const id = Object.fromEntries(key.map((column) => [column, row[column] ?? null]));
        differences.push({ table, key: id, live, shadow });
      }
    };
    for (const [id, live] of liveRows) {
      const shadow = shadowRows.get(id);
      if (shadow === undefined || shadow.text !== live.text) note(live.row, shadow?.row ?? null);
    }
    for (const [id, shadow] of shadowRows) if (!liveRows.has(id)) note(null, shadow.row);
    tables[table] = { live: liveRows.size, shadow: shadowRows.size, differing };
    total += differing;
  }
  return { equal: total === 0, tables, differences, truncated: total > differences.length };
}

/**
 * The database seen through the shadow names: every table and SQL index the issue index or the
 * ingest ledger creates gets SHADOW_PREFIX. Queries name tables as bare identifiers and pass every
 * value as a bound parameter, so renaming identifiers in the query text reaches every table.
 */
export function shadowDatabase(db: SqlDatabase): SqlDatabase {
  const names = [...ISSUE_INDEX_SCHEMA, INGEST_LEDGER_SCHEMA].map((statement) => {
    const name = /^CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/u.exec(statement)?.[1];
    if (name === undefined) throw new Error(`cannot read a name from: ${statement}`);
    return name;
  });
  const pattern = new RegExp(`\\b(${names.join("|")})\\b`, "gu");
  return {
    exec: (query, ...bindings) => db.exec(query.replace(pattern, `${SHADOW_PREFIX}$1`), ...bindings),
    transaction: (body) => db.transaction(body),
  };
}

/** Drops every shadow table, and with them their SQL indexes. */
function dropShadowTables(shadowDb: SqlDatabase): void {
  for (const statement of [...ISSUE_INDEX_SCHEMA, INGEST_LEDGER_SCHEMA]) {
    const table = /^CREATE TABLE IF NOT EXISTS (\w+)/u.exec(statement)?.[1];
    if (table !== undefined) shadowDb.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** Rows by the JSON of their key columns, each with the JSON of its compared columns. */
function keyedRows(
  rows: readonly Row[],
  key: readonly string[],
  ignore: readonly string[],
): Map<string, { readonly row: Row; readonly text: string }> {
  const keyed = new Map<string, { row: Row; text: string }>();
  for (const row of rows) {
    const compared = Object.entries(row).filter(([column]) => !ignore.includes(column));
    keyed.set(JSON.stringify(key.map((column) => row[column] ?? null)), {
      row: Object.fromEntries(compared),
      // SQLite returns columns in table order, and both tables share one schema.
      text: JSON.stringify(compared),
    });
  }
  return keyed;
}

function sumCalls(reports: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const calls of reports) {
    for (const [method, count] of Object.entries(calls)) total[method] = (total[method] ?? 0) + count;
  }
  return total;
}
