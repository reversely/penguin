// The caller protocol's items (packages/protocol/src/caller-items.ts): one per running feature and
// contract an originating feature's caller replay reaches.
//
// - The originating feature's FeatureAgent keeps the items (`CallerItemStore`). The ProjectAgent keeps
//   a short index of them (`CallerIndexStore`), so the receiving side's reads find the originating
//   features without asking every FeatureAgent.
// - Every replay of the feature, a `check` run's or a block run's, opens the items it reaches and
//   updates those it already holds (`replayReported`): a caller whose calls changed resets its item to
//   its verdict's first state, and an item no replay reaches is withdrawn.
// - Agents move the items with four tools (`callerAction`): `confirm_caller`, `review_caller` (the
//   receiving branch's agent), `propose_caller_fix` and `explain_difference` (the originating agent).
//   The worktree owner decides on the dashboard (`ownerDecision`).
// - Every transition is a signed record on the originating feature, signed before the item is kept,
//   and kept only while the item still stands at the record it was read at.
// - A write into a receiving fork waits until every item there is approved from the receiving side
//   (`writeWaits`); the originating feature reaches main only once every item is settled (`landPending`).
// - Every agent answer cites the replay (#189): a confirmation names the run it read, an explanation
//   classifies each differing call by its call id and a review gives each call a verdict with evidence
//   the replay ran, from a test on main before the change. Penguin looks each id up in the item and
//   never builds a message from text it did not find there. A refused answer leaves its reason on the
//   item until the item next moves.

import {
  CALLER_ACTION_BY,
  CALLER_ACTION_FROM,
  CALLER_ITEM_LIMITS,
  CALLER_OPENING_STATE,
  CALLER_REJECTION_LIMIT,
  CALLER_STAGES,
  callerItemSettled,
  callerItemView,
  callerWaitingOn,
  itemVerdict,
  ownerApproved,
  ownerRequestedChanges,
  REPLAY_CALL_ID_PATTERN,
  REPLAY_RUN_ID_PATTERN,
  type Author,
  type CallerCallClass,
  type HeldReplay,
  type CallerCallKind,
  type CallerCallVerdict,
  type CallerItem,
  type CallerItemAction,
  type CallerItemRequest,
  type CallerItemState,
  type CallerItemView,
  type CallerOwnerReason,
  type CallerRefusalCode,
  type CallerReplaySection,
  type CallerUnlistedClass,
  type CallerUnlistedVerdict,
  type CallerVerdict,
  type Plan,
  type ReviewPreset,
} from "@penguin/protocol";

import type { Delegates } from "@penguin/issues";

import { parseFeatureId, type FeatureRecord, type FeatureRecordType, type FeatureStore, type UnsignedFeatureRecord } from "./feature-store.ts";
import type { SqlDatabase } from "./issue-index.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";
import type { ChangedFile, GitObjectReader } from "./repo-diff.ts";
import type { SessionOutcome } from "./session-store.ts";

export const CALLER_ITEM_STORE_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS CallerItem (
    item_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL, target_feature_id TEXT NOT NULL, contract TEXT NOT NULL,
    state TEXT NOT NULL, record_id TEXT NOT NULL, item TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS CallerItem_feature ON CallerItem (feature_id, item_id)`,
];

/** What the ProjectAgent asks of a feature's item store, over Durable Object RPC in the Worker. */
export interface CallerItemKeeper {
  /** Every item the feature's replays opened, in item id order. */
  callerItems(featureId: string): CallerItem[] | Promise<CallerItem[]>;
  /**
   * Keeps `item` while the stored item's newest record is still `expected` (null: no item yet). False,
   * keeping nothing, when another transition came first.
   */
  keepCallerItem(item: CallerItem, expected: string | null): boolean | Promise<boolean>;
}

/** The items of the features a FeatureAgent keeps, on one SQL database. */
export class CallerItemStore implements CallerItemKeeper {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of CALLER_ITEM_STORE_SCHEMA) db.exec(statement);
  }

  callerItems(featureId: string): CallerItem[] {
    return this.#db.exec(`SELECT item FROM CallerItem WHERE feature_id = ? ORDER BY item_id`, featureId).map((row) => JSON.parse(row["item"] as string) as CallerItem);
  }

  keepCallerItem(item: CallerItem, expected: string | null): boolean {
    return this.#db.transaction(() => {
      const [row] = this.#db.exec(`SELECT record_id FROM CallerItem WHERE item_id = ?`, item.itemId);
      if ((row?.["record_id"] ?? null) !== expected) return false;
      this.#db.exec(
        `INSERT INTO CallerItem (item_id, feature_id, target_feature_id, contract, state, record_id, item, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET state = excluded.state, record_id = excluded.record_id, item = excluded.item, updated_at = excluded.updated_at`,
        item.itemId,
        item.origin,
        item.feature,
        item.contract,
        item.state,
        item.recordId,
        JSON.stringify(item),
        Date.parse(item.updatedAt),
      );
      return true;
    });
  }
}

export const CALLER_INDEX_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS CallerItemIndex (
    item_id TEXT PRIMARY KEY, origin TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL,
    waiting_on TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS CallerItemIndex_target ON CallerItemIndex (target)`,
  `CREATE INDEX IF NOT EXISTS CallerItemIndex_waiting ON CallerItemIndex (waiting_on, updated_at)`,
];

/** The ProjectAgent's index of every item: which originating feature keeps it and who it waits on. */
export class CallerIndexStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    for (const statement of CALLER_INDEX_SCHEMA) db.exec(statement);
  }

  note(item: CallerItem): void {
    this.#db.exec(
      `INSERT INTO CallerItemIndex (item_id, origin, target, state, waiting_on, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET state = excluded.state, waiting_on = excluded.waiting_on, updated_at = excluded.updated_at`,
      item.itemId,
      item.origin,
      item.feature,
      item.state,
      callerWaitingOn(item),
      Date.parse(item.updatedAt),
    );
  }

  /** The originating feature that keeps item `itemId`, or undefined. */
  originOf(itemId: string): string | undefined {
    const [row] = this.#db.exec(`SELECT origin FROM CallerItemIndex WHERE item_id = ?`, itemId);
    return row === undefined ? undefined : (row["origin"] as string);
  }

  /** The originating features with an item on any of `targets`. */
  originsOn(targets: readonly string[]): string[] {
    if (targets.length === 0) return [];
    return this.#db
      .exec(`SELECT DISTINCT origin FROM CallerItemIndex WHERE target IN (${targets.map(() => "?").join(", ")}) ORDER BY origin`, ...targets)
      .map((row) => row["origin"] as string);
  }

  /** The originating features with an item that has waited on the receiving agent since before `before`. */
  waitingSince(before: number): string[] {
    return this.#db
      .exec(`SELECT DISTINCT origin FROM CallerItemIndex WHERE waiting_on = 'receiving_agent' AND updated_at < ? ORDER BY origin`, before)
      .map((row) => row["origin"] as string);
  }
}

