// Opens a Huddle issue from a combined run that failed tests (PRD sections 4 and 6, Layer 2). Every
// operation comes from a template over the typed combined-run event; nothing here calls a model.
//
// For a published checkpoint whose merge with a dependent owner's latest checkpoint fails tests,
// Penguin writes, as itself:
//
// 1. The Huddle issue: create, DETECTED, the `huddle` label and one `scope:<id>` label per changed
//    and failing scope, the trigger commit, one check per failing test with its fingerprint, and a
//    mention of each owner involved: the trigger's owner and each owner whose test failed. The
//    mention is what puts the Huddle in those owners' inboxes, and nobody else's.
// 2. One fix sub-issue per failing test, labelled with the failing scope, linked to the dependent
//    owner's checkpoint, carrying the same check, and assigned by the default rule (PRD section 14,
//    decision 10) to the session whose test failed: see `fixAssignee`.
// 3. A thread on the Huddle issue when changed paths fall in no scope (PRD section 12), asking the
//    project's owners to assign a scope.
// 4. FIXING, once every sub-issue is open on the Huddle issue. The reducer derives both states from
//    these change_state operations.
//
// Each step first reads the issue and skips what is already there, so an opening interrupted part
// way resumes where it stopped. The Huddle row (huddle-store.ts) is keyed by the trigger commit and
// written before the first operation: a second combined run on the same trigger revision finds it
// and writes no operation at all.

import type { CharterIdentity, IssueRecord } from "@penguin/issues";
import {
  parseCombinedRunEvent,
  PERSON_ID_PATTERN,
  type CombinedRunEvent,
  type CombinedRunFailingTest,
  type Party,
} from "@penguin/protocol";
import type { ScopeMap } from "@penguin/scope-map";

import { ownerCommit, type Huddle, type HuddleStore } from "./huddle-store.ts";
import type { SubmitOutcome } from "./issue-index.ts";
import type { OwnerFork } from "./owner-forks.ts";
import type { Session } from "./session-store.ts";

/** The label every Huddle issue carries. */
export const HUDDLE_LABEL = "huddle";

/** The anchor of the thread that asks the owners to assign a scope to unmapped paths. */
export const UNASSIGNED_IMPACT_ANCHOR = "unassigned-impact";

