/**
 * The PRD section 11 metrics of one case, computed from what the run recorded: the feature's signed
 * records and plan as the dashboard answers them, the check runner's first `check` run, the main heads
 * after each promotion with every scope's tests run on them, and every MCP tool call the agents made.
 * Nothing here is typed in; each number is counted from those sources.
 */

/** One promotion and every scope's tests on main after it. */
export interface PromotionCheck {
  readonly feature: string;
  readonly mainBefore: string;
  readonly mainAfter: string;
  /** The scopes whose test command failed on main after the promotion. */
  readonly redScopes: readonly string[];
}

/** One failing check of the originating agent's first `check` run, with the ladder's step for it. */
export interface LadderDecision {
  readonly target: string;
  readonly check: string;
  readonly step: number;
  readonly actor: string;
}

export interface FixWriteEvidence {
  readonly part: string;
  readonly fork: string;
  readonly writer: string;
  readonly commit: string;
  /** Whether the written commit's tree equals the tree of the fixture's own fix commit. */
  readonly matchesFixture: boolean;
}

export interface CaseEvidence {
  readonly case: string;
  readonly prefix: string;
  readonly origin: { readonly feature: string; readonly person: string; readonly agent: string };
  readonly phases: readonly { readonly phase: string; readonly startedAt: string; readonly ms: number }[];
  readonly promotions: readonly PromotionCheck[];
  /** The originating feature's records as its page lists them after the promotion. */
  readonly records: readonly { readonly type: string; readonly author: string; readonly createdAt: string; readonly path: string }[];
  /** The plan's parts after the promotion. */
  readonly parts: readonly { readonly partId: string; readonly kind: string; readonly revision: number; readonly approvalState: string; readonly changeRequests: number; readonly place: Record<string, string> }[];
  /** The places the facts named when the plan was first proposed. */
  readonly placesAtPlanTime: number;
  readonly firstCheck: readonly LadderDecision[];
  /** Each agent's tool calls from the first `check` request through the promotion, by tool. */
  readonly agentCalls: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly fixWrites: readonly FixWriteEvidence[];
  /** Reviews whose record raised an exception for a person, by scope and kind. */
  readonly reviewExceptions: readonly { readonly scope: string; readonly kinds: readonly string[] }[];
  readonly notes: readonly string[];
}

/** A record a person signs by deciding on the dashboard. */
const PERSON_DECISIONS: ReadonlySet<string> = new Set(["approve_plan_part", "request_plan_change", "approve_overlap"]);
/** Ladder steps whose fix Penguin's tools apply (PRD 5.3). */
const DETERMINISTIC_STEPS = 3;
const PERSON_STEP = 6;