export interface CallerItemDeps {
  readonly features: FeatureStore;
  /** The item store of one originating feature: its FeatureAgent. */
  readonly keeper: (featureId: string) => CallerItemKeeper;
  readonly index: CallerIndexStore;
  readonly sign: (record: UnsignedFeatureRecord) => Promise<FeatureRecord>;
  /** The review policy's stage in force (validation.ts). */
  readonly stage: () => Promise<ReviewPreset>;
  /** Tells a person's open dashboards that their inbox or a feature they follow changed. */
  readonly notify: (personId: string) => void;
  readonly now?: () => number;
}

export interface CallerActionDeps extends CallerItemDeps {
  readonly heartbeat: (caller: string, sessionId: string) => SessionOutcome;
  /** The originating feature's newest plan, whose part a fix proposal names. */
  readonly plan: (featureId: string) => Promise<Plan | undefined>;
  /** Whether that revision of a part is already written into its fork (FixGrantStore); absent, none is. */
  readonly written?: (partId: string, revision: number) => boolean;
  /**
   * Where each test, by pytest node id, stands against the item's originating change at the item's
   * checkpoint and the receiving feature's change at the replayed fork head (`testStandingOf`). Raises
   * when either change cannot be read.
   */
  readonly testStanding: (item: CallerItem, tests: readonly string[]) => Promise<ReadonlyMap<string, TestStanding>>;
}

/**
 * A test against an originating change. `added` and `edited`: the change adds the test or edits its
 * file other than by appending new tests. Otherwise `main`: the test was on main before the change;
 * `receiving`: the receiving feature's change wrote its file; `not_on_main`: neither.
 */
export type TestStanding = "main" | "receiving" | "added" | "edited" | "not_on_main";

type OwnChangeFiles = { readonly mergeBase: string; readonly files: readonly ChangedFile[] };

/** The most bytes of a test file read to compare its two versions; a larger edited file counts as edited. */
const TEST_FILE_BYTES = 262_144;

/**
 * Where each of `tests` (pytest node ids) stands. `origin` is the originating change's merge base with
 * main and the files it changes (protected-change.ts `ownChange`); `fork` reads that merge base's tree
 * and both versions of an edited file. `receiving` is the receiving feature's change the same way: a
 * test it wrote is the reviewing side's evidence, never the originating change's, so it counts beside
 * main's. A file the change only appends new top-level tests to keeps its earlier tests as they were on
 * main, so those count; any other edit of the file counts against every test in it.
 */
export async function testStandingOf(
  fork: Pick<GitObjectReader, "readCommit" | "readTree" | "readBlob">,
  origin: OwnChangeFiles,
  receiving: OwnChangeFiles,
  tests: readonly string[],
): Promise<Map<string, TestStanding>> {
  const changed = new Map(origin.files.map((file) => [file.path, file]));
  const written = new Set(receiving.files.filter((file) => file.newHash !== null).map((file) => file.path));
  const base = await fork.readCommit(origin.mergeBase);
  if (base === null) throw new Error(`merge base ${origin.mergeBase} is not in the fork`);
  const standing = new Map<string, TestStanding>();
  for (const test of new Set(tests)) {
    const path = test.split("::", 1)[0] as string;
    const file = changed.get(path);
    if (file === undefined) standing.set(test, (await treeHasFile(fork, base.treeHash, path)) ? "main" : written.has(path) ? "receiving" : "not_on_main");
    else if (file.oldHash === null) standing.set(test, "added");
    else standing.set(test, await editedTestStanding(fork, file, test));
  }
  return standing;
}

