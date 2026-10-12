// Penguin rebuilds a feature it opened from main when main moved past it (PRD 0.5 section 4.2 step 2,
// "Features Penguin opens"; #143). Nobody merges main into such a fork: no agent works in it, and an
// edit task's commit has one parent. Once the feature is ready to land and its fork's head does not
// hold main's head (penguin-land.ts), Penguin rebuilds it instead:
//
// 1. **Read what was written.** Each part on main of a migration plan's block is `written`: by the
//    check runner from the rules' patch, kept on the part, or by an edit task whose kept commit sits
//    in the fork. A kept commit is read as a patch against its parent (repo-diff.ts `commitPatch`)
//    before the fork goes.
// 2. **Open the fork again from main.** The fork is deleted and forked from main's head under the
//    same name, so every reader of `feature-<id>` keeps working. A commit that wrote no part, such as
//    a kept next-step fix of a failed block run, is not carried: the next block run asks again.
// 3. **Re-apply and re-trial each part.** Each part with a patch goes back to `trial` against main's
//    head (migration-plans.ts `queueMigrationTrial`). A passing trial approves it and the check runner
//    writes it into the new fork, one write at a time; a failing trial makes it an edit task with the
//    failing checks. A kept commit that is no plain text patch is an edit task at once. Penguin lands
//    the block again once every part is written.
// 4. **A contract carrier.** Its removal has no part trial, so the `contract` task opens again for the
//    steward on the new fork, naming the earlier removal's commit.
//
// One signed `block_rebuilt` record on the feature names the old head, main's head and what happened
// to each part. Load: one rebuild per fork head behind main; a part's trial is the one it had before.
// Every value reaches SQL as a bound parameter. Nothing here runs code.

import type { Feature } from "./feature-store.ts";
import type { ForkReading } from "./fix-write.ts";
import { contractTask, queueMigrationTrial, routeToTask, settlePlan, stewardsFor, type MigrationDeps, type MigrationPart } from "./migration-plans.ts";
import { commitPatch } from "./repo-diff.ts";

export interface RebuildDeps extends MigrationDeps {
  /** Reads a fork through the Artifacts binding. */
  readonly readFork: ForkReading;
  /** Deletes the feature's fork and forks main's head again under its name; null when that failed. */
  readonly refork: (featureId: string) => Promise<string | null>;
}

/** What one rebuild did to each part it carried. */
export interface RebuildOutcome {
  readonly recordId: string;
  readonly parts: readonly { readonly part: string; readonly from: "patch" | "commit" | "removal"; readonly state: string; readonly reason: string }[];
}

const short = (sha: string): string => sha.slice(0, 12);

/** How a written part is re-applied: its patch, or why it cannot be. */
type Source = { readonly part: MigrationPart; readonly from: "patch" | "commit"; readonly patch: string | null; readonly problem: string | null };

/**
 * Rebuilds `feature`, a feature Penguin opened whose fork head `head` does not hold main's head
 * `main`. Undefined when there is nothing to rebuild or the fork could not be made again; nothing has
 * changed then.
 */
export async function rebuildPenguinFeature(
  deps: RebuildDeps,
  feature: Feature & { readonly repo: string },
  kind: "block" | "contract",
  head: string,
  main: string,
): Promise<RebuildOutcome | undefined> {
  return kind === "block" ? rebuildBlock(deps, feature, head, main) : rebuildCarrier(deps, feature, head, main);
}

