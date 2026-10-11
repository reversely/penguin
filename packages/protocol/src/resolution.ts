// The agent tools and the resolution ladder (PRD sections 5.2 and 5.3). When a check fails, Penguin
// classifies the failure and returns one next step to one actor, so an agent never tries tools in
// turn. Steps 1 to 3 are deterministic fixes Penguin applies itself: the formatter and lint autofix,
// a regenerated lockfile, and a codemod generated from the contract diff. Steps 4 and 5 go to an
// agent, inside or outside the originating agent's charter. Step 6 goes to one person.
//
// The ladder, the routes from a check's failure to a step and the fix each step applies are data in
// this module. The classifier reads them; it holds no table of its own.

import type { BlockCheck, BlockCheckFinding, BlockCheckName } from "./block-check.ts";
import type { ImpactReport, ImpactUse } from "./impact.ts";

/** The MCP tools an agent calls for facts and deterministic fixes (PRD section 5.2). */
export const AGENT_TOOLS = ["whats_near", "impact", "check", "apply_fix"] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

/** The deterministic fixes `apply_fix` and the ladder's steps 1 to 3 apply. No other fix exists. */
export const FIX_KINDS = ["format", "lint", "lockfile", "codemod"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** Command IDs of the fixes. Each maps to a fixed program in the bridge, never to repository text. */
export const FIX_COMMAND_IDS: Readonly<Record<FixKind, string>> = {
  format: "fix:ruff-format",
  lint: "fix:ruff-autofix",
  lockfile: "fix:uv-lock",
  codemod: "fix:python-codemod",
};

/** The mechanical interface changes a codemod rewrites at each call site. */
export const CODEMOD_KINDS = ["rename", "move", "rename-parameter"] as const;
export type CodemodKind = (typeof CODEMOD_KINDS)[number];

/**
 * One codemod edit. `rename` and `move` rewrite every import and reference of the dotted name `from`
 * to `to`. `rename-parameter` rewrites the keyword `from` to `to` in each call of `function`.
 */
export type CodemodEdit =
  | { readonly kind: "rename" | "move"; readonly from: string; readonly to: string }
  | { readonly kind: "rename-parameter"; readonly function: string; readonly from: string; readonly to: string };

export const CODEMOD_LIMITS = { edits: 50, paths: 2_000, nameLength: 512, pathLength: 1_024 } as const;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127})*$/u;

const isDotted = (value: unknown): value is string =>
  typeof value === "string" && value.length <= CODEMOD_LIMITS.nameLength && DOTTED.test(value);

/** Why `value` is no codemod edit, or null when it is one. Unknown fields are refused. */
export function codemodEditProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "an edit must be an object";
  const edit = value as Record<string, unknown>;
  if (edit["kind"] === "rename" || edit["kind"] === "move") {
    const extra = Object.keys(edit).filter((key) => !["kind", "from", "to"].includes(key));
    if (extra.length > 0) return `unknown field ${extra[0]}`;
    if (!isDotted(edit["from"]) || !isDotted(edit["to"])) return "from and to must be dotted Python names";
    if (edit["from"] === edit["to"]) return "from and to must differ";
    return null;
  }
  if (edit["kind"] === "rename-parameter") {
    const extra = Object.keys(edit).filter((key) => !["kind", "function", "from", "to"].includes(key));
    if (extra.length > 0) return `unknown field ${extra[0]}`;
    if (!isDotted(edit["function"])) return "function must be a dotted Python name";
    for (const key of ["from", "to"]) {
      if (typeof edit[key] !== "string" || !IDENTIFIER.test(edit[key] as string)) return `${key} must be a Python identifier`;
    }
    if (edit["from"] === edit["to"]) return "from and to must differ";
    return null;
  }
  return `kind must be one of ${CODEMOD_KINDS.join(", ")}`;
}

// The ladder.

export type LadderStepNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** Who takes a step: Penguin's own tools, one agent, or one person. */
export type LadderActorKind = "penguin" | "originating-agent" | "owner-agent" | "person";