/** A test in a file the change edits: `main` when the edit only appends new tests and the test was there before. */
async function editedTestStanding(fork: Pick<GitObjectReader, "readBlob">, file: ChangedFile, test: string): Promise<TestStanding> {
  if (file.oldHash === null || file.newHash === null) return "edited";
  const [before, after] = await Promise.all([fork.readBlob(file.oldHash), fork.readBlob(file.newHash)]);
  if (before === null || after === null || before.size > TEST_FILE_BYTES || after.size > TEST_FILE_BYTES) return "edited";
  const [old, now] = await Promise.all([before.text(), after.text()]);
  const name = (test.split("::").at(-1) ?? "").replace(/\[.*$/su, "");
  const defined = new RegExp(`^\\s*(?:async\\s+)?def\\s+${name.replace(/[^A-Za-z0-9_]/gu, "")}\\s*\\(`, "mu");
  if (name === "" || !defined.test(old)) return "added";
  return onlyAddsTests(old.split("\n"), now.split("\n")) ? "main" : "edited";
}

/**
 * Whether `after` keeps every line of `before` in order and each line it adds is blank or belongs to a
 * new top-level test: a `def test_` line, its decorators and its indented body.
 */
function onlyAddsTests(before: readonly string[], after: readonly string[]): boolean {
  let kept = 0;
  let inNewTest = false;
  for (const line of after) {
    if (kept < before.length && line === before[kept]) {
      kept += 1;
      if (/^\S/u.test(line)) inNewTest = false;
      continue;
    }
    if (line.trim() === "") continue;
    if (/^(?:@|(?:async\s+)?def\s+test_)/u.test(line)) inNewTest = true;
    else if (!(inNewTest && /^\s/u.test(line))) return false;
  }
  return kept === before.length;
}

/** Whether root tree `tree` holds a file at `path`, read one directory at a time. */
async function treeHasFile(reader: Pick<GitObjectReader, "readTree">, tree: string, path: string): Promise<boolean> {
  let current = tree;
  const segments = path.split("/");
  for (const [index, name] of segments.entries()) {
    const entry = (await reader.readTree(current))?.find((each) => each.name === name);
    if (entry === undefined) return false;
    if (index === segments.length - 1) return entry.type !== "tree";
    if (entry.type !== "tree") return false;
    current = entry.hash;
  }
  return false;
}

export type CallerRejectReason = "invalid" | "forbidden" | "not_found" | "conflict" | "offline" | CallerRefusalCode;
export type CallerRejection = { readonly status: "rejected"; readonly reason: CallerRejectReason; readonly message: string };
export type CallerOutcome = { readonly status: "ok"; readonly item: CallerItem; readonly recordIds: readonly string[] } | CallerRejection;

const rejected = (reason: CallerRejectReason, message: string): CallerRejection => ({ status: "rejected", reason, message });
const isRejection = (value: unknown): value is CallerRejection => typeof value === "object" && value !== null && (value as { status?: unknown }).status === "rejected";

/** The record type each action is signed as: Penguin's own as `caller_item`, each tool's under the tool's name. */
const RECORD_TYPE: Readonly<Record<CallerItemAction, FeatureRecordType>> = {
  open: "caller_item",
  reset: "caller_item",
  withdraw: "caller_item",
  ask_owner: "caller_item",
  write: "caller_item",
  confirm: "confirm_caller",
  propose_fix: "propose_caller_fix",
  explain: "explain_difference",
  request_review: "explain_difference",
  approve_fix: "review_caller",
  reject_fix: "review_caller",
  approve: "review_caller",
  request_changes: "review_caller",
  owner_approve: "decide_caller",
  owner_request_changes: "decide_caller",
};

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The item id of one originating feature, receiving feature and contract. */
export async function callerItemId(origin: string, feature: string, contract: string): Promise<string> {
  return `caller-${(await sha256Hex(JSON.stringify([origin, feature, contract]))).slice(0, 16)}`;
}

/**
 * The fingerprint of an item's callers: each call site's verdict and each differing call's outcome
 * and effects. Run ids and timings are left out, so a replay of the same behaviour on new commits
 * keeps the item where it stands.
 */
async function fingerprintOf(callers: readonly CallerVerdict[]): Promise<string> {
  const sites = [...callers]
    .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
    .map((caller) => ({
      path: caller.path,
      line: caller.line,
      verdict: caller.verdict,
      differing: caller.differingCount,
      calls: caller.differing.map((call) => ({ id: call.callId, differs: call.differs, old: call.old, new: call.new })),
    }));
  return sha256Hex(JSON.stringify(sites));
}

const iso = (deps: Pick<CallerItemDeps, "now">): string => new Date((deps.now ?? Date.now)()).toISOString();

/** The party an action's author is, as the signed record names it. */
function authorOf(action: CallerItemAction, actor: string): Author {
  const by = CALLER_ACTION_BY[action];
  if (by === "penguin") return { penguin: true };
  if (by === "worktree_owner") return { person: actor };
  return { identity: actor };
}

/**
 * Signs one transition and keeps the item it leads to. The record names the item, the action, the
 * states before and after, the verdict and the replay runs the item stands on, plus `fields`.
 */
async function transition(
  deps: CallerItemDeps,
  before: CallerItem | null,
  after: Omit<CallerItem, "recordId" | "updatedAt">,
  action: CallerItemAction,
  actor: string,
  fields: Record<string, unknown> = {},
): Promise<CallerItem | CallerRejection> {
  const at = iso(deps);
  const record = await deps.sign(
    deps.features.draftRecord(after.origin, RECORD_TYPE[action], authorOf(action, actor), {
      item_id: after.itemId,
      feature: after.feature,
      contract: after.contract,
      action,
      from: before?.state ?? null,
      to: after.state,
      verdict: after.verdict,
      owner_asked: after.ownerAsked,
      rejections: after.rejections,
      fingerprint: after.fingerprint,
      run_ids: after.runs.map((run) => run.runId),
      source: { kind: after.source.kind, id: after.source.id, checkpoint: after.source.checkpoint },
      ...fields,
    }),
  );
  // A move clears the refusals: they explain why the item stood still.
  const item: CallerItem = { ...after, refusals: [], updatedAt: at, recordId: record.record_id };
  if (!(await deps.keeper(after.origin).keepCallerItem(item, before?.recordId ?? null))) {
    return rejected("conflict", `item ${after.itemId} moved while this answer was made; read it again in get_work`);
  }
  deps.features.addRecord(record);
  deps.index.note(item);
  for (const feature of [after.origin, after.feature]) {
    const person = deps.features.get(feature)?.personId;
    if (person !== undefined) deps.notify(person);
  }
  return item;
}

/** Who the worktree owner is asked by after the receiving side answers or rejects, on `stage`. */
function ownerAfter(stage: ReviewPreset, state: CallerItemState, rejections: number): CallerOwnerReason | null {
  if (rejections >= CALLER_REJECTION_LIMIT && (state === "fix_rejected" || state === "changes_requested" || state === "fix_proposed" || state === "review_requested")) return "rejected_twice";
  if (CALLER_STAGES[stage].decidesEvery && (state === "confirmed" || state === "fix_approved" || state === "approved")) return "policy";
  return null;
}

/**
 * The functions an originating feature's next replay keeps wrapping: those its unsettled items' runs
 * wrapped, with the receiving feature each belongs to (#193). A revision that restores a function to
 * main's bytes leaves it out of the impact report's changes; without this its items would be
 * withdrawn rather than shown `unaffected`, and no receiving agent could confirm them.
 */
export async function heldReplay(deps: Pick<CallerItemDeps, "keeper">, originId: string): Promise<HeldReplay[]> {
  const held = new Map<string, HeldReplay>();
  for (const item of await deps.keeper(originId).callerItems(originId)) {
    if (item.state === "withdrawn" || callerItemSettled(item, "land")) continue;
    for (const run of item.runs) {
      for (const symbol of run.symbols ?? []) {
        const key = JSON.stringify([symbol, item.feature]);
        if (!held.has(key)) held.set(key, { symbol, contract: item.contract, feature: item.feature });
      }
    }
  }
  return [...held.values()];
}

/**
 * A caller replay reached Penguin from the originating feature's `check` run (`source.kind` `check`)
 * or one of its block runs. Either opens an item per running feature and contract the replay reaches,
 * so a feature whose agent never called `check` meets the protocol at its land run (#190). An item
 * whose calls changed resets; one the replay no longer reaches is withdrawn. Answers the items that
 * moved.
 */
export async function replayReported(
  deps: CallerItemDeps,
  originId: string,
  section: CallerReplaySection,
  source: CallerItem["source"],
): Promise<CallerItem[]> {
  if (deps.features.get(originId) === undefined) return [];
  const existing = new Map((await deps.keeper(originId).callerItems(originId)).map((item) => [item.itemId, item]));
  const groups = new Map<string, { feature: string; contract: string; callers: CallerVerdict[] }>();
  for (const caller of section.callers) {
    const target = deps.features.get(caller.feature);
    if (caller.feature === originId || target === undefined || !RUNNING_STATES.has(target.state)) continue;
    const key = JSON.stringify([caller.feature, caller.contract]);
    const group = groups.get(key) ?? { feature: caller.feature, contract: caller.contract, callers: [] };
    group.callers.push(caller);
    if (groups.size < CALLER_ITEM_LIMITS.items || groups.has(key)) groups.set(key, group);
  }
  const runs = new Map(section.runs.map((run) => [run.runId, run]));
  const stage = await deps.stage();
  const moved: CallerItem[] = [];
  const reached = new Set<string>();
  for (const { feature, contract, callers } of groups.values()) {
    const itemId = await callerItemId(originId, feature, contract);
    reached.add(itemId);
    const fingerprint = await fingerprintOf(callers);
    const verdict = itemVerdict(callers);
    const itemRuns = [...new Set(callers.map((caller) => caller.runId))].flatMap((runId) => {
      const run = runs.get(runId);
      return run === undefined ? [] : [{ runId, symbols: run.symbols, forkCommit: run.forkCommit, mergedCommit: run.mergedCommit, scopes: run.scopes, tests: run.tests }];
    });
    const before = existing.get(itemId);
    const facts = { callers, runs: itemRuns, source, fingerprint, verdict };
    if (before !== undefined && before.fingerprint === fingerprint && before.state !== "withdrawn") {
      // The same calls on newer commits: the item stands, with the newest replay as its evidence.
      await deps.keeper(originId).keepCallerItem({ ...before, ...facts }, before.recordId);
      continue;
    }
    const state = CALLER_OPENING_STATE[verdict];
    const kept = await transition(
      deps,
      before ?? null,
      {
        itemId,
        origin: originId,
        feature,
        contract,
        ...facts,
        state,
        ownerAsked: verdict === "unknown_reach" ? "unknown_reach" : null,
        rejections: before?.rejections ?? 0,
        explanation: null,
        fix: null,
        review: null,
        openedAt: before?.openedAt ?? iso(deps),
      },
      before === undefined ? "open" : "reset",
      "penguin",
      { stage },
    );
    if (!isRejection(kept)) moved.push(kept);
  }
  for (const item of existing.values()) {
    if (reached.has(item.itemId) || item.state === "withdrawn") continue;
    const kept = await transition(deps, item, { ...item, source, state: "withdrawn", ownerAsked: null }, "withdraw", "penguin");
    if (!isRejection(kept)) moved.push(kept);
  }
  return moved;
}

/**
 * One call of a caller tool, as the MCP tools send it. `run` is the replay run a confirmation read.
 * `calls` answers each listed differing call by its id: `{ call, kind, reason }` in an explanation,
 * `{ call, verdict, evidence }` in a review. `unlisted` answers the calls the replay counted but did
 * not list, as one group with their count.
 */
export type CallerCall =
  | { readonly action: "confirm"; readonly item: unknown; readonly run?: unknown }
  | { readonly action: "propose_fix"; readonly item: unknown; readonly part: unknown; readonly revision: unknown; readonly note?: unknown }
  | { readonly action: "explain"; readonly item: unknown; readonly kind: unknown; readonly text: unknown; readonly calls?: unknown; readonly unlisted?: unknown }
  | { readonly action: "review"; readonly item: unknown; readonly verdict: unknown; readonly text?: unknown; readonly calls?: unknown; readonly unlisted?: unknown };

const ITEM_ID = /^caller-[0-9a-f]{16}$/u;
const RUN_ID = new RegExp(REPLAY_RUN_ID_PATTERN, "u");
const CALL_ID = new RegExp(REPLAY_CALL_ID_PATTERN, "u");

/**
 * Refuses an answer for want of real evidence and keeps the reason on the item, without moving it, so
 * the feature page shows why the item stands still. Only a session of the item's side reaches this.
 */
async function refuse(deps: CallerItemDeps, item: CallerItem, code: CallerRefusalCode, by: string, message: string): Promise<CallerRejection> {
  const refusals = [...(item.refusals ?? []), { code, by, at: iso(deps) }].slice(-CALLER_ITEM_LIMITS.refusals);
  if (await deps.keeper(item.origin).keepCallerItem({ ...item, refusals }, item.recordId)) {
    for (const feature of [item.origin, item.feature]) {
      const person = deps.features.get(feature)?.personId;
      if (person !== undefined) deps.notify(person);
    }
  }
  return rejected(code, message);
}

type Refused = { readonly code: CallerRefusalCode; readonly message: string };

/** The item's listed differing calls by id with the number its callers counted past them. */
function differingOf(item: CallerItem): { readonly listed: ReadonlyMap<string, CallerVerdict["differing"][number]>; readonly unlisted: number } {
  const listed = new Map(item.callers.flatMap((caller) => caller.differing.map((call) => [call.callId, call] as const)));
  const unlisted = item.callers.reduce((sum, caller) => sum + Math.max(0, caller.differingCount - caller.differing.length), 0);
  return { listed, unlisted };
}

/** A record's field as an object, or undefined. */
const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/**
 * The answers to every listed differing call and to the unlisted group, read with `entry` from the
 * tool's `calls` and `unlisted`. A malformed answer is `invalid`. An id the replay does not list, a
 * listed call left out, or unlisted calls answered without their exact count is refused by its code.
 */
function readAnswers<T, U>(
  item: CallerItem,
  calls: unknown,
  unlisted: unknown,
  entry: (value: Record<string, unknown>, at: string) => T | string,
  group: (value: Record<string, unknown>) => U | string,
): { readonly calls: (T & { readonly callId: string })[]; readonly unlisted: (U & { readonly count: number }) | null } | CallerRejection | Refused {
  const differing = differingOf(item);
  const given = calls ?? [];
  if (!Array.isArray(given) || given.length > CALLER_ITEM_LIMITS.answers) return rejected("invalid", `calls must be a list of at most ${CALLER_ITEM_LIMITS.answers} answers`);
  const answers: (T & { readonly callId: string })[] = [];
  const seen = new Set<string>();
  for (const [index, value] of given.entries()) {
    const fields = asRecord(value);
    const at = `calls[${index}]`;
    if (fields === undefined || typeof fields["call"] !== "string" || !CALL_ID.test(fields["call"])) return rejected("invalid", `${at}.call must be a call id, \`call-\` and 20 hexadecimal digits`);
    const callId = fields["call"];
    if (seen.has(callId)) return rejected("invalid", `${at} answers call ${callId} a second time`);
    seen.add(callId);
    if (!differing.listed.has(callId)) return { code: "call_unknown", message: `${at} names call ${callId}, which item ${item.itemId}'s replay does not list; answer the calls get_work lists` };
    const read = entry(fields, at);
    if (typeof read === "string") return rejected("invalid", read);
    answers.push({ ...read, callId });
  }
  const missing = [...differing.listed.keys()].filter((callId) => !seen.has(callId));
  if (missing.length > 0) return { code: "call_left_out", message: `answer every differing call; left out: ${missing.join(", ")}` };
  if (differing.unlisted === 0) {
    if (unlisted !== undefined && unlisted !== null) return rejected("invalid", "the replay listed every differing call; leave unlisted out");
    return { calls: answers, unlisted: null };
  }
  const fields = asRecord(unlisted);
  if (fields === undefined || fields["count"] !== differing.unlisted) {
    return { code: "unlisted_uncounted", message: `the replay counted ${differing.unlisted} differing calls past those it lists; answer them in unlisted with count ${differing.unlisted}` };
  }
  const read = group(fields);
  if (typeof read === "string") return rejected("invalid", read);
  return { calls: answers, unlisted: { ...read, count: differing.unlisted } };
}

/** One classification: `intended` or `incidental` with a reason. */
function readKind(fields: Record<string, unknown>, at: string): { readonly kind: CallerCallKind; readonly reason: string } | string {
  const { kind, reason } = fields;
  if (kind !== "intended" && kind !== "incidental") return `${at}.kind must be intended or incidental`;
  if (typeof reason !== "string" || reason.trim() === "") return `${at}.reason must be text`;
  if (reason.length > CALLER_ITEM_LIMITS.reasonLength) return `${at}.reason is over ${CALLER_ITEM_LIMITS.reasonLength} characters`;
  return { kind, reason };
}

/** One verdict with its evidence, the evidence checked later against the replay. */
function readVerdict(fields: Record<string, unknown>, at: string): { readonly verdict: "approve" | "request_changes"; readonly evidence: string } | string {
  const verdict = fields["verdict"];
  if (verdict !== "approve" && verdict !== "request_changes") return `${at}.verdict must be approve or request_changes`;
  const evidence = fields["evidence"];
  if (typeof evidence !== "string" || evidence === "" || evidence.length > CALLER_ITEM_LIMITS.reasonLength) {
    return `${at}.evidence must be a pytest node id or a call id of the replay`;
  }
  return { verdict, evidence };
}

const isRefused = (value: unknown): value is Refused => typeof value === "object" && value !== null && "code" in value && !("status" in value);

/**
 * Why a review's evidence is not real, or undefined. Each piece must be a replayed call id of the item
 * or a pytest node id the item's replay ran on the merged tree. The test behind it must have been on
 * main before the originating change or written by the receiving feature, and untouched by the
 * originating change.
 */
async function evidenceRefusal(deps: CallerActionDeps, item: CallerItem, cited: readonly { readonly at: string; readonly evidence: string }[]): Promise<Refused | CallerRejection | undefined> {
  const { listed } = differingOf(item);
  const ran = new Set(item.callers.flatMap((caller) => [...caller.tests, ...caller.differing.map((call) => call.test)]));
  const tests: { readonly at: string; readonly test: string }[] = [];
  for (const { at, evidence } of cited) {
    const test = listed.get(evidence)?.test ?? (ran.has(evidence) ? evidence : undefined);
    // The evidence is echoed only once it is found in the item: unfound text never reaches a message.
    if (test === undefined) return { code: "evidence_unknown", message: `${at}.evidence is no test or call of item ${item.itemId}'s replay; cite a call id or a test the packet lists` };
    tests.push({ at, test });
  }
  if (tests.length === 0) return undefined;
  let standing: ReadonlyMap<string, TestStanding>;
  try {
    standing = await deps.testStanding(item, tests.map(({ test }) => test));
  } catch (error) {
    console.error(JSON.stringify({ event: "caller_evidence_unread", item: item.itemId, error: String(error).slice(0, 200) }));
    return rejected("conflict", `Penguin could not read the files feature ${item.origin}'s change touches; try again`);
  }
  for (const { at, test } of tests) {
    const where = standing.get(test);
    if (where === "added" || where === "edited") {
      return { code: "evidence_from_change", message: `${at}.evidence runs ${test}, which feature ${item.origin}'s change ${where === "added" ? "adds" : "edits"}; cite a test that was on main before the change or that your feature wrote` };
    }
    if (where !== "main" && where !== "receiving") {
      return { code: "evidence_not_on_main", message: `${at}.evidence runs ${test}, which was neither on main before feature ${item.origin}'s change nor written by your feature` };
    }
  }
  return undefined;
}

function boundedText(value: unknown, field: string, required: boolean): string | CallerRejection {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && value.trim() === "")) return rejected("invalid", `${field} must be text`);
  if (value.length > CALLER_ITEM_LIMITS.textLength) return rejected("invalid", `${field} is over ${CALLER_ITEM_LIMITS.textLength} characters`);
  return value;
}

