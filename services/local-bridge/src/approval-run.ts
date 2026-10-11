// Approved branches in runner mode (PRD sections 5, 6 and 11 Phase 4): once a Huddle's fixes are
// approved, its combined tests pass and its threads are resolved, Penguin lists the verified
// `integration` commit, and the runner points the Huddle repo's `approved` branch at it and reports
// back. The Worker cannot write a Git ref through the Artifacts binding, so the runner, which already
// pushes `integration`, writes this one too. Nothing here merges into the team's main branch.

import { isObjectId, runGit } from "@penguin/git-analysis";
import { APPROVED_BRANCH, type ApprovalReport, type ApprovalSpec } from "@penguin/protocol";

import { penguinRemote, type RemoteResolver } from "./git-remote.ts";
import type { ApprovalReply } from "./penguin-client.ts";
import { fetchedBranch, fetchedRefs, fetchRepoBranches, hasCommit, isRunnerRepo } from "./runner-repo.ts";

export interface ApprovedBranchWriterOptions {
  /** The runner's repository, which the Huddle repo is fetched into. */
  readonly repoPath: string;
  /** Resolves `penguin:huddle-<id>` for fetching and pushing the Huddle repo. */
  readonly writeRemotes: RemoteResolver;
}

export class ApprovedBranchWriter {
  readonly #options: ApprovedBranchWriterOptions;

  constructor(options: ApprovedBranchWriterOptions) {
    this.#options = options;
  }

  /**
   * Points the Huddle repo's `approved` branch at the listed commit and reports it. No force: the
   * branch only follows `integration` forward, and a branch already at the commit is left as it is.
   *
   * Raises:
   *   Error: when the listing is malformed, the commit is not in the Huddle repo, or the fetch or the
   *   push fails.
   */
  async write(spec: ApprovalSpec): Promise<ApprovalReport> {
    checkSpec(spec);
    const { repoPath, writeRemotes } = this.#options;
    await fetchRepoBranches(repoPath, writeRemotes, spec.huddleRepo);
    if (!(await hasCommit(repoPath, spec.sha))) throw new Error(`commit ${spec.sha} is not in ${spec.huddleRepo}`);
    if ((await fetchedBranch(repoPath, spec.huddleRepo, APPROVED_BRANCH)) !== spec.sha) {
      await writeRemotes(penguinRemote(spec.huddleRepo)).git(repoPath, (url) => [
        "push",
        "--porcelain",
        "--end-of-options",
        url,
        `${spec.sha}:refs/heads/${APPROVED_BRANCH}`,
      ]);
      await runGit(repoPath, ["update-ref", `${fetchedRefs(spec.huddleRepo)}/${APPROVED_BRANCH}`, spec.sha]);
    }
    return { sha: spec.sha };
  }
}

/** Refuses a listing that names something other than a full SHA in a Huddle repo. */
function checkSpec(spec: ApprovalSpec): void {
  if (typeof spec.sha !== "string" || !isObjectId(spec.sha)) {
    throw new Error(`the approval of #${spec.issueId} names a commit that is not a full object ID`);
  }
  if (typeof spec.huddleRepo !== "string" || !isRunnerRepo(spec.huddleRepo) || !spec.huddleRepo.startsWith("huddle-")) {
    throw new Error(`the approval of #${spec.issueId} names a repo that is not a Huddle repo`);
  }
}

export interface ApprovalPassResult {
  readonly listed: number;
  /** Each approved branch written and reported, with Penguin's answer. */
  readonly reported: readonly { readonly issueId: string; readonly reply: ApprovalReply }[];
  /** Approvals not written or not reported. They stay listed and run again next pass. */
  readonly failed: readonly { readonly issueId: string; readonly reason: string }[];
  readonly durationMs: number;
}

export interface ApprovalPassOptions {
  readonly list: () => Promise<readonly ApprovalSpec[]>;
  readonly write: (spec: ApprovalSpec) => Promise<ApprovalReport>;
  readonly report: (issueId: string, report: ApprovalReport) => Promise<ApprovalReply>;
}

/** Writes and reports each listed approved branch in turn; one failure never stops the next. */
export async function approvalPass(options: ApprovalPassOptions): Promise<ApprovalPassResult> {
  const started = performance.now();
  const specs = await options.list();
  const reported: { issueId: string; reply: ApprovalReply }[] = [];
  const failed: { issueId: string; reason: string }[] = [];
  for (const spec of specs) {
    try {
      reported.push({ issueId: spec.issueId, reply: await options.report(spec.issueId, await options.write(spec)) });
    } catch (error) {
      failed.push({ issueId: String(spec.issueId), reason: (error as Error).message });
    }
  }
  return { listed: specs.length, reported, failed, durationMs: Math.round(performance.now() - started) };
}

export function formatApprovalPass(result: ApprovalPassResult): string {
  const lines = result.reported.map(
    ({ issueId, reply }) => `Approved branch of #${issueId}: ${reply.commit}; the issue is ${reply.state}.`,
  );
  for (const { issueId, reason } of result.failed) lines.push(`Approved branch of #${issueId} was not recorded: ${reason}`);
  lines.push(`${result.listed} approved branches listed, ${result.reported.length} recorded (${result.durationMs} ms).`);
  return `${lines.join("\n")}\n`;
}
