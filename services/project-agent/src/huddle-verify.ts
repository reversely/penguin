// Verification of a Huddle's fixes (PRD sections 4, 6 and 12, Layer 2). Every operation comes from a
// template over typed events; nothing here calls a model.
//
// When a newer checkpoint of an owner in the Huddle arrives, Penguin schedules one run that merges
// the latest checkpoint of every owner in the Huddle onto the Huddle repo's `integration` branch and
// runs every affected scope's tests there (verification-store.ts). On the Huddle issue it links the
// new checkpoint, marking every current check superseded in the same operation, and moves the issue
// to VERIFYING. A newer checkpoint before the report supersedes the pending run, and a report for a
// superseded run never counts.
//
// The runner's report becomes one check per command, or per failing test, on the integration
// revision, with its fingerprint. The issue moves to IN_REVIEW when every command passes and back to
// FIXING otherwise: a clean Git merge whose tests fail keeps the issue out of review.
//
// The ProjectAgent keeps the Huddle record and the issue index; each Huddle's HuddleAgent runs these
// steps over its own runs and writes its operations back through the ProjectAgent, which signs and
// validates them (PRD section 5). The steps below take one Huddle; `huddlesOf` picks the Huddles a
// checkpoint concerns.

import type { IssueRecord } from "@penguin/issues";
import {
  COMMAND_ID_PATTERN,
  huddleRepoName,
  parseVerificationReport,
  type VerificationCheckpoint,
  type VerificationCommand,
  type VerificationReport,
  type VerificationRunSpec,
} from "@penguin/protocol";

import type { HuddleDraft } from "./huddle-open.ts";
import type { HuddleClosePort } from "./huddle-close.ts";
import { ownerCommit, type Huddle } from "./huddle-store.ts";
import type { SubmitOutcome } from "./issue-index.ts";
import type { OwnerFork } from "./owner-forks.ts";
import { sameCheckpoints, type VerificationRun, type VerificationStore } from "./verification-store.ts";

/**
 * What a HuddleAgent reads and writes through the ProjectAgent, which holds the issue index, the
 * owner forks and the service key. Over Durable Object RPC each call answers with a promise.
 */
export interface HuddleProjectPort {
  issue(issueId: string): IssueRecord | undefined | Promise<IssueRecord | undefined>;
  /** Signs the operation with the service key and applies it, with Penguin as author. */
  submit(operation: HuddleDraft): Promise<SubmitOutcome>;
  ownerFork(ownerId: string): OwnerFork | undefined | Promise<OwnerFork | undefined>;
}

/** One Huddle's runs, kept by its HuddleAgent, and the ProjectAgent's side. */
export interface HuddleVerifyDeps extends HuddleProjectPort {
  readonly runs: VerificationStore;
}

/**
 * The verification steps a HuddleAgent answers over RPC for its one Huddle. The ProjectAgent passes
 * the Huddle record and, for steps that write, the port back to itself. A step goes on to collect
 * reviews (huddle-reviews.ts) or evaluate the close (huddle-close.ts), so its port is the close port.
 */
export interface HuddleVerifier {
  scheduleVerification(huddle: Huddle, project: HuddleClosePort): Promise<VerificationScheduleOutcome | undefined>;
  pendingVerifications(huddle: Huddle): PendingVerification[] | Promise<PendingVerification[]>;
  reportVerification(
    huddle: Huddle,
    runId: string,
    runnerId: string,
    report: unknown,
    project: HuddleClosePort,
  ): Promise<VerificationOutcome>;
}

/** A pending run as the runner lists it, with when it was scheduled. */
export interface PendingVerification {
  readonly spec: VerificationRunSpec;
  readonly createdAt: string;
}

export type VerificationScheduleOutcome =
  /** A run is pending for the Huddle's latest checkpoints. */
  | { readonly status: "scheduled"; readonly issueId: string; readonly runId: string }
  /** No owner in the Huddle has a checkpoint newer than the ones already tested. */
  | { readonly status: "unchanged"; readonly issueId: string }
  | { readonly status: "rejected"; readonly issueId: string; readonly message: string };