/** An operation Penguin writes: the fields `submit` takes from a caller. */
export interface HuddleDraft {
  readonly issue: number;
  readonly type: string;
  readonly base_version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface HuddleOpenDeps {
  readonly huddles: HuddleStore;
  readonly scopeMap: ScopeMap;
  issue(issueId: string): IssueRecord | undefined;
  /** Every issue number in the index. */
  issueIds(): readonly string[];
  /** Signs the operation with the service key and applies it, with Penguin as author. */
  submit(operation: HuddleDraft): Promise<SubmitOutcome>;
  ownerFork(ownerId: string): OwnerFork | undefined;
  session(sessionId: string): Pick<Session, "handle"> | undefined;
  identities(): readonly CharterIdentity[];
  /** True when the trigger commit is in its owner's fork: only a published checkpoint opens a Huddle. */
  triggerPublished(event: CombinedRunEvent): Promise<boolean>;
}

export type HuddleOpenOutcome =
  | { readonly status: "opened"; readonly huddle: Huddle; readonly operations: number }
  /** A Huddle for the same trigger already exists; nothing was written. */
  | { readonly status: "existing"; readonly huddle: Huddle }
  /** No dependent scope's tests failed, so there is nothing to open. */
  | { readonly status: "no_failures"; readonly message: string }
  | {
      readonly status: "rejected";
      readonly reason: "invalid" | "unpublished" | "operation_rejected";
      readonly message: string;
    };

/** One failing test, or one failed run whose log named no test, and the sub-issue that fixes it. */
export interface Fix {
  /** `<scope id>::<pytest node id>`, or `<scope id>::` for a failed run that named no test. */
  readonly key: string;
  readonly ownerId: string;
  readonly scopeId: string;
  readonly commandId: string;
  readonly ownerCheckpoint: string;
  readonly fingerprint: string;
  readonly test: CombinedRunFailingTest | null;
}

/** How many times a create retries when another writer took the issue number first. */
const CREATE_ATTEMPTS = 5;
/** Lines of failing tests listed in the Huddle issue's body. */
const BODY_TEST_LINES = 100;
const TITLE_MAX = 256;
const THREAD_NEEDS_MAX = 32;
const LABEL = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/u;
const PERSON = new RegExp(PERSON_ID_PATTERN, "u");

class OpeningRejected extends Error {}

/** The fixes a combined run asks for, in result order, then test order. */
export function fixesOf(event: CombinedRunEvent): Fix[] {
  return event.results.flatMap((result): Fix[] => {
    if (result.status !== "failed" || result.fingerprint === null || result.ownerCheckpoint === null) return [];
    const base = {
      ownerId: result.ownerId,
      scopeId: result.scopeId,
      commandId: result.commandId,
      ownerCheckpoint: result.ownerCheckpoint,
      fingerprint: result.fingerprint.id,
    };
    if (result.failingTests.length === 0) return [{ ...base, key: `${result.scopeId}::`, test: null }];
    return result.failingTests.map((test) => ({ ...base, key: `${result.scopeId}::${test.nodeId}`, test }));
  });
}

/**
 * The default assignee of a fix: the session whose test failed. That is the session that reported
 * the dependent owner's checkpoint, when the fork's latest checkpoint is the one tested. Otherwise
 * it is the owner's first identity, by handle, whose charter holds the failing scope, and failing
 * that the owner in person.
 */
export function fixAssignee(fix: Fix, deps: Pick<HuddleOpenDeps, "ownerFork" | "session" | "identities">): Party {
  const fork = deps.ownerFork(fix.ownerId);
  if (fork?.latestCheckpointSha === fix.ownerCheckpoint && fork.reportedBySession !== null) {
    const handle = deps.session(fork.reportedBySession)?.handle;
    if (handle?.startsWith(`@${fix.ownerId}/`)) return { identity: handle };
  }
  const [chartered] = deps
    .identities()
    .filter((identity) => identity.ownerId === fix.ownerId && identity.charterScopes.includes(fix.scopeId))
    .map((identity) => identity.handle)
    .sort();
  return chartered === undefined ? { person: fix.ownerId } : { identity: chartered };
}

/**
 * Opens the Huddle issue for a combined-run event, or resumes an opening that stopped part way. The
 * caller runs one opening at a time.
 */
export async function openHuddle(deps: HuddleOpenDeps, input: unknown): Promise<HuddleOpenOutcome> {
  const parsed = parseCombinedRunEvent(input);
  if (!parsed.ok) {
    const message = parsed.issues.map((issue) => `${issue.field || "/"} ${issue.message}`).join("; ");
    return { status: "rejected", reason: "invalid", message };
  }
  const { trigger } = parsed.event;
  let huddle = deps.huddles.get(ownerCommit(trigger.ownerId, trigger.sha));
  if (huddle?.status === "open") return { status: "existing", huddle };
  if (huddle === undefined) {
    if (fixesOf(parsed.event).length === 0) {
      return { status: "no_failures", message: "no dependent scope's tests failed" };
    }
    if (!(await deps.triggerPublished(parsed.event))) {
      const message = `${ownerCommit(trigger.ownerId, trigger.sha)} is not a checkpoint published to that fork`;
      return { status: "rejected", reason: "unpublished", message };
    }
    huddle = deps.huddles.begin(parsed.event);
  }
  // A resumed opening follows the event that began it, never a later one.
  const opening = new Opening(deps, huddle);
  try {
    await opening.run();
  } catch (error) {
    if (!(error instanceof OpeningRejected)) throw error;
    return { status: "rejected", reason: "operation_rejected", message: error.message };
  }
  deps.huddles.markOpen(huddle.triggerCommit);
  return { status: "opened", huddle: deps.huddles.get(huddle.triggerCommit) as Huddle, operations: opening.written };
}

/** One run of the opening steps for one Huddle. */
class Opening {
  readonly #deps: HuddleOpenDeps;
  readonly #huddle: Huddle;
  readonly #event: CombinedRunEvent;
  readonly #fixes: Fix[];
  readonly #trigger: string;
  /** Operations this run wrote. */
  written = 0;

  constructor(deps: HuddleOpenDeps, huddle: Huddle) {
    this.#deps = deps;
    this.#huddle = huddle;
    this.#event = huddle.event;
    this.#fixes = fixesOf(huddle.event);
    this.#trigger = huddle.triggerCommit;
  }