/** The item `itemId` with the originating feature that keeps it, or why not. */
async function findItem(deps: CallerItemDeps, itemId: unknown): Promise<CallerItem | CallerRejection> {
  if (typeof itemId !== "string" || !ITEM_ID.test(itemId)) return rejected("invalid", "the item must be a caller item id, `caller-` and 16 hexadecimal digits");
  const origin = deps.index.originOf(itemId);
  const item = origin === undefined ? undefined : (await deps.keeper(origin).callerItems(origin)).find((each) => each.itemId === itemId);
  return item === undefined ? rejected("not_found", `no caller item ${itemId}`) : item;
}

/**
 * The item, when session `sessionId` of `caller` is an agent session of the feature `side` names: the
 * receiving feature for the receiving agent, the originating feature for the originating agent.
 */
async function agentItem(
  deps: CallerActionDeps,
  caller: string,
  sessionId: string,
  itemId: unknown,
  side: "receiving_agent" | "originating_agent",
): Promise<{ readonly item: CallerItem; readonly handle: string } | CallerRejection> {
  const live = deps.heartbeat(caller, sessionId);
  if (live.status === "rejected") return rejected(live.reason === "offline" ? "offline" : live.reason === "not_found" ? "not_found" : "forbidden", live.message);
  const item = await findItem(deps, itemId);
  if (isRejection(item)) return item;
  const feature = side === "receiving_agent" ? item.feature : item.origin;
  if (deps.features.get(feature)?.personId !== caller || deps.features.featureOfSession(sessionId) !== feature) {
    const role = side === "receiving_agent" ? `the receiving worktree, feature ${feature}` : `the originating feature, ${feature}`;
    return rejected("forbidden", `only an agent session of ${role}, answers this step of item ${item.itemId}`);
  }
  return { item, handle: live.session.handle };
}