export type VerificationOutcome =
  | {
      readonly status: "recorded";
      readonly issueId: string;
      readonly state: IssueRecord["state"];
      /** The revision the checks apply to, `huddle-<id>@<sha>`, or the conflicting checkpoint. */
      readonly commit: string;
    }
  /** The run was reported before; nothing was written. */
  | { readonly status: "existing"; readonly issueId: string }
  /** A newer checkpoint superseded the run, so its results never count. */
  | { readonly status: "superseded"; readonly message: string }
  | {
      readonly status: "rejected";
      readonly reason: "invalid" | "not_found" | "operation_rejected";
      readonly message: string;
    };

/** The merge order and commands of a run for the Huddle's current checkpoints. */
export interface VerificationPlan {
  readonly checkpoints: readonly VerificationCheckpoint[];
  readonly commands: readonly VerificationCommand[];
}

const COMMAND_ID = new RegExp(`^${COMMAND_ID_PATTERN}$`, "u");
/** Failing tests named in a state reason. */
const REASON_TESTS = 10;
const REASON_MAX = 2_000;

class VerificationRejected extends Error {}

/**
 * The owners in a Huddle, trigger owner first: whose checkpoints a run merges. Each owner's latest
 * checkpoint comes from `checkpointOf`; an owner with none is left out.
 */
function checkpointsOf(huddle: Huddle, checkpointOf: (ownerId: string) => string | null): VerificationCheckpoint[] {
  const { trigger, results } = huddle.event;
  const others = [...new Set(results.map((result) => result.ownerId))].filter((owner) => owner !== trigger.ownerId);
  return [trigger.ownerId, ...others.sort()].flatMap((ownerId) => {
    const sha = checkpointOf(ownerId);
    return sha === null ? [] : [{ ownerId, repo: `owner-${ownerId}`, sha }];
  });
}

/** The checkpoints the Huddle opened on: the trigger and each dependent owner's tested checkpoint. */
export function initialCheckpoints(huddle: Huddle): VerificationCheckpoint[] {
  const { trigger, results } = huddle.event;
  const tested = new Map(results.map((result) => [result.ownerId, result.ownerCheckpoint]));
  return checkpointsOf(huddle, (ownerId) => (ownerId === trigger.ownerId ? trigger.sha : tested.get(ownerId) ?? null));
}

/**
 * A run for the Huddle's current checkpoints: every owner's latest reported checkpoint, else the one
 * the Huddle opened on, and a test command for every scope the trigger changed or that depends on it.
 */
export function verificationPlan(huddle: Huddle, ownerFork: (ownerId: string) => OwnerFork | undefined): VerificationPlan {
  const initial = new Map(initialCheckpoints(huddle).map((checkpoint) => [checkpoint.ownerId, checkpoint.sha]));
  const checkpoints = checkpointsOf(
    huddle,
    (ownerId) => ownerFork(ownerId)?.latestCheckpointSha ?? initial.get(ownerId) ?? null,
  );
  const commandOf = new Map<string, string>(huddle.event.changedScopes.map((scope) => [scope, `test:${scope}`]));
  for (const result of huddle.event.results) commandOf.set(result.scopeId, result.commandId);
  const commands = [...commandOf]
    .filter(([, commandId]) => COMMAND_ID.test(commandId) && commandId.length <= 64)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([scopeId, commandId]) => ({ scopeId, commandId }));
  return { checkpoints, commands };
}

/**
 * The open Huddles that `ownerId` takes part in, or every open Huddle when `ownerId` is undefined: the
 * Huddles a checkpoint of that owner schedules a run for, one Huddle step at a time.
 */
export function huddlesOf(open: readonly Huddle[], ownerId?: string): Huddle[] {
  return open.filter((huddle) => ownerId === undefined || ownersOf(huddle).includes(ownerId));
}