async function rebuildBlock(deps: RebuildDeps, feature: Feature & { readonly repo: string }, head: string, main: string): Promise<RebuildOutcome | undefined> {
  const plan = deps.store.planOfBlock(feature.id);
  if (plan === undefined) return undefined;
  const written = plan.parts.filter((part) => part.place.kind === "scope" && part.state === "written").map((part) => deps.store.part(part.partId) as MigrationPart);
  if (written.length === 0) return undefined;
  // Every kept commit is read before the fork it sits in goes.
  const sources: Source[] = [];
  for (const part of written) {
    if (part.writer !== "task" && part.patch !== null) {
      sources.push({ part, from: "patch", patch: part.patch, problem: null });
      continue;
    }
    const commit = deps.tasks.forSource(`migrate:${part.partId}`).find((task) => task.state === "done")?.commit ?? null;
    if (commit === null) {
      sources.push({ part, from: "commit", patch: null, problem: "no kept commit is recorded for the part" });
      continue;
    }
    const read = await deps.readFork(feature.repo, (reader) => commitPatch(reader, commit));
    sources.push("patch" in read ? { part, from: "commit", patch: read.patch, problem: null } : { part, from: "commit", patch: null, problem: read.problem });
  }
  if ((await deps.refork(feature.id)) === null) return undefined;

  const parts: { part: string; from: "patch" | "commit"; state: string; reason: string }[] = [];
  for (const { part, from, patch, problem } of sources) {
    const what = from === "patch" ? "the rules' patch" : "the kept commit";
    if (patch === null) {
      const reason = `the block was rebuilt from main at ${short(main)} and ${what} cannot be re-applied: ${problem}`;
      await routeToTask(deps, plan, part, reason, main, [reason]);
    } else {
      deps.store.updatePart(part.partId, { state: "trial", patch, targetSha: main, reason: `the block was rebuilt from main at ${short(main)}; ${what} is tried again there` });
      queueMigrationTrial(deps, plan, deps.store.part(part.partId) as MigrationPart);
    }
    const now = deps.store.part(part.partId) as MigrationPart;
    parts.push({ part: part.partId, from, state: now.state, reason: now.reason ?? "" });
  }
  await settlePlan(deps, plan.planId);
  const recordId = await record(deps, feature.id, head, main, parts);
  deps.notify?.(plan.owner);
  return { recordId, parts };
}

async function rebuildCarrier(deps: RebuildDeps, feature: Feature & { readonly repo: string }, head: string, main: string): Promise<RebuildOutcome | undefined> {
  const origin = deps.store.penguinFeatures().find((each) => each.featureId === feature.id)?.origin;
  const steps = deps.retiring.approvedSteps(feature.id);
  if (origin === undefined || steps.length === 0) return undefined;
  const earlier = deps.tasks.forSource(`contract:${feature.id}`).find((task) => task.state === "done")?.commit ?? null;
  if ((await deps.refork(feature.id)) === null) return undefined;
  const owned = steps.map(({ contract, replacement }) => ({ contract, replacement }));
  const reason = `the carrier was rebuilt from main at ${short(main)}; the removal is made again there`;
  const evidence = [reason, ...(earlier === null ? [] : [`the earlier removal was commit ${short(earlier)} on fork head ${short(head)}`])];
  await deps.openTask(
    contractTask(feature.id, origin, feature.personId, feature.area.scopes, owned, deps.retiring.ownFiles(owned.map((each) => each.contract)), steps[0]?.promotion ?? main, evidence),
    stewardsFor(deps.store),
  );
  const parts = [{ part: `contract:${feature.id}`, from: "removal" as const, state: "task", reason }];
  const recordId = await record(deps, feature.id, head, main, parts);
  deps.notify?.(feature.personId);
  return { recordId, parts };
}

async function record(deps: RebuildDeps, featureId: string, head: string, main: string, parts: RebuildOutcome["parts"]): Promise<string> {
  const signed = await deps.sign(
    deps.features.draftRecord(featureId, "block_rebuilt", { penguin: true }, {
      from_head: head,
      main,
      reason: "the fork's head does not hold main's head, and nobody merges main into a fork Penguin opened",
      parts: parts.map((each) => ({ part: each.part, from: each.from, state: each.state })),
    }),
  );
  deps.features.addRecord(signed);
  return signed.record_id;
}