export interface LadderStep {
  readonly step: LadderStepNumber;
  readonly failure: string;
  readonly nextStep: string;
  readonly actor: LadderActorKind;
  /** The fixes Penguin applies at this step; empty for a step an agent or a person takes. */
  readonly fixes: readonly FixKind[];
}

/** PRD section 5.3, one row per step. */
export const RESOLUTION_LADDER: readonly LadderStep[] = [
  { step: 1, failure: "Formatting, import order, lint", nextStep: "Penguin applies the formatter and lint autofix", actor: "penguin", fixes: ["format", "lint"] },
  { step: 2, failure: "Lockfile conflict", nextStep: "Penguin regenerates the lockfile", actor: "penguin", fixes: ["lockfile"] },
  {
    step: 3,
    failure: "Mechanical interface change: rename, move, added parameter with a default",
    nextStep: "Penguin applies a codemod generated from the contract diff",
    actor: "penguin",
    fixes: ["codemod"],
  },
  {
    step: 4,
    failure: "Behaviour change inside the agent's charter",
    nextStep: "The originating agent adapts, with the failing check and the changed lines attached",
    actor: "originating-agent",
    fixes: [],
  },
  { step: 5, failure: "Behaviour change outside its charter", nextStep: "The agent of the scope's owner adapts", actor: "owner-agent", fixes: [] },
  { step: 6, failure: "Exception", nextStep: "One person", actor: "person", fixes: [] },
];