/** Refuses an action the item's state does not allow, naming where it stands and who acts next. */
function stateRefusal(item: CallerItem, action: CallerItemAction): CallerRejection | undefined {
  const from = CALLER_ACTION_FROM[action] ?? [];
  if (item.ownerAsked !== null && CALLER_ACTION_BY[action] === "receiving_agent") {
    return rejected("conflict", `item ${item.itemId} is with the worktree owner (${item.ownerAsked.replaceAll("_", " ")}); the owner decides it on the dashboard`);
  }
  if (!from.includes(item.state)) {
    return rejected("conflict", `item ${item.itemId} is ${item.state.replaceAll("_", " ")}, waiting on the ${callerWaitingOn(item).replaceAll("_", " ")}; ${action.replaceAll("_", " ")} starts from ${from.map((state) => state.replaceAll("_", " ")).join(", ")}`);
  }
  return undefined;
}

/**
 * One call of a caller tool by `caller`'s session `sessionId`. `confirm` and `review` are the receiving
 * branch's agent's; `propose_fix` and `explain` the originating agent's. Each is refused for any other
 * session, for an item in another state and for text over its limit. Every transition is signed.
 */
export async function callerAction(deps: CallerActionDeps, caller: string, sessionId: string, call: CallerCall): Promise<CallerOutcome> {
  switch (call.action) {
    case "confirm": {
      const found = await agentItem(deps, caller, sessionId, call.item, "receiving_agent");
      if (isRejection(found)) return found;
      const { item, handle } = found;
      const refusal = stateRefusal(item, "confirm");
      if (refusal !== undefined) return refusal;
      // The confirmation names the run it read: one of the item's, which replayed every caller, each call matching.
      if (typeof call.run !== "string" || !RUN_ID.test(call.run)) return rejected("invalid", "run must be the replay run id you read, `replay-` and 20 hexadecimal digits");
      const run = call.run;
      if (!item.runs.some((each) => each.runId === run) || item.callers.some((caller) => caller.runId !== run)) {
        return refuse(deps, item, "run_not_on_item", handle, `run ${run} is not the replay run of item ${item.itemId}; cite the run in its packet's runs`);
      }
      const unmatched = item.callers.filter((caller) => caller.verdict !== "unaffected" || caller.matched !== caller.calls || caller.differingCount > 0);
      if (unmatched.length > 0) {
        return refuse(deps, item, "run_not_matched", handle, `run ${run} has calls that did not match at ${unmatched.map((caller) => `${caller.path}:${caller.line}`).join(", ")}`);
      }
      const ownerAsked = ownerAfter(await deps.stage(), "confirmed", item.rejections);
      return done(await transition(deps, item, { ...item, state: "confirmed", ownerAsked }, "confirm", handle, { run_id: run }));
    }
    case "propose_fix": {
      const found = await agentItem(deps, caller, sessionId, call.item, "originating_agent");
      if (isRejection(found)) return found;
      const { item, handle } = found;
      const refusal = stateRefusal(item, "propose_fix");
      if (refusal !== undefined) return refusal;
      const note = boundedText(call.note, "the note", false);
      if (isRejection(note)) return note;
      if (typeof call.part !== "string" || typeof call.revision !== "number" || !Number.isInteger(call.revision)) {
        return rejected("invalid", "name the plan part and its revision that carry the fix");
      }
      const plan = await deps.plan(item.origin);
      const part = plan?.parts.find((each) => each.partId === call.part);
      if (part === undefined) return rejected("not_found", `the newest plan of feature ${item.origin} has no part ${String(call.part).slice(0, 128)}`);
      if (part.place.kind !== "feature" || part.place.feature !== item.feature) {
        return rejected("invalid", `part ${part.partId} is not placed on feature ${item.feature}, the worktree whose callers break`);
      }
      if (part.kind === "verify") return rejected("invalid", `part ${part.partId} is a verify part: it carries no fix to propose`);
      if (part.revision !== call.revision) return rejected("conflict", `part ${part.partId} stands at revision ${part.revision}; propose that revision`);
      // A revision already in the fork did not fix these callers: the agent revises the part first.
      if (deps.written?.(part.partId, part.revision) === true) {
        return rejected("conflict", `revision ${part.revision} of part ${part.partId} is already written into feature ${item.feature}'s fork; revise the part and propose the new revision`);
      }
      const state: CallerItemState = "fix_proposed";
      const fix = { partId: part.partId, revision: part.revision, note, by: handle, at: iso(deps) };
      const ownerAsked = ownerAfter(await deps.stage(), state, item.rejections);
      return done(await transition(deps, item, { ...item, state, fix, review: null, ownerAsked }, "propose_fix", handle, { part_id: part.partId, revision: part.revision, note }));
    }
    case "explain": {
      const found = await agentItem(deps, caller, sessionId, call.item, "originating_agent");
      if (isRejection(found)) return found;
      const { item, handle } = found;
      const refusal = stateRefusal(item, "explain");
      if (refusal !== undefined) return refusal;
      const kind = call.kind;
      if (kind !== "expected" && kind !== "revising") return rejected("invalid", "kind must be expected or revising");
      const text = boundedText(call.text, "the explanation", true);
      if (isRejection(text)) return text;
      const answers = readAnswers<Omit<CallerCallClass, "callId">, Omit<CallerUnlistedClass, "count">>(item, call.calls, call.unlisted, readKind, (fields) => readKind(fields, "unlisted"));
      if (isRejection(answers)) return answers;
      if (isRefused(answers)) return refuse(deps, item, answers.code, handle, answers.message);
      // An incidental difference is the originating change's to fix: it never goes to the receiving agent.
      const incidental = [...answers.calls.filter((each) => each.kind === "incidental").map((each) => each.callId), ...(answers.unlisted?.kind === "incidental" ? ["the unlisted calls"] : [])];
      if (kind === "expected" && incidental.length > 0) {
        return refuse(deps, item, "incidental_to_review", handle, `an incidental difference cannot go to review (${incidental.join(", ")}); revise your change and call explain_difference with kind revising`);
      }
      const explanation: CallerItem["explanation"] = { kind, text, calls: answers.calls, unlisted: answers.unlisted, by: handle, at: iso(deps) };
      const explained = await transition(deps, item, { ...item, state: "explained", explanation, review: null, ownerAsked: null }, "explain", handle, {
        kind,
        text,
        calls: answers.calls.map(({ callId, kind: callKind, reason }) => ({ call_id: callId, kind: callKind, reason })),
        unlisted: answers.unlisted,
      });
      if (isRejection(explained) || kind === "revising") return done(explained);
      // An expected difference goes to the receiving agent for review at once.
      const ownerAsked = ownerAfter(await deps.stage(), "review_requested", explained.rejections);
      const requested = await transition(deps, explained, { ...explained, state: "review_requested", ownerAsked }, "request_review", handle);
      return done(requested, [explained.recordId]);
    }
    case "review": {
      const found = await agentItem(deps, caller, sessionId, call.item, "receiving_agent");
      if (isRejection(found)) return found;
      const { item, handle } = found;
      const verdict = call.verdict;
      if (verdict !== "approve" && verdict !== "request_changes") return rejected("invalid", "verdict must be approve or request_changes");
      const text = boundedText(call.text, "the note", verdict === "request_changes");
      if (isRejection(text)) return text;
      const fixing = item.state === "fix_proposed";
      const action: CallerItemAction = fixing ? (verdict === "approve" ? "approve_fix" : "reject_fix") : verdict === "approve" ? "approve" : "request_changes";
      const refusal = stateRefusal(item, action);
      if (refusal !== undefined) return refusal;
      const answers = readAnswers<Omit<CallerCallVerdict, "callId">, Omit<CallerUnlistedVerdict, "count">>(item, call.calls, call.unlisted, readVerdict, (fields) => readVerdict(fields, "unlisted"));
      if (isRejection(answers)) return answers;
      if (isRefused(answers)) return refuse(deps, item, answers.code, handle, answers.message);
      const given = [...answers.calls, ...(answers.unlisted === null ? [] : [answers.unlisted])];
      if (verdict === "approve" && given.some((each) => each.verdict !== "approve")) return rejected("invalid", "an approval approves every differing call; request changes instead");
      const cited = [
        ...answers.calls.map((each, index) => ({ at: `calls[${index}]`, evidence: each.evidence })),
        ...(answers.unlisted === null ? [] : [{ at: "unlisted", evidence: answers.unlisted.evidence }]),
      ];
      const unreal = await evidenceRefusal(deps, item, cited);
      if (isRejection(unreal)) return unreal;
      if (unreal !== undefined) return refuse(deps, item, unreal.code, handle, unreal.message);
      const rejections = item.rejections + (verdict === "approve" ? 0 : 1);
      const state: CallerItemState = fixing ? (verdict === "approve" ? "fix_approved" : "fix_rejected") : verdict === "approve" ? "approved" : "changes_requested";
      const review: CallerItem["review"] = { verdict, text, calls: answers.calls, unlisted: answers.unlisted, by: handle, at: iso(deps) };
      const ownerAsked = ownerAfter(await deps.stage(), state, rejections);
      const fields = {
        verdict_given: verdict,
        text,
        calls: answers.calls.map(({ callId, verdict: callVerdict, evidence }) => ({ call_id: callId, verdict: callVerdict, evidence })),
        unlisted: answers.unlisted,
        ...(fixing && item.fix !== null ? { part_id: item.fix.partId, revision: item.fix.revision } : {}),
      };
      return done(await transition(deps, item, { ...item, state, review, rejections, ownerAsked }, action, handle, fields));
    }
    default:
      return rejected("invalid", "the action must be confirm, propose_fix, explain or review");
  }
}