/** The trigger's owner and each owner whose test failed. */
function ownersOf(huddle: Huddle): string[] {
  return [huddle.triggerOwner, ...huddle.event.results.map((result) => result.ownerId)];
}

/**
 * Schedules a run when an owner in the Huddle has a checkpoint newer than the ones the Huddle opened
 * on and the last run tested. Undefined when the Huddle's issue is still opening or is closed.
 */
export async function scheduleVerification(deps: HuddleVerifyDeps, huddle: Huddle): Promise<VerificationScheduleOutcome | undefined> {
  const issueId = huddle.issueId;
  const issue = issueId === null ? undefined : await deps.issue(issueId);
  if (issueId === null || issue === undefined || !["fixing", "verifying", "in_review"].includes(issue.state)) {
    return undefined;
  }
  // Each owner's fork is read once, up front, since every read may cross to the ProjectAgent.
  const forks = new Map(
    await Promise.all([...new Set(ownersOf(huddle))].map(async (ownerId) => [ownerId, await deps.ownerFork(ownerId)] as const)),
  );
  const plan = verificationPlan(huddle, (ownerId) => forks.get(ownerId));
  const initial = initialCheckpoints(huddle);
  const latest = deps.runs.latest(huddle.triggerCommit);
  const tested = latest?.checkpoints ?? initial;
  if (sameCheckpoints(plan.checkpoints, tested) && latest?.status !== "pending") return { status: "unchanged", issueId };

  const run = latest?.status === "pending" && sameCheckpoints(latest.checkpoints, plan.checkpoints)
    ? latest
    : deps.runs.schedule(huddle.triggerCommit, plan.checkpoints, plan.commands);
  try {
    await announce(deps, issueId, run, initial);
  } catch (error) {
    if (!(error instanceof VerificationRejected)) throw error;
    return { status: "rejected", issueId, message: error.message };
  }
  return { status: "scheduled", issueId, runId: run.runId };
}

/**
 * Links each checkpoint the run merges that is newer than the Huddle's opening and not linked yet,
 * the first link marking every current check superseded, and moves the issue to VERIFYING. Safe to
 * repeat: a link or state already there is not written again.
 */
async function announce(
  deps: HuddleVerifyDeps,
  issueId: string,
  run: VerificationRun,
  initial: readonly VerificationCheckpoint[],
): Promise<void> {
  const opening = new Set(initial.map((checkpoint) => `${checkpoint.ownerId}@${checkpoint.sha}`));
  for (const checkpoint of run.checkpoints) {
    if (opening.has(`${checkpoint.ownerId}@${checkpoint.sha}`)) continue;
    const commit = ownerCommit(checkpoint.ownerId, checkpoint.sha);
    const current = currentChecks(await issueOf(deps, issueId));
    await ensure(
      deps,
      issueId,
      (issue) => [...issue.linkedCommits.values()].some((l) => l.kind === "fix" && `${l.repo}@${l.sha}` === commit),
      "link_commit",
      { commit, kind: "fix", ...(current.length === 0 ? {} : { supersedes: current }) },
    );
  }
  const merged = run.checkpoints.map((checkpoint) => ownerCommit(checkpoint.ownerId, short(checkpoint.sha)));
  await ensure(deps, issueId, (issue) => issue.state === "verifying", "change_state", {
    state: "verifying",
    reason: clip(`Verifying ${joinAnd(merged)} merged on the Huddle repo's integration branch.`),
  });
}

/** The Huddle's pending runs the runner can take, oldest first, once the Huddle's repo is forked. */
export function pendingVerifications(runs: Pick<VerificationStore, "pending">, huddle: Huddle): PendingVerification[] {
  const issueId = huddle.issueId;
  if (issueId === null || huddle.huddleRepo === null) return [];
  return runs
    .pending()
    .filter((run) => run.triggerCommit === huddle.triggerCommit)
    .map((run) => ({
      createdAt: run.createdAt,
      spec: {
        runId: run.runId,
        issueId,
        huddleRepo: huddleRepoName(issueId),
        baseSha: huddle.baselineSha,
        checkpoints: run.checkpoints,
        commands: run.commands,
      },
    }));
}