/** What a failing check is, as the classifier reads it from the check and the contract diff. */
export const FAILURE_KINDS = [
  "formatting",
  "lint",
  "lockfile-conflict",
  "rename",
  "move",
  "signature",
  "behaviour",
  "tool-error",
  "round-limit",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Any check: the route applies whichever check failed. */
export const ANY_CHECK = "*";

export interface LadderRoute {
  readonly check: BlockCheckName | typeof ANY_CHECK;
  readonly failure: FailureKind;
  readonly step: LadderStepNumber;
  /** The step when the failing place lies outside the originating agent's charter. */
  readonly outsideCharter?: LadderStepNumber;
  /** The fix applied at a step Penguin takes. */
  readonly fix?: FixKind;
}

/**
 * Which step takes each failure, keyed by check and failure kind. A row for one check wins over a
 * row for any check. A failure kind with no row is a behaviour change.
 */
export const LADDER_ROUTES: readonly LadderRoute[] = [
  { check: "format", failure: "formatting", step: 1, fix: "format" },
  { check: "lint", failure: "lint", step: 1, fix: "lint" },
  { check: "merge", failure: "lockfile-conflict", step: 2, fix: "lockfile" },
  { check: "tests", failure: "rename", step: 3, fix: "codemod" },
  { check: "tests", failure: "move", step: 3, fix: "codemod" },
  { check: "tests", failure: "signature", step: 3, fix: "codemod" },
  { check: "typecheck", failure: "rename", step: 3, fix: "codemod" },
  { check: "typecheck", failure: "move", step: 3, fix: "codemod" },
  { check: "typecheck", failure: "signature", step: 3, fix: "codemod" },
  { check: ANY_CHECK, failure: "behaviour", step: 4, outsideCharter: 5 },
  { check: ANY_CHECK, failure: "tool-error", step: 6 },
  { check: ANY_CHECK, failure: "round-limit", step: 6 },
];

/** Base names of the lockfiles a lockfile conflict can name; a step-2 fix regenerates `uv.lock`. */
export const REGENERATED_LOCKFILES: ReadonlySet<string> = new Set(["uv.lock"]);

/** The route for a check and failure kind: the row for that check, else the row for any check. */
export function ladderRoute(check: BlockCheckName, failure: FailureKind): LadderRoute {
  const route =
    LADDER_ROUTES.find((row) => row.check === check && row.failure === failure) ??
    LADDER_ROUTES.find((row) => row.check === ANY_CHECK && row.failure === failure) ??
    LADDER_ROUTES.find((row) => row.check === ANY_CHECK && row.failure === "behaviour");
  return route as LadderRoute;
}

export function ladderStep(step: LadderStepNumber): LadderStep {
  return RESOLUTION_LADDER.find((row) => row.step === step) as LadderStep;
}

// Mechanical interface changes the contract diff shows, as codemod edits.

/** The codemod a target needs: the edits the contract diff gives and the files whose uses they rewrite. */
export interface CodemodPlan {
  readonly edits: readonly CodemodEdit[];
  readonly paths: readonly string[];
  /** The failure kinds the edits answer, in ladder order of preference. */
  readonly kinds: readonly ("rename" | "move" | "signature")[];
}

/**
 * The codemod edits the contract diff gives for one target's uses: each renamed or moved symbol the
 * target imports, calls or references, and each changed signature whose only change is one keyword
 * parameter renamed. `target` is a fork id of the report, or null for the head tree's own callers.
 */
export function codemodPlan(report: ImpactReport, target: string | null): CodemodPlan {
  const uses: readonly ImpactUse[] = target === null ? report.headUses : (report.forks.find((fork) => fork.id === target)?.uses ?? []);
  const edits = new Map<string, CodemodEdit>();
  const paths = new Set<string>();
  const kinds = new Set<"rename" | "move" | "signature">();
  for (const use of uses) {
    const change = report.changes.find((item) => item.symbol === use.symbol && item.to !== undefined);
    if (change !== undefined && change.to !== undefined && (change.change === "renamed" || change.change === "moved")) {
      const kind = change.change === "renamed" ? "rename" : "move";
      edits.set(`${kind}:${change.symbol}`, { kind, from: change.symbol, to: change.to.symbol });
      kinds.add(kind);
      paths.add(use.path);
      continue;
    }
    const signature = report.signatures.find((item) => item.symbol === use.symbol);
    const [removed] = signature?.removed ?? [];
    const [added] = signature?.added ?? [];
    if (signature !== undefined && use.kind === "call" && signature.removed.length === 1 && signature.added.length === 1 && removed && added) {
      edits.set(`parameter:${signature.symbol}`, { kind: "rename-parameter", function: signature.symbol, from: removed, to: added.name });
      kinds.add("signature");
      paths.add(use.path);
    }
  }
  const order = ["rename", "move", "signature"] as const;
  return { edits: [...edits.values()], paths: [...paths].sort(), kinds: order.filter((kind) => kinds.has(kind)) };
}

// The classifier.

/** The charter of the originating agent's identity: the scopes and paths it may change. */
export interface CharterView {
  readonly handle: string;
  /** The person the identity works for, who receives the feature's exceptions. */
  readonly person: string;
  readonly scopes: readonly string[];
  readonly paths: readonly string[];
}

/** What the classifier needs to know about the project besides the check. */
export interface RoutingContext {
  readonly charter: CharterView;
  /** The scope a repository path falls in, from `penguin/scopes.json`. */
  readonly scopeOf: (path: string) => string | undefined;
  /** A scope's owner. */
  readonly ownerOf: (scope: string) => string | undefined;
  /** The identity of the scope owner whose charter holds the scope, or undefined when there is none. */
  readonly ownerAgentOf: (scope: string) => string | undefined;
  /** Rounds of fixes Penguin tries before the failure goes to a person (PRD section 7, default 3). */
  readonly roundLimit: number;
}

export interface FailureFacts {
  readonly check: BlockCheck;
  /** The target's scopes; empty for `main`, which stands for the originating change itself. */
  readonly targetScopes: readonly string[];
  /** The codemod the contract diff gives for the target, or null without a contract diff. */
  readonly codemod: CodemodPlan | null;
  /** Fixes Penguin already applied for this target and check that did not clear the failure. */
  readonly failedFixes: number;
  /** Rounds of fixes already run on this block. */
  readonly round: number;
}

export interface LadderActor {
  readonly kind: LadderActorKind;
  /** `penguin`, an identity handle or a person id. */
  readonly id: string;
}

/** One failing check's next step. */
export interface LadderDecision {
  readonly target: string;
  readonly check: BlockCheckName;
  readonly failure: FailureKind;
  readonly step: LadderStepNumber;
  readonly nextStep: string;
  readonly actor: LadderActor;
  /** The fix Penguin applies, for steps 1 to 3. */
  readonly fix: { readonly kind: FixKind; readonly commandId: string } | null;
  /** Why the classifier chose the step, in one line. */
  readonly reason: string;
  /** The failing check's summary and first findings, attached for the agent or person. */
  readonly evidence: { readonly summary: string; readonly findings: readonly BlockCheckFinding[] };
}

/** The failure kind of a failed or erred check, before charter and round limits apply. */
export function failureKind(facts: FailureFacts): FailureKind {
  const { check } = facts;
  if (check.result === "error") return "tool-error";
  if (check.check === "format") return "formatting";
  if (check.check === "lint") return "lint";
  if (check.check === "merge") {
    const paths = check.findings.map((finding) => finding.path);
    const lockfiles = paths.length > 0 && check.findingCount === paths.length && paths.every((path) => path !== null && REGENERATED_LOCKFILES.has(baseName(path)));
    return lockfiles ? "lockfile-conflict" : "behaviour";
  }
  if ((check.check === "tests" || check.check === "typecheck") && facts.codemod !== null && facts.codemod.edits.length > 0) {
    return facts.codemod.kinds[0] as FailureKind;
  }
  return "behaviour";
}

/**
 * Classifies one failed or erred check into exactly one next step for one actor. A step Penguin
 * takes whose fix already failed for this target and check counts as a behaviour change; past the
 * round limit, the failure goes to the originating feature's person.
 */
export function classifyFailure(facts: FailureFacts, context: RoutingContext): LadderDecision {
  const { check } = facts;
  let failure = failureKind(facts);
  let reason = reasonFor(failure, facts);
  let route = ladderRoute(check.check, failure);
  if (route.fix !== undefined && facts.failedFixes > 0) {
    reason = `Penguin's ${route.fix} fix did not clear it; ${reason}`;
    failure = "behaviour";
    route = ladderRoute(check.check, failure);
  }
  if (route.fix !== undefined && facts.round >= context.roundLimit) {
    reason = `${facts.round} rounds of fixes reached the project's limit of ${context.roundLimit}`;
    failure = "round-limit";
    route = ladderRoute(check.check, failure);
  }

  let step = route.step;
  let actor: LadderActor = { kind: "penguin", id: "penguin" };
  if (step === 6) actor = { kind: "person", id: context.charter.person };
  if (route.outsideCharter !== undefined) {
    const places = failingPlaces(check, facts.targetScopes, context);
    const outside = places.filter((place) => !insideCharter(place, context));
    if (outside.length === 0) {
      actor = { kind: "originating-agent", id: context.charter.handle };
      reason = `${reason}; the failing place lies inside ${context.charter.handle}'s charter`;
    } else {
      const scope = outside.map((place) => place.scope).find((value) => value !== undefined);
      const owner = scope === undefined ? undefined : context.ownerOf(scope);
      const agent = scope === undefined ? undefined : context.ownerAgentOf(scope);
      if (agent !== undefined) {
        step = route.outsideCharter;
        actor = { kind: "owner-agent", id: agent };
        reason = `${reason}; ${describePlace(outside[0] as Place)} lies outside ${context.charter.handle}'s charter, in ${scope}`;
      } else {
        step = 6;
        actor = { kind: "person", id: owner ?? context.charter.person };
        reason =
          `${reason}; ${describePlace(outside[0] as Place)} lies outside ${context.charter.handle}'s charter` +
          (scope === undefined ? " and in no scope" : ` and no identity of ${owner ?? "its owner"} holds ${scope}`);
      }
    }
  }
  const row = ladderStep(step);
  const fix = step <= 3 && route.fix !== undefined ? { kind: route.fix, commandId: FIX_COMMAND_IDS[route.fix] } : null;
  return {
    target: check.target,
    check: check.check,
    failure,
    step,
    nextStep: row.nextStep,
    actor,
    fix,
    reason,
    evidence: { summary: check.summary, findings: check.findings },
  };
}

interface Place {
  readonly path: string | null;
  readonly scope: string | undefined;
}

/** The files a failing check names, or the target's scopes when it names none. */
function failingPlaces(check: BlockCheck, targetScopes: readonly string[], context: RoutingContext): Place[] {
  const paths = [...new Set(check.findings.map((finding) => finding.path).filter((path): path is string => path !== null))];
  if (paths.length > 0) return paths.map((path) => ({ path, scope: context.scopeOf(path) }));
  return targetScopes.map((scope) => ({ path: null, scope }));
}

function insideCharter(place: Place, context: RoutingContext): boolean {
  const { scopes, paths } = context.charter;
  if (place.scope !== undefined && scopes.includes(place.scope)) return true;
  const path = place.path;
  return path !== null && paths.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/+$/u, "")}/`));
}

function describePlace(place: Place): string {
  return place.path ?? `scope ${place.scope ?? "unknown"}`;
}

function reasonFor(failure: FailureKind, facts: FailureFacts): string {
  const { check } = facts;
  switch (failure) {
    case "tool-error":
      return `the ${check.check} check could not run: ${check.summary}`;
    case "formatting":
      return `${check.findingCount} file${check.findingCount === 1 ? "" : "s"} to reformat`;
    case "lint":
      return `${check.findingCount} new lint finding${check.findingCount === 1 ? "" : "s"}`;
    case "lockfile-conflict":
      return "the merge conflicts only in the lockfile";
    case "rename":
    case "move":
    case "signature": {
      const edits = facts.codemod?.edits ?? [];
      return `the contract diff shows ${edits.map(describeEdit).join(", ")}, used in ${facts.codemod?.paths.length ?? 0} file(s) of ${check.target}`;
    }
    default:
      return `${check.check} failed: ${check.summary}`;
  }
}

export function describeEdit(edit: CodemodEdit): string {
  if (edit.kind === "rename-parameter") return `parameter ${edit.from} of ${edit.function} renamed to ${edit.to}`;
  return `${edit.from} ${edit.kind === "rename" ? "renamed" : "moved"} to ${edit.to}`;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// Records of each tool run and each ladder decision, so a feature page or a demo shows them.

/** Who called a tool: Penguin's ladder, or an agent identity's session. */
export type ToolCaller = "penguin" | `@${string}`;

export type ToolRunResult = "found" | "changed" | "unchanged" | "refused" | "error" | "waiting";

/** One run of an agent tool: the tool, its input, and what it found or changed. */
export interface ToolRunRecord {
  readonly id: string;
  readonly tool: AgentToolName;
  readonly caller: ToolCaller;
  /** The fixed program's command ID, when one ran. */
  readonly commandId: string | null;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: ToolRunResult;
  /** One line that says what the tool found or changed. */
  readonly summary: string;
  readonly findings: readonly BlockCheckFinding[];
  /** For a fix: the commit it started from, the commit it made and the files it changed. */
  readonly changed: { readonly before: string; readonly after: string; readonly paths: readonly string[] } | null;
  readonly durationMs: number;
}

/** A ladder decision with the round it was made in and what became of the fix it applied. */
export interface RecordedDecision extends LadderDecision {
  readonly round: number;
  /** The tool run that applied the fix, for steps 1 to 3. */
  readonly fixRun: string | null;
  /**
   * `routed`: the step goes to an agent or a person. `applied`: Penguin's fix made a commit and the
   * next round checks it. `accepted`: the next round's checks no longer show the failure.
   * `not-cleared`: they still do. `refused`: the fix could not be applied.
   */
  readonly outcome: "routed" | "applied" | "accepted" | "not-cleared" | "refused";
}

/** The ladder's run on one block: every decision and tool run, with the counts PRD section 11 measures. */
export interface ResolutionRecord {
  readonly rounds: number;
  readonly decisions: readonly RecordedDecision[];
  readonly toolRuns: readonly ToolRunRecord[];
  /** Failures cleared by Penguin's steps 1 to 3. */
  readonly resolvedByPenguin: number;
  /** Failures left for an agent (steps 4 and 5) or a person (step 6) after the last round. */
  readonly routedToAgents: number;
  readonly routedToPeople: number;
  /** Tool calls an agent made during the resolution; the ladder itself calls none. */
  readonly agentCalls: number;
  readonly durationMs: number;
}
