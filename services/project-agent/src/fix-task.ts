// A fix sub-issue as a task for the session it is delivered to (PRD section 8, `get_work`): the
// pinned base to work from, the failing test it fixes and the acceptance criteria. Everything comes
// from the Huddle's initiating combined-run event, which never changes after the Huddle opens, so a
// session that receives the task later, after a disconnect, sees the same task.

import { fixesOf } from "./huddle-open.ts";
import { ownerCommit, type HuddleStore } from "./huddle-store.ts";

export interface FixTask {
  /** The Huddle issue the fix belongs to, or null while the Huddle's create is not yet applied. */
  readonly huddleIssueId: string | null;
  /**
   * The revisions the failure was found on: the trigger checkpoint, its baseline on main, and the
   * failing owner's checkpoint the trigger was merged with. A fix starts from `checkpoint`.
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

/** The task for a fix sub-issue, or undefined when the issue is not one. */
export function fixTask(huddles: Pick<HuddleStore, "fixOf">, issueId: string): FixTask | undefined {
  const found = huddles.fixOf(issueId);
  if (found === undefined) return undefined;
  const { huddle, fixKey } = found;
  const fix = fixesOf(huddle.event).find((candidate) => candidate.key === fixKey);
  if (fix === undefined) return undefined;
  const checkpoint = ownerCommit(fix.ownerId, fix.ownerCheckpoint);
  const test = fix.test?.testId ?? null;
  return {
    huddleIssueId: huddle.issueId,
    pinnedBase: { trigger: huddle.triggerCommit, baseline: huddle.baselineSha, checkpoint },
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
      `${test ?? `\`${fix.commandId}\``} passes when ${huddle.triggerCommit} is merged with your fixed checkpoint of ` +
        `owner-${fix.ownerId}.`,
      `\`${fix.commandId}\` passes in full on that merge.`,
    ],
  };
}