/** The Huddle's pending runs as the runner lists them; see `pendingVerifications`. */
export function verificationSpecs(runs: Pick<VerificationStore, "pending">, huddle: Huddle): VerificationRunSpec[] {
  return pendingVerifications(runs, huddle).map((pending) => pending.spec);
}

/** The answer to a report of a run in no Huddle: an invalid report is refused as invalid first, as in `recordVerification`. */
export function unknownVerification(runId: string, input: unknown): VerificationOutcome {
  const parsed = parseVerificationReport(input);
  if (!parsed.ok) return invalidReport(parsed.issues);
  return { status: "rejected", reason: "not_found", message: `no verification run ${runId}` };
}

function invalidReport(issues: readonly { readonly field: string; readonly message: string }[]): VerificationOutcome {
  const message = issues.map((issue) => `${issue.field || "/"} ${issue.message}`).join("; ");
  return { status: "rejected", reason: "invalid", message };
}

/**
 * Records a runner's report of the Huddle's run `runId`: one check per result on the Huddle issue and
 * the state the results lead to. `runnerId` is the reporting runner bridge, from its token.
 */
export async function recordVerification(
  deps: HuddleVerifyDeps,
  huddle: Huddle,
  runId: string,
  runnerId: string,
  input: unknown,
): Promise<VerificationOutcome> {
  const parsed = parseVerificationReport(input);
  if (!parsed.ok) return invalidReport(parsed.issues);
  const run = /^[0-9]+$/u.test(runId) ? deps.runs.get(runId) : undefined;
  if (run === undefined || run.triggerCommit !== huddle.triggerCommit || huddle.issueId === null) {
    return { status: "rejected", reason: "not_found", message: `no verification run ${runId}` };
  }
  const issueId = huddle.issueId;
  if (run.status === "superseded") {
    return { status: "superseded", message: `run ${runId} was superseded by a newer checkpoint; its results do not count` };
  }
  if (run.status === "done") return { status: "existing", issueId };
  const report = parsed.report;
  const mismatch = reportMismatch(run, report);
  if (mismatch !== undefined) return { status: "rejected", reason: "invalid", message: mismatch };

  const commit = report.status === "tested"
    ? `${huddleRepoName(issueId)}@${report.revision}`
    : ownerCommit(report.ownerId, report.sha);
  const target = report.status === "tested" && report.results.every((result) => result.status === "passed")
    ? "in_review"
    : "fixing";
  try {
    if ((await issueOf(deps, issueId)).state !== "closed") {
      for (const draft of checkDrafts(run, report, commit)) {
        await ensure(deps, issueId, (issue) => hasCheck(issue, draft), "attach_check", draft);
      }
      await ensure(deps, issueId, (issue) => issue.state === target, "change_state", {
        state: target,
        reason: stateReason(report, commit),
      });
    }
  } catch (error) {
    if (!(error instanceof VerificationRejected)) throw error;
    return { status: "rejected", reason: "operation_rejected", message: error.message };
  }
  deps.runs.finish(run.runId, runnerId, report);
  return { status: "recorded", issueId, state: (await issueOf(deps, issueId)).state, commit };
}

/** Why a report does not answer the run, or undefined when it does. */
function reportMismatch(run: VerificationRun, report: VerificationReport): string | undefined {
  if (report.status === "conflict") {
    const merged = run.checkpoints.some((c) => c.ownerId === report.ownerId && c.sha === report.sha);
    return merged ? undefined : `${ownerCommit(report.ownerId, report.sha)} is not a checkpoint run ${run.runId} merges`;
  }
  const expected = run.commands.map((command) => command.commandId).sort();
  const reported = report.results.map((result) => result.commandId).sort();
  if (expected.join("\n") !== reported.join("\n")) {
    return `run ${run.runId} runs ${expected.join(", ")}, and the report holds ${reported.join(", ")}`;
  }
  const stray = report.results.find(
    (result) => result.fingerprint.commit !== report.revision || result.fingerprint.commandId !== result.commandId,
  );
  return stray === undefined ? undefined : `the fingerprint of ${stray.commandId} is not for that command on ${report.revision}`;
}