function done(kept: CallerItem | CallerRejection, earlier: readonly string[] = []): CallerOutcome {
  return isRejection(kept) ? kept : { status: "ok", item: kept, recordIds: [...earlier, kept.recordId] };
}

export interface CallerOwnerInput {
  readonly item: unknown;
  readonly verdict: unknown;
  readonly text?: unknown;
}

/**
 * The worktree owner, or their delegate, decides an item sent to them on the dashboard: `approve`
 * settles it on its path, `request_changes` returns it to the originating agent.
 */
export async function ownerDecision(deps: CallerItemDeps & { readonly delegates: () => Promise<Delegates> }, person: string, input: CallerOwnerInput): Promise<CallerOutcome> {
  const item = await findItem(deps, input.item);
  if (isRejection(item)) return item;
  const owner = deps.features.get(item.feature)?.personId;
  if (owner === undefined) return rejected("not_found", `no feature ${item.feature}`);
  if (person !== owner && (await deps.delegates()).get(owner) !== person) return rejected("forbidden", `only ${owner}, who owns the worktree, or their delegate decides item ${item.itemId}`);
  if (callerWaitingOn(item) !== "worktree_owner") return rejected("conflict", `item ${item.itemId} is not sent to the worktree owner; it waits on the ${callerWaitingOn(item).replaceAll("_", " ")}`);
  if (input.verdict !== "approve" && input.verdict !== "request_changes") return rejected("invalid", "verdict must be approve or request_changes");
  const action: CallerItemAction = input.verdict === "approve" ? "owner_approve" : "owner_request_changes";
  const refusal = stateRefusal({ ...item, ownerAsked: null }, action);
  if (refusal !== undefined) return refusal;
  const text = boundedText(input.text, "the note", false);
  if (isRejection(text)) return text;
  const approve = input.verdict === "approve";
  const state = approve ? ownerApproved(item.state) : ownerRequestedChanges(item.state);
  const rejections = item.rejections + (approve ? 0 : 1);
  const review = { verdict: input.verdict, text, by: person, at: iso(deps) } as const;
  return done(await transition(deps, item, { ...item, state, review, rejections, ownerAsked: null }, action, person, { verdict_given: input.verdict, text, asked_for: item.ownerAsked }));
}