  async run(): Promise<void> {
    const deps = this.#deps;
    let issueId = this.#huddle.issueId;
    if (issueId === null) {
      issueId = await this.#create(huddleTitle(this.#event, this.#fixes), huddleBody(this.#event, this.#fixes));
      deps.huddles.setIssue(this.#trigger, issueId);
    }
    const id = issueId;
    await this.#ensure(id, (issue) => issue.state !== "open", "change_state", {
      state: "detected",
      reason: "Combined tests fail on a published checkpoint.",
    });
    for (const label of this.#labels()) {
      await this.#ensure(id, (issue) => issue.labels.includes(label), "add_label", { label });
    }
    const { repo, sha } = splitCommit(this.#trigger);
    await this.#ensure(
      id,
      (issue) => [...issue.linkedCommits.values()].some((l) => l.kind === "trigger" && l.repo === repo && l.sha === sha),
      "link_commit",
      { commit: this.#trigger, kind: "trigger" },
    );
    for (const fix of this.#fixes) await this.#ensureCheck(id, fix);
    for (const person of this.#involvedOwners()) {
      await this.#ensure(
        id,
        (issue) => [...issue.mentions.values()].some((m) => m.mentionedKind === "person" && m.mentionedId === person),
        "mention",
        { mentioned: { person } },
      );
    }
    for (const fix of this.#fixes) {
      const subId = await this.#openFix(id, fix);
      await this.#ensure(id, (issue) => issue.subIssues.has(subId), "open_sub_issue", { sub_issue: Number(subId) });
    }
    if (this.#event.unmapped.length > 0) await this.#ensureUnassignedThread(id);
    await this.#ensure(id, (issue) => issue.state !== "detected", "change_state", {
      state: "fixing",
      reason: `${this.#fixes.length} fix sub-issue${this.#fixes.length === 1 ? "" : "s"} opened.`,
    });
  }

  /** Opens, or finds, the fix sub-issue for `fix` and makes sure it carries its label, evidence and assignee. */
  async #openFix(huddleId: string, fix: Fix): Promise<string> {
    const deps = this.#deps;
    let subId = deps.huddles.fix(this.#trigger, fix.key);
    if (subId === undefined) {
      subId = await this.#create(fixTitle(this.#event, fix), fixBody(this.#trigger, huddleId, fix));
      deps.huddles.setFix(this.#trigger, fix.key, subId);
    }
    const id = subId;
    const label = `scope:${fix.scopeId}`;
    if (LABEL.test(label)) await this.#ensure(id, (issue) => issue.labels.includes(label), "add_label", { label });
    const base = ownerCommit(fix.ownerId, fix.ownerCheckpoint);
    await this.#ensure(
      id,
      (issue) => [...issue.linkedCommits.values()].some((l) => `${l.repo}@${l.sha}` === base && l.kind === "related"),
      "link_commit",
      { commit: base, kind: "related" },
    );
    await this.#ensureCheck(id, fix);
    const assignee = fixAssignee(fix, deps);
    const key = "identity" in assignee ? `identity:${assignee.identity}` : `person:${assignee.person}`;
    await this.#ensure(id, (issue) => issue.assignments.has(key), "assign", { assignee });
    return id;
  }