export interface CaseMetrics {
  readonly mainBreaks: { readonly value: number; readonly promotions: number; readonly definition: string };
  readonly peopleTouched: { readonly value: number; readonly people: number; readonly byPerson: Readonly<Record<string, Readonly<Record<string, number>>>>; readonly exceptions: number; readonly definition: string };
  readonly deterministicShare: {
    readonly value: number | null;
    readonly byStep: Readonly<Record<string, number>>;
    readonly planParts: { readonly mechanical: number; readonly behavioural: number };
    readonly fixWrites: Readonly<Record<string, number>>;
    readonly definition: string;
  };
  readonly agentCallsPerResolution: { readonly value: number | null; readonly calls: number; readonly resolved: number; readonly byTool: Readonly<Record<string, number>>; readonly definition: string };
  readonly planAccuracy: { readonly value: number | null; readonly atPlanTime: number; readonly foundLater: number; readonly definition: string };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

export function caseMetrics(evidence: CaseEvidence): CaseMetrics {
  const decisions = evidence.records.filter((record) => PERSON_DECISIONS.has(record.type));
  const byPerson: Record<string, Record<string, number>> = {};
  for (const record of decisions) {
    byPerson[record.author] = { ...byPerson[record.author], [record.type]: (byPerson[record.author]?.[record.type] ?? 0) + 1 };
  }
  const steps = evidence.firstCheck.map((decision) => decision.step);
  const deterministic = steps.filter((step) => step <= DETERMINISTIC_STEPS).length;
  const byAgents = steps.filter((step) => step > DETERMINISTIC_STEPS && step < PERSON_STEP).length;
  const byTool: Record<string, number> = {};
  for (const tools of Object.values(evidence.agentCalls)) for (const [tool, count] of Object.entries(tools)) byTool[tool] = (byTool[tool] ?? 0) + count;
  const calls = Object.values(byTool).reduce((sum, count) => sum + count, 0);
  const resolved = evidence.firstCheck.length;
  const foundLater = evidence.records.filter((record) => record.type === "plan_part_added").length;
  return {
    mainBreaks: {
      value: evidence.promotions.filter((promotion) => promotion.redScopes.length > 0).length,
      promotions: evidence.promotions.length,
      definition: "Promotions after which any scope's test command failed on main's new head, run by the walkthrough on a fresh fetch of main. Target zero.",
    },
    peopleTouched: {
      value: decisions.length,
      people: Object.keys(byPerson).length,
      byPerson,
      exceptions: evidence.reviewExceptions.length,
      definition:
        "Decisions people signed on the landed feature: approve_plan_part, request_plan_change and approve_overlap records, by their author. `exceptions` counts the reviews whose record raised an exception for a person.",
    },
    deterministicShare: {
      value: deterministic + byAgents === 0 ? null : deterministic / (deterministic + byAgents),
      byStep: countBy(steps, (step) => `step ${step}`),
      planParts: {
        mechanical: evidence.parts.filter((part) => part.kind === "mechanical").length,
        behavioural: evidence.parts.filter((part) => part.kind === "behavioural").length,
      },
      fixWrites: countBy(evidence.fixWrites, (write) => write.writer),
      definition:
        "Failing checks of the originating agent's first `check` run resolved at ladder steps 1 to 3 (Penguin's formatter, lint autofix, lockfile or codemod) over those resolved at steps 4 and 5 (an agent). Every one was resolved, since the block later passed. `planParts` and `fixWrites` give the same split for the plan's fixes: mechanical parts are written by the check runner, behavioural ones by the originating agent.",
    },
    agentCallsPerResolution: {
      value: resolved === 0 ? null : calls / resolved,
      calls,
      resolved,
      byTool,
      definition:
        "MCP tool calls the agents made from the originating agent's first `check` request through the promotion, get_work reads left out, over the failing checks of that first `check` run.",
    },
    planAccuracy: {
      value: evidence.placesAtPlanTime + foundLater === 0 ? null : evidence.placesAtPlanTime / (evidence.placesAtPlanTime + foundLater),
      atPlanTime: evidence.placesAtPlanTime,
      foundLater,
      definition: "Affected places the facts named when the plan was proposed, over those plus the parts Penguin added later at a running feature's checkpoint (plan_part_added records).",
    },
  };
}

const percent = (value: number | null): string => (value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`);
const ratio = (value: number | null): string => (value === null ? "n/a" : String(Math.round(value * 100) / 100));

/** The case's metrics report as Markdown, for a reader of docs/progress. */
export function metricsReport(evidence: CaseEvidence, metrics: CaseMetrics, frames: readonly { file: string; person: string; question: string }[]): string {
  const total = evidence.phases.reduce((sum, phase) => sum + phase.ms, 0);
  const lines = [
    `# ${evidence.case}`,
    "",
    `The originating feature \`${evidence.origin.feature}\` of ${evidence.origin.person}, written by \`${evidence.origin.agent}\`. Repo prefix \`${evidence.prefix}\`.`,
    "",
    "## Metrics",
    "",
    "| Metric | Value | Counted from |",
    "|---|---|---|",
    `| Main breaks | ${metrics.mainBreaks.value} of ${metrics.mainBreaks.promotions} promotions | ${metrics.mainBreaks.definition} |`,
    `| People touched | ${metrics.peopleTouched.value} decisions by ${metrics.peopleTouched.people} people; ${metrics.peopleTouched.exceptions} review exceptions | ${metrics.peopleTouched.definition} |`,
    `| Deterministic share | ${percent(metrics.deterministicShare.value)} (${Object.entries(metrics.deterministicShare.byStep).map(([step, count]) => `${step}: ${count}`).join(", ") || "no failing check"}); plan parts ${metrics.deterministicShare.planParts.mechanical} mechanical, ${metrics.deterministicShare.planParts.behavioural} behavioural | ${metrics.deterministicShare.definition} |`,
    `| Agent calls per resolution | ${ratio(metrics.agentCallsPerResolution.value)} (${metrics.agentCallsPerResolution.calls} calls, ${metrics.agentCallsPerResolution.resolved} failures) | ${metrics.agentCallsPerResolution.definition} |`,
    `| Plan accuracy | ${percent(metrics.planAccuracy.value)} (${metrics.planAccuracy.atPlanTime} at plan time, ${metrics.planAccuracy.foundLater} later) | ${metrics.planAccuracy.definition} |`,
    "",
    "## People's decisions",
    "",
    "| Person | Decisions |",
    "|---|---|",
    ...Object.entries(metrics.peopleTouched.byPerson).map(([person, kinds]) => `| ${person} | ${Object.entries(kinds).map(([kind, count]) => `${kind} ${count}`).join(", ")} |`),
    "",
    "## Time",
    "",
    "| Phase | Seconds |",
    "|---|---|",
    ...evidence.phases.map((phase) => `| ${phase.phase} | ${(phase.ms / 1000).toFixed(1)} |`),
    `| Total | ${(total / 1000).toFixed(1)} |`,
    "",
    "## Fixes written into other forks",
    "",
    "| Part | Fork | Writer | Commit | Tree equals the fixture's fix |",
    "|---|---|---|---|---|",
    ...evidence.fixWrites.map((write) => `| ${write.part} | ${write.fork} | ${write.writer} | ${write.commit.slice(0, 12)} | ${write.matchesFixture ? "yes" : "no"} |`),
    "",
    "## Frames",
    "",
    "| Frame | Seat | Question |",
    "|---|---|---|",
    ...frames.map((frame) => `| ${frame.file.split("/").at(-1)} | ${frame.person} | ${frame.question} |`),
    "",
    ...(evidence.notes.length === 0 ? [] : ["## Notes", "", ...evidence.notes.map((note) => `- ${note}`), ""]),
  ];
  return `${lines.join("\n")}\n`;
}