/** A fix the receiving side approved was written into its fork: the items it answers are `written`. */
export async function fixWritten(deps: CallerItemDeps, originId: string, partId: string, revision: number): Promise<CallerItem[]> {
  const written: CallerItem[] = [];
  for (const item of await deps.keeper(originId).callerItems(originId)) {
    if (item.state !== "fix_approved" || item.ownerAsked !== null || item.fix?.partId !== partId || item.fix.revision !== revision) continue;
    const kept = await transition(deps, item, { ...item, state: "written" }, "write", "penguin", { part_id: partId, revision });
    if (!isRejection(kept)) written.push(kept);
  }
  return written;
}

/**
 * Sends to the worktree owner each item that has waited on the receiving agent longer than the stage's
 * wait. Reads that show items call it first, so no timer is needed.
 */
export async function sweepUnanswered(deps: CallerItemDeps): Promise<CallerItem[]> {
  const stage = await deps.stage();
  const now = (deps.now ?? Date.now)();
  const cutoff = now - CALLER_STAGES[stage].waitHours * 3_600_000;
  const asked: CallerItem[] = [];
  for (const origin of deps.index.waitingSince(cutoff)) {
    for (const item of await deps.keeper(origin).callerItems(origin)) {
      if (callerWaitingOn(item) !== "receiving_agent" || Date.parse(item.updatedAt) >= cutoff) continue;
      const kept = await transition(deps, item, { ...item, ownerAsked: "unanswered" }, "ask_owner", "penguin", { stage, wait_hours: CALLER_STAGES[stage].waitHours });
      if (!isRejection(kept)) asked.push(kept);
    }
  }
  return asked;
}

/** The items of `originId` whose receiving feature still runs. */
async function liveItems(deps: CallerItemDeps, originId: string): Promise<CallerItem[]> {
  return (await deps.keeper(originId).callerItems(originId)).filter((item) => {
    const target = deps.features.get(item.feature);
    return target !== undefined && RUNNING_STATES.has(target.state);
  });
}

const itemLine = (item: CallerItem): string => `${item.feature} ${item.contract} (${item.state.replaceAll("_", " ")}${item.ownerAsked === null ? "" : ", with the worktree owner"})`;

/** Each item that keeps the originating feature from landing, as one line; empty when none does. */
export async function landPending(deps: CallerItemDeps, originId: string): Promise<string[]> {
  return (await liveItems(deps, originId)).filter((item) => !callerItemSettled(item, "land")).map(itemLine);
}

/**
 * Why a write of the originating feature's fix into `targetId`'s fork waits for the receiving side, or
 * null when every item there is approved from that side. A feature with no item on the fork writes as before.
 */
export async function writeWaits(deps: Pick<CallerItemDeps, "keeper">, originId: string, targetId: string): Promise<string | null> {
  const open = (await deps.keeper(originId).callerItems(originId)).filter((item) => item.feature === targetId && !callerItemSettled(item, "write"));
  if (open.length === 0) return null;
  return `the receiving worktree has not approved it yet: ${open.map(itemLine).join("; ")}`;
}

/** The items a feature page shows: those the feature's replays opened, then those on its own fork. */
export async function featureCallerItems(deps: CallerItemDeps, featureId: string): Promise<CallerItemView[]> {
  const own = await deps.keeper(featureId).callerItems(featureId);
  const incoming = (await Promise.all(deps.index.originsOn([featureId]).filter((origin) => origin !== featureId).map(async (origin) => deps.keeper(origin).callerItems(origin))))
    .flat()
    .filter((item) => item.feature === featureId);
  return [...own, ...incoming].filter((item) => item.state !== "withdrawn").map((item) => viewOf(deps, item));
}

function viewOf(deps: Pick<CallerItemDeps, "features">, item: CallerItem): CallerItemView {
  const person = (id: string) => deps.features.get(id)?.personId ?? "unknown";
  return callerItemView(item, { origin: person(item.origin), feature: person(item.feature) });
}

/**
 * The items on the running features of `person`, and of each person who named them delegate, that the
 * stage shows them: `decide` for every item sent to the worktree owner, `told` for each open `broken` or
 * `differs` item when the stage tells the owner.
 */