  #ensureCheck(issueId: string, fix: Fix): Promise<void> {
    const test = fix.test?.testId ?? null;
    return this.#ensure(
      issueId,
      (issue) =>
        [...issue.checks.values()].some(
          (c) => c.commandId === fix.commandId && c.test === test && c.fingerprint === fix.fingerprint,
        ),
      "attach_check",
      {
        command_id: fix.commandId,
        commit: this.#trigger,
        ...(test === null ? {} : { test }),
        result: "fail",
        fingerprint: fix.fingerprint,
      },
    );
  }

  #ensureUnassignedThread(issueId: string): Promise<void> {
    const owners = [...new Set([...this.#deps.scopeMap.scopes.values()].map((scope) => scope.ownerId))]
      .filter((owner) => PERSON.test(owner))
      .sort()
      .slice(0, THREAD_NEEDS_MAX);
    const paths = this.#event.unmapped;
    const listed = paths.slice(0, BODY_TEST_LINES).map((path) => `- ${path}`);
    if (paths.length > listed.length) listed.push(`- and ${paths.length - listed.length} more`);
    const body = [
      `The trigger changes ${paths.length === 1 ? "a file" : "files"} that no scope in penguin/scopes.json maps, ` +
        "so no owner's tests cover the impact. Assign each to a scope:",
      "",
      ...listed,
    ].join("\n");
    return this.#ensure(
      issueId,
      (issue) => [...issue.threads.values()].some((thread) => thread.anchor === UNASSIGNED_IMPACT_ANCHOR),
      "open_thread",
      { body, anchor: UNASSIGNED_IMPACT_ANCHOR, ...(owners.length === 0 ? {} : { needs: owners }) },
    );
  }

  /** Scope labels for the changed scopes and the failing ones, after `huddle`. */
  #labels(): string[] {
    const scopes = new Set([...this.#event.changedScopes, ...this.#fixes.map((fix) => fix.scopeId)]);
    const labels = [...scopes].sort().map((scope) => `scope:${scope}`);
    return [HUDDLE_LABEL, ...labels.filter((label) => LABEL.test(label))];
  }

  /** The trigger's owner and each owner whose test failed. */
  #involvedOwners(): string[] {
    return [...new Set([this.#event.trigger.ownerId, ...this.#fixes.map((fix) => fix.ownerId)])].sort();
  }

  /** Creates an issue under the next free number, retrying when another writer took it first. */
  async #create(title: string, body: string): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      const number = Math.max(0, ...this.#deps.issueIds().map(Number).filter(Number.isSafeInteger)) + 1;
      const outcome = await this.#submit({ issue: number, type: "create", base_version: 0, payload: { title, body } });
      if (outcome.status === "applied") return outcome.issueId;
      // A create on a taken number fails as superseded (base version 0 is behind) or as issue_exists.
      const taken = this.#deps.issue(String(number)) !== undefined;
      if (!taken || attempt === CREATE_ATTEMPTS) {
        throw new OpeningRejected(`create was rejected: ${outcome.reason}: ${outcome.message}`);
      }
    }
  }

  /** Writes the operation unless `present` finds its effect on the issue already. */
  async #ensure(
    issueId: string,
    present: (issue: IssueRecord) => boolean,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const issue = this.#deps.issue(issueId);
    if (issue === undefined) throw new OpeningRejected(`issue ${issueId} is missing from the index`);
    if (present(issue)) return;
    const outcome = await this.#submit({ issue: Number(issueId), type, base_version: issue.version, payload });
    if (outcome.status === "rejected") {
      throw new OpeningRejected(`${type} on #${issueId} was rejected: ${outcome.reason}: ${outcome.message}`);
    }
  }

  async #submit(draft: HuddleDraft): Promise<SubmitOutcome> {
    const outcome = await this.#deps.submit(draft);
    if (outcome.status === "applied") this.written += 1;
    return outcome;
  }
}

function huddleTitle(event: CombinedRunEvent, fixes: readonly Fix[]): string {
  const changed = event.changedScopes.length === 0 ? "A checkpoint" : `${joinAnd(event.changedScopes)} change`;
  return clip(`${changed} breaks ${joinAnd([...new Set(fixes.map((fix) => fix.scopeId))])}`, TITLE_MAX);
}

function huddleBody(event: CombinedRunEvent, fixes: readonly Fix[]): string {
  const { ownerId, sha } = event.trigger;
  const scopes = event.changedScopes.length === 0 ? "the changed scopes" : joinAnd(event.changedScopes);
  const lines = fixes.slice(0, BODY_TEST_LINES).map(
    (fix) =>
      `- ${fix.scopeId}: ${fix.test?.testId ?? fix.commandId} on ${ownerCommit(fix.ownerId, short(fix.ownerCheckpoint))}` +
      ` (fingerprint ${short(fix.fingerprint)})`,
  );
  if (fixes.length > lines.length) lines.push(`- and ${fixes.length - lines.length} more`);
  return [
    `Combined tests fail when ${ownerCommit(ownerId, short(sha))}, a checkpoint of ${ownerId}, is merged with the ` +
      `latest checkpoints of the scopes that depend on ${scopes}.`,
    "",
    "Failing tests:",
    ...lines,
  ].join("\n");
}

function fixTitle(event: CombinedRunEvent, fix: Fix): string {
  const changed = event.changedScopes.length === 0 ? "the trigger" : `the ${joinAnd(event.changedScopes)} change`;
  return clip(`Fix ${fix.test?.testId ?? fix.commandId} after ${changed}`, TITLE_MAX);
}

function fixBody(trigger: string, huddleId: string, fix: Fix): string {
  const test = fix.test === null ? `\`${fix.commandId}\`` : `${fix.scopeId} test ${fix.test.nodeId}`;
  return [
    `${test} fails when ${trigger} is merged with ${ownerCommit(fix.ownerId, fix.ownerCheckpoint)}.`,
    "",
    `Command: ${fix.commandId}`,
    `Fingerprint: ${fix.fingerprint}`,
    `Huddle: #${huddleId}`,
  ].join("\n");
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function splitCommit(commit: string): { repo: string; sha: string } {
  const at = commit.indexOf("@");
  return { repo: commit.slice(0, at), sha: commit.slice(at + 1) };
}
