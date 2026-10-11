// The check runner's half of the agent tools `impact`, `check` and `apply_fix` (PRD 0.4 section 5.2).
// A request waits in AgentToolRun with the checkpoint's baseline on main. The integration runner
// claims waiting requests under a lease, as it claims reviews (review-record.ts): an unreported claim
// is handed out again after the lease. Each claim names the feature's fork, the checkpoint, its
// baseline, the caller's charter and the other running features' forks the checks merge with.
//
// The report attaches the runner's result to the request. The first report wins. The result reaches
// the requesting session at its next safe checkpoint (AgentToolStore.deliver).
//
// No bridge holds write on a feature's fork until a merge plan grants one (#91), so an `apply_fix`
// result names a commit kept as a local ref on the runner and is never pushed.

import {
  FIX_COMMAND_IDS,
  parseToolResult,
  REGENERATED_LOCKFILES,
  type AgentToolName,
  type FixKind,
  type RunnerToolName,
  type ToolRunRecord,
} from "@penguin/protocol";
import type { CharterIdentity } from "@penguin/policies";

import type { AgentToolRun, AgentToolStore } from "./agent-tools.ts";
import type { Feature, FeatureStore } from "./feature-store.ts";
import type { BridgeCaller } from "./issue-index.ts";
import { RUNNING_STATES } from "./overlap-lock.ts";

/** Another running feature's fork the checks merge the checkpoint onto, named by its person. */
export interface ClaimedFork {
  readonly feature: string;
  readonly person: string;
  /** The fork as a bridge names it, `feature-<id>`, without the deployment's prefix. */
  readonly fork: string;
  readonly checkpoint: string;
}

/** One claimed request as the runner receives it. Every value comes from the stored request. */
export interface ClaimedToolRun {
  readonly runId: number;
  readonly tool: RunnerToolName;
  readonly feature: string;
  readonly fork: string;
  /** The checkpoint's baseline on main. */
  readonly base: string;
  readonly checkpoint: string;
  /** The request's checked input: for `apply_fix` its kind, paths and edits. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The calling identity's charter: where a fix may write, and whose step a failure is. */
  readonly charter: { readonly handle: string; readonly person: string; readonly scopes: readonly string[]; readonly paths: readonly string[] };
  /** The other running features' forks with a checkpoint, one per person. */
  readonly forks: readonly ClaimedFork[];
}

export type ToolRunClaim =
  | { readonly status: "ok"; readonly runs: readonly ClaimedToolRun[] }
  | { readonly status: "forbidden"; readonly message: string };

export interface ToolRunnerDeps {
  readonly runs: AgentToolStore;
  readonly features: FeatureStore;
  /** The charter of an identity, by its id. */
  readonly identity: (identityId: string) => CharterIdentity | undefined;
}

/**
 * The running features other than `own` with a checkpoint, one per person: when a person runs
 * several, the one updated last. The block checks key each merged tree by its person, whose scopes
 * decide which tests run.
 */
export function otherForks(features: readonly Feature[], own: string): ClaimedFork[] {
  const latest = new Map<string, Feature>();
  for (const feature of features) {
    if (feature.id === own || !RUNNING_STATES.has(feature.state) || feature.latestCheckpointSha === null) continue;
    const known = latest.get(feature.personId);
    if (known === undefined || known.updatedAt < feature.updatedAt) latest.set(feature.personId, feature);
  }
  return [...latest.values()]
    .sort((a, b) => a.personId.localeCompare(b.personId))
    .map((feature) => ({ feature: feature.id, person: feature.personId, fork: `feature-${feature.id}`, checkpoint: feature.latestCheckpointSha as string }));
}

const isRunnerTool = (tool: AgentToolName): tool is RunnerToolName => tool !== "whats_near";

/** Claims the waiting tool requests for a runner bridge; any other role is refused. */
export function claimToolRuns(deps: ToolRunnerDeps, caller: BridgeCaller): ToolRunClaim {
  const listing = deps.runs.claim(caller);
  if (listing.status === "forbidden") return listing;
  const features = deps.features.list();
  const runs = listing.runs.flatMap((run): ClaimedToolRun[] => {
    const feature = features.find((item) => item.id === run.featureId);
    const identity = run.identityId === null ? undefined : deps.identity(run.identityId);
    if (feature === undefined || identity === undefined || !isRunnerTool(run.tool)) return [];
    return [
      {
        runId: run.id,
        tool: run.tool,
        feature: feature.id,
        fork: `feature-${feature.id}`,
        base: run.baseSha as string,
        checkpoint: run.checkpointSha as string,
        input: run.input,
        charter: {
          handle: identity.handle,
          // A team identity has no one owner; the feature's person then receives its exceptions.
          person: identity.ownerId ?? feature.personId,
          scopes: [...identity.charterScopes],
          paths: [...identity.charterPaths],
        },
        forks: otherForks(features, feature.id),
      },
    ];
  });
  return { status: "ok", runs };
}

export type ToolReportOutcome =
  | { readonly status: "recorded"; readonly run: AgentToolRun }
  | { readonly status: "rejected"; readonly reason: "invalid" | "forbidden" | "not_found" | "conflict"; readonly message: string };

const rejected = (reason: Extract<ToolReportOutcome, { status: "rejected" }>["reason"], message: string): ToolReportOutcome => ({
  status: "rejected",
  reason,
  message,
});

/**
 * Attaches the runner's result to waiting request `runId`. The result must be of the request's own
 * tool, baseline and checkpoint. The first report wins; a later one answers `conflict`.
 */
export function recordToolResult(runs: AgentToolStore, caller: BridgeCaller, runId: number, body: unknown): ToolReportOutcome {
  if (caller.role !== "runner") return rejected("forbidden", `bridge ${caller.bridgeId} does not hold the runner role`);
  const run = runs.get(runId);
  if (run === undefined || !isRunnerTool(run.tool)) return rejected("not_found", `no tool request ${runId}`);
  if (run.result !== "waiting") return rejected("conflict", `tool request ${runId} is already ${run.result}`);
  const parsed = parseToolResult(body);
  if (!parsed.ok) return rejected("invalid", parsed.problems.join("; "));
  const { result } = parsed;
  if (result.tool !== run.tool || result.base !== run.baseSha || result.checkpoint !== run.checkpointSha) {
    return rejected("invalid", `the result is not of tool request ${runId}: it must name its tool, baseline and checkpoint`);
  }
  const fixProblem = run.tool === "apply_fix" ? fixMismatch(run, result.fix) : null;
  if (fixProblem !== null) return rejected("invalid", fixProblem);
  const completed = runs.complete(runId, result);
  if (completed === undefined) return rejected("conflict", `tool request ${runId} was completed by another report`);
  return { status: "recorded", run: completed };
}

/**
 * Why a fix result does not match its request, or null: it must run the requested fix's command, and
 * change only the files the request named (only lockfiles for a lockfile fix).
 */
function fixMismatch(run: AgentToolRun, fix: ToolRunRecord | null): string | null {
  const kind = run.input["kind"] as FixKind;
  if (fix === null || fix.commandId !== FIX_COMMAND_IDS[kind]) return `the result of tool request ${run.id} must be a ${FIX_COMMAND_IDS[kind]} run`;
  const named = new Set(Array.isArray(run.input["paths"]) ? (run.input["paths"] as string[]) : []);
  const allowed = (path: string) => (kind === "lockfile" ? REGENERATED_LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1)) : named.has(path));
  const outside = (fix.changed?.paths ?? []).find((path) => !allowed(path));
  return outside === undefined ? null : `the fix changed ${outside}, which tool request ${run.id} did not name`;
}