export async function ownerCallerItems(deps: CallerItemDeps, person: string, delegates: Delegates): Promise<CallerItemRequest[]> {
  const people = new Set([person, ...[...delegates].flatMap(([owner, delegate]) => (delegate === person ? [owner] : []))]);
  const targets = deps.features
    .list()
    .filter((feature) => people.has(feature.personId) && RUNNING_STATES.has(feature.state))
    .map((feature) => feature.id);
  const stage = CALLER_STAGES[await deps.stage()];
  const wanted = new Set(targets);
  const requests: CallerItemRequest[] = [];
  for (const origin of deps.index.originsOn(targets)) {
    for (const item of await deps.keeper(origin).callerItems(origin)) {
      if (!wanted.has(item.feature) || item.state === "withdrawn") continue;
      const view = viewOf(deps, item);
      if (view.waitingOn === "worktree_owner") requests.push({ ...view, ask: "decide" });
      else if (stage.told && (item.verdict === "broken" || item.verdict === "differs") && !callerItemSettled(item, "land")) requests.push({ ...view, ask: "told" });
    }
  }
  return requests.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** What get_work gives a session about caller items: one context packet per item, on either side. */
export interface CallerWork {
  /** Items on the session's own worktree, from other features' changes. */
  readonly receiving: readonly CallerPacket[];
  /** Items the session's feature's change opened in other worktrees. */
  readonly originating: readonly CallerPacket[];
}

/** One item with everything an agent needs to answer it. Text another agent or person wrote is under `personWritten`. */
export interface CallerPacket {
  readonly item: string;
  readonly origin: string;
  readonly feature: string;
  readonly contract: string;
  readonly verdict: CallerItem["verdict"];
  readonly state: CallerItemState;
  readonly waitingOn: ReturnType<typeof callerWaitingOn>;
  readonly ownerAsked: CallerOwnerReason | null;
  /** True when this session's side acts next, with the tool it answers with. */
  readonly yourTurn: { readonly tools: readonly string[] } | null;
  readonly rejections: number;
  /** The contract's entries in the originating plan's contract diff; null before a plan. */
  readonly contractDiff: { readonly changes: readonly unknown[]; readonly signatures: readonly unknown[] } | null;
  /** The call sites in the receiving feature's code, with the tests that reached each. */
  readonly callSites: readonly { readonly path: string; readonly line: number; readonly verdict: string; readonly calls: number; readonly matched: number; readonly reason: string; readonly tests: readonly string[] }[];
  /** Each differing call, old and new, with its arguments, result or exception and effects. */
  readonly calls: readonly CallerVerdict["differing"][number][];
  /** Differing calls the replay counted past those listed in `calls`; an explanation or review answers them as one group with this count. */
  readonly unlistedCalls: number;
  /** The replay runs: the commits compared and the test tallies on each tree. */
  readonly runs: CallerItem["runs"];
  readonly fix: { readonly part: string; readonly revision: number; readonly kind: string | null; readonly files: readonly string[] } | null;
  readonly personWritten: {
    readonly explanation: {
      readonly kind: string;
      readonly text: string;
      readonly calls: readonly CallerCallClass[];
      readonly unlisted: CallerUnlistedClass | null;
      readonly by: string;
    } | null;
    readonly fixNote: string | null;
    /** The proposed fix's patch against the receiving fork, as the originating agent submitted it. */
    readonly patch: string | null;
    readonly review: { readonly verdict: string; readonly text: string; readonly calls: readonly CallerCallVerdict[]; readonly unlisted: CallerUnlistedVerdict | null; readonly by: string } | null;
  };
}

const TOOLS_FOR: Readonly<Partial<Record<CallerItemState, readonly string[]>>> = {
  confirmation_requested: ["confirm_caller"],
  fix_proposed: ["review_caller"],
  review_requested: ["review_caller"],
  broken: ["propose_caller_fix"],
  fix_rejected: ["propose_caller_fix"],
  differs: ["explain_difference"],
  explained: ["explain_difference"],
  changes_requested: ["explain_difference"],
  fix_approved: ["fix_token"],
};

function contractEntries(plan: Plan | undefined, contract: string): CallerPacket["contractDiff"] {
  const diff = plan?.facts.contractDiff;
  if (diff == null) return null;
  const covers = (entry: { readonly path: string; readonly symbol: string; readonly contract?: string | null }) =>
    entry.contract === contract || (contract.startsWith(`${entry.path}::`) && `${entry.symbol}`.endsWith(contract.slice(entry.path.length + 2)));
  const changes = diff.changes.filter(covers);
  const symbols = new Set(changes.map((change) => change.symbol));
  return { changes, signatures: diff.signatures.filter((signature) => symbols.has(signature.symbol)) };
}

function packetOf(item: CallerItem, plan: Plan | undefined, side: "receiving_agent" | "originating_agent"): CallerPacket {
  const waitingOn = callerWaitingOn(item);
  const part = item.fix === null ? undefined : plan?.parts.find((each) => each.partId === item.fix?.partId);
  return {
    item: item.itemId,
    origin: item.origin,
    feature: item.feature,
    contract: item.contract,
    verdict: item.verdict,
    state: item.state,
    waitingOn,
    ownerAsked: item.ownerAsked,
    yourTurn: waitingOn === side ? { tools: TOOLS_FOR[item.state] ?? [] } : null,
    rejections: item.rejections,
    contractDiff: contractEntries(plan, item.contract),
    callSites: item.callers.map(({ path, line, verdict, calls, matched, reason, tests }) => ({ path, line, verdict, calls, matched, reason, tests })),
    calls: item.callers.flatMap((caller) => caller.differing),
    unlistedCalls: differingOf(item).unlisted,
    runs: item.runs,
    fix: item.fix === null ? null : { part: item.fix.partId, revision: item.fix.revision, kind: part?.kind ?? null, files: part?.diff.files.map((file) => file.path) ?? [] },
    personWritten: {
      explanation:
        item.explanation === null
          ? null
          : { kind: item.explanation.kind, text: item.explanation.text, calls: item.explanation.calls ?? [], unlisted: item.explanation.unlisted ?? null, by: item.explanation.by },
      fixNote: item.fix?.note ?? null,
      patch: part !== undefined && part.revision === item.fix?.revision ? part.diff.patch : null,
      review: item.review === null ? null : { verdict: item.review.verdict, text: item.review.text, calls: item.review.calls ?? [], unlisted: item.review.unlisted ?? null, by: item.review.by },
    },
  };
}

/**
 * get_work's caller items for `caller`'s session: a packet per open item on the session's feature's
 * own worktree, and per item its feature's change opened. Undefined for a session that is not live or
 * works on no feature.
 */
export async function callerWork(deps: Omit<CallerActionDeps, "testStanding">, caller: string, sessionId: string): Promise<CallerWork | undefined> {
  if (deps.heartbeat(caller, sessionId).status !== "ok") return undefined;
  const featureId = parseFeatureId(deps.features.featureOfSession(sessionId));
  if (featureId === undefined || deps.features.get(featureId)?.personId !== caller) return undefined;
  await sweepUnanswered(deps);
  const plans = new Map<string, Plan | undefined>();
  const planOf = async (origin: string) => {
    if (!plans.has(origin)) plans.set(origin, await deps.plan(origin));
    return plans.get(origin);
  };
  const receiving: CallerPacket[] = [];
  for (const origin of deps.index.originsOn([featureId])) {
    if (origin === featureId) continue;
    for (const item of await deps.keeper(origin).callerItems(origin)) {
      if (item.feature === featureId && item.state !== "withdrawn") receiving.push(packetOf(item, await planOf(origin), "receiving_agent"));
    }
  }
  const originating = (await liveItems(deps, featureId)).filter((item) => item.state !== "withdrawn");
  const plan = originating.length === 0 ? undefined : await planOf(featureId);
  return { receiving, originating: originating.map((item) => packetOf(item, plan, "originating_agent")) };
}
