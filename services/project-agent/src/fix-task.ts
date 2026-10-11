// A fix sub-issue as a task for the session it is delivered to (PRD section 8, `get_work`): the
// pinned base to work from, the failing test it fixes and the acceptance criteria. Everything comes
// from the Huddle's initiating combined-run event, which never changes after the Huddle opens, so a
// session that receives the task later, after a disconnect, sees the same task.
//
// The task has two templated forms. While the fix sits with the dependent owner whose test failed,
// it pins that owner's checkpoint and asks for a fixed checkpoint of it. Once the fix is reassigned
// to another owner, as a send_upstream does (upstream.ts), it pins the trigger, the changing scope's
// checkpoint, and asks for a fixed checkpoint of the new assignee's owner that makes the dependent
// owner's test pass. The form follows the issue's current assignees. Nothing here writes to the
// issue, so its body and timeline keep the sender's original task as it was.

import type { IssueRecord } from "@penguin/issues";

import { fixesOf, type Fix } from "./huddle-open.ts";
import { ownerCommit, type Huddle, type HuddleStore } from "./huddle-store.ts";

export interface FixTask {
  /** The Huddle issue the fix belongs to, or null while the Huddle's create is not yet applied. */
  readonly huddleIssueId: string | null;
  /**
   * The revisions the failure was found on: the trigger checkpoint and its baseline on main, and the
   * checkpoint a fix starts from. That is the dependent owner's checkpoint the trigger was merged
   * with, or the trigger itself once the fix is reassigned to another owner.
   */
  readonly pinnedBase: { readonly trigger: string; readonly baseline: string; readonly checkpoint: string };
  readonly failingTests: readonly FailingTest[];
  readonly acceptanceCriteria: readonly string[];
}

export interface FailingTest {
  readonly scopeId: string;
  /** The allowlisted command that ran the test, such as "test:analytics". */
  readonly commandId: string;
  /** `<module>::<test>`, or null for a failed run whose log named no test. */
  readonly testId: string | null;
  readonly nodeId: string | null;
  /** The fingerprint of commit, lockfile and command the failure applies to. */
  readonly fingerprint: string;
}

/**
 * The task for a fix sub-issue, or undefined when the issue is not one. `issue` is the sub-issue's
 * current record, or undefined when the index does not hold it yet; its assignees decide whether the
 * task is stated for the dependent owner or, once reassigned, for the new assignee's owner.
 */
export function fixTask(
  huddles: Pick<HuddleStore, "fixOf">,
  issueId: string,
  issue: Pick<IssueRecord, "assignments"> | undefined,
): FixTask | undefined {
  const found = huddles.fixOf(issueId);
  if (found === undefined) return undefined;
  const { huddle, fixKey } = found;
  const fix = fixesOf(huddle.event).find((candidate) => candidate.key === fixKey);
  if (fix === undefined) return undefined;
  const test = fix.test?.testId ?? null;
  const failing = test ?? `\`${fix.commandId}\``;
  const dependent = ownerCommit(fix.ownerId, fix.ownerCheckpoint);
  const upstream = upstreamOwner(huddle, fix, issue);
  return {
    huddleIssueId: huddle.issueId,
    pinnedBase: {
      trigger: huddle.triggerCommit,
      baseline: huddle.baselineSha,
      checkpoint: upstream === undefined ? dependent : huddle.triggerCommit,
    },
    failingTests: [
      {
        scopeId: fix.scopeId,
        commandId: fix.commandId,
        testId: test,
        nodeId: fix.test?.nodeId ?? null,
        fingerprint: fix.fingerprint,
      },
    ],
    acceptanceCriteria: [
      upstream === undefined
        ? `${failing} passes when ${huddle.triggerCommit} is merged with your fixed checkpoint of owner-${fix.ownerId}.`
        : `${fix.scopeId} test ${failing} passes when your fixed checkpoint of owner-${upstream} is merged with ` +
          `${dependent}.`,
      `\`${fix.commandId}\` passes in full on that merge.`,
    ],
  };
}

/**
 * The owner the fix was reassigned to: the owner of an assignee other than the dependent owner whose
 * test failed, preferring the trigger's owner, else the first by id. Undefined while every assignee
 * is the dependent owner or one of that owner's identities.
 */
function upstreamOwner(
  huddle: Pick<Huddle, "triggerOwner">,
  fix: Pick<Fix, "ownerId">,
  issue: Pick<IssueRecord, "assignments"> | undefined,
): string | undefined {
  const owners = new Set<string>();
  for (const { assigneeKind, assigneeId } of issue?.assignments.values() ?? []) {
    // An identity handle is `@<owner>/<name>`.
    const owner = assigneeKind === "person" ? assigneeId : assigneeId.slice(1, assigneeId.indexOf("/"));
    if (owner !== fix.ownerId) owners.add(owner);
  }
  if (owners.has(huddle.triggerOwner)) return huddle.triggerOwner;
  return [...owners].sort()[0];
}