type CheckDraft = {
  readonly command_id: string;
  readonly commit: string;
  readonly test?: string;
  readonly result: "pass" | "fail" | "error";
  readonly fingerprint?: string;
};

/**
 * The checks a report attaches: a pass per passing command, a failure per failing test (or one for
 * the command when the log named none), and an error per command when a checkpoint did not merge.
 */
function checkDrafts(run: VerificationRun, report: VerificationReport, commit: string): CheckDraft[] {
  if (report.status === "conflict") {
    return run.commands.map((command) => ({ command_id: command.commandId, commit, result: "error" }));
  }
  return report.results.flatMap((result): CheckDraft[] => {
    const base = { command_id: result.commandId, commit, fingerprint: result.fingerprint.id };
    if (result.status === "passed") return [{ ...base, result: "pass" }];
    if (result.failingTests.length === 0) return [{ ...base, result: "fail" }];
    return result.failingTests.map((test) => ({ ...base, test: test.testId, result: "fail" }));
  });
}

function hasCheck(issue: IssueRecord, draft: CheckDraft): boolean {
  return [...issue.checks.values()].some(
    (check) =>
      check.supersededBy === null &&
      check.commandId === draft.command_id &&
      `${check.repo}@${check.sha}` === draft.commit &&
      check.test === (draft.test ?? null) &&
      check.result === draft.result &&
      check.fingerprint === (draft.fingerprint ?? null),
  );
}

function stateReason(report: VerificationReport, commit: string): string {
  if (report.status === "conflict") {
    return clip(`${commit} does not merge with the other checkpoints: ${report.paths.join(", ")}.`);
  }
  const failing = report.results.filter((result) => result.status === "failed");
  if (failing.length === 0) return clip(`Combined tests pass on ${shortCommit(commit)}.`);
  const tests = failing.flatMap((result) =>
    result.failingTests.length === 0 ? [result.commandId] : result.failingTests.map((test) => test.testId),
  );
  const listed = tests.slice(0, REASON_TESTS);
  const more = tests.length > listed.length ? ` and ${tests.length - listed.length} more` : "";
  return clip(`Combined tests fail on ${shortCommit(commit)}: ${listed.join(", ")}${more}.`);
}

/** The op_ids of the issue's checks that are not superseded. */
function currentChecks(issue: IssueRecord): string[] {
  return [...issue.checks.values()].filter((check) => check.supersededBy === null).map((check) => check.opId);
}

async function issueOf(deps: Pick<HuddleProjectPort, "issue">, issueId: string): Promise<IssueRecord> {
  const issue = await deps.issue(issueId);
  if (issue === undefined) throw new VerificationRejected(`issue ${issueId} is missing from the index`);
  return issue;
}

/** Writes the operation unless `present` finds its effect on the issue already. */
async function ensure(
  deps: HuddleVerifyDeps,
  issueId: string,
  present: (issue: IssueRecord) => boolean,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  const issue = await issueOf(deps, issueId);
  if (present(issue)) return;
  const outcome = await deps.submit({ issue: Number(issueId), type, base_version: issue.version, payload });
  if (outcome.status === "rejected") {
    throw new VerificationRejected(`${type} on #${issueId} was rejected: ${outcome.reason}: ${outcome.message}`);
  }
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function shortCommit(commit: string): string {
  const at = commit.indexOf("@");
  return `${commit.slice(0, at)}@${short(commit.slice(at + 1))}`;
}

function clip(text: string): string {
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`;
}
