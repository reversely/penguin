// Merge plans (PRD 0.4 sections 4.2 and 9): the facts Penguin supplies for a plan and the plan
// itself, as they cross the network.
//
// The check runner produces the facts that need the code read or run: the impact graph and contract
// diff (`analysis:python-impact`), and each break, a test that fails once the originating checkpoint
// is merged onto main or onto a running feature's checkpoint, with the test's docstring and the
// assertion line pytest printed. Penguin asks for them with a `PlanFactsRequest` and the runner
// answers with a `PlanFactsReport`. The Worker reads the rest through the Artifacts binding: the
// checkpoint's commit subject and each part's changed lines.
//
// Every string that comes from a repository or a test run (commit subjects, docstrings, assertion
// lines, diff lines) is length-limited here and stored as data. Nothing in a plan is ever run or
// rendered as markup.

import { IMPACT_REPORT_SCHEMA, type ImpactReport, type ImpactUse } from "./impact.ts";
import { FINGERPRINT_PATTERN } from "./operation-schema.ts";
import { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";

export const PLAN_SCHEMA_VERSION = 1;

/** PRD 4.2 step 5: a plan may touch at most this many running features unless the project says otherwise. */
export const PLAN_BREAK_LIMIT_DEFAULT = 10;

/**
 * PRD section 7: past this many requested changes on one part, the next request goes to the
 * originating feature's person instead of back to the agent, unless the project says otherwise.
 */
export const PLAN_ROUND_LIMIT_DEFAULT = 3;

/** The target of a facts run that stands for main: the originating checkpoint merged onto main. */
export const PLAN_MAIN_TARGET = "main";

export const PLAN_LIMITS = {
  /** Parts in one plan. */
  parts: 128,
  /** Characters of an agent's note on a part. */
  noteLength: 2_000,
  /** Characters kept of a commit subject. */
  subjectLength: 300,
  /** Characters kept of a test's docstring. */
  docstringLength: 500,
  /** Characters kept of an assertion or error line. */
  failureLineLength: 300,
  /** Targets in one facts run: main plus the running features. */
  targets: 129,
  /** Test commands run on one target. */
  commandsPerTarget: 64,
  /** Breaks kept for one test command on one target. */
  breaksPerResult: 50,
  /** Files kept in one part's diff. */
  diffFiles: 60,
  /** Diff lines kept across one part's files. */
  diffLines: 600,
  /** Characters kept of one diff line. */
  diffLineLength: 500,
  /** A blob larger than this is listed without hunks. */
  diffBlobBytes: 256 * 1024,
  /** Lines of context around each change. */
  diffContext: 3,
  /** Characters of an author's request for a change to a part. */
  changeRequestLength: 2_000,
} as const;

export const PLAN_PART_KINDS = ["mechanical", "behavioural"] as const;
export type PlanPartKind = (typeof PLAN_PART_KINDS)[number];

/** `passed`, `failed`: the tests ran on the merged tree. `not-affected`: the impact graph shows no use, so they did not run. */
export const PLAN_RESULT_STATUSES = ["passed", "failed", "conflict", "not-affected", "not-run"] as const;
export type PlanResultStatus = (typeof PLAN_RESULT_STATUSES)[number];

/** One place a facts run merges the originating checkpoint onto. */
export interface PlanFactsTarget {
  /** `main`, or the running feature's id: each running feature is a target of its own. */
  readonly id: string;
  /** The feature's person, who approves the feature's plan part; null for main. */
  readonly person: string | null;
  /** The fork the target's commit is fetched from, without the deployment's prefix: `feature-<id>`. */
  readonly repo: string;
  readonly sha: string;
  /** The scopes searched for uses of a changed symbol; empty for main, whose uses are the head uses. */
  readonly scopes: readonly string[];
  /** The allowlisted test commands, `test:<scope id>`, run on the merged tree. */
  readonly commandIds: readonly string[];
}

/** What Penguin asks the check runner for: the facts of one feature checkpoint. */
export interface PlanFactsRequest {
  readonly runId: string;
  readonly feature: string;
  /** The originating feature's fork, which holds the checkpoint and its baseline. */
  readonly fork: string;
  readonly checkpoint: string;
  /** The commit on main the checkpoint was built on; the change is baseline to checkpoint. */
  readonly baseline: string;
  readonly targets: readonly PlanFactsTarget[];
}

/** A test that fails on a merged tree, in the words its repository and its run give. */
export interface PlanBreak {
  /** The pytest node ID, such as `analytics/tests/test_weekly.py::test_counts_each_day_of_the_week`. */
  readonly nodeId: string;
  /** The test's docstring at the merged commit, folded onto one line, or null when it has none. */
  readonly docstring: string | null;
  /** The source line pytest marked with `>`: where the test stopped. */
  readonly assertion: string | null;
  /** The first `E` line pytest printed: what went wrong. */
  readonly error: string | null;
}

export interface PlanFactsFingerprint {
  readonly id: string;
  readonly commit: string;
  readonly lockfileHash: string;
  readonly commandId: string;
}

/** One test command's outcome on one target's merged tree. */
export interface PlanFactsResult {
  readonly target: string;
  readonly scopeId: string;
  readonly commandId: string;
  readonly status: PlanResultStatus;
  /** The merged commit the tests ran on; null for a conflict. */
  readonly merged: string | null;
  readonly fingerprint: PlanFactsFingerprint | null;
  readonly breaks: readonly PlanBreak[];
  /** Why nothing ran, for `conflict` and `not-run`. */
  readonly reason: string | null;
  readonly durationMs: number;
}

/** What the check runner answers: the impact report and each test command's result. */
export interface PlanFactsReport {
  /** The impact graph and contract diff, with one fork per running-feature target; null when the analysis failed. */
  readonly impact: ImpactReport | null;
  readonly impactError: string | null;
  readonly results: readonly PlanFactsResult[];
  readonly durationMs: number;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" };
const SHORT = { type: "string", minLength: 1, maxLength: 128 };
const LINE = (max: number) => ({ anyOf: [{ type: "string", maxLength: max }, { type: "null" }] });
const record = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
// The impact report's schema without its document annotations, nested as one field.
const { $schema: _schema, title: _title, ...IMPACT_FIELD } = IMPACT_REPORT_SCHEMA;

/** JSON Schema (draft 2020-12) for the runner's report of one facts run. */
export const PLAN_FACTS_REPORT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Penguin plan facts",
  ...record({
    impact: { anyOf: [IMPACT_FIELD, { type: "null" }] },
    impactError: LINE(4_096),
    results: {
      type: "array",
      maxItems: PLAN_LIMITS.targets * PLAN_LIMITS.commandsPerTarget,
      items: record({
        target: { type: "string", pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$", maxLength: 63 },
        scopeId: SHORT,
        commandId: { type: "string", pattern: "^test:[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
        status: { type: "string", enum: [...PLAN_RESULT_STATUSES] },
        merged: { anyOf: [SHA, { type: "null" }] },
        fingerprint: {
          anyOf: [
            record({
              id: { type: "string", pattern: `^${FINGERPRINT_PATTERN}$` },
              commit: SHA,
              lockfileHash: { type: "string", pattern: `^${FINGERPRINT_PATTERN}$` },
              commandId: { type: "string", maxLength: 64 },
            }),
            { type: "null" },
          ],
        },
        breaks: {
          type: "array",
          maxItems: PLAN_LIMITS.breaksPerResult,
          items: record({
            nodeId: { type: "string", minLength: 1, maxLength: 512 },
            docstring: LINE(PLAN_LIMITS.docstringLength),
            assertion: LINE(PLAN_LIMITS.failureLineLength),
            error: LINE(PLAN_LIMITS.failureLineLength),
          }),
        },
        reason: LINE(PLAN_LIMITS.failureLineLength),
        durationMs: { type: "integer", minimum: 0 },
      }),
    },
    durationMs: { type: "integer", minimum: 0 },
  }),
};

/** Where a value breaks PLAN_FACTS_REPORT_SCHEMA; empty when it is a valid report. */
export function checkPlanFactsReport(value: unknown): SchemaError[] {
  return checkSchema(PLAN_FACTS_REPORT_SCHEMA, value);
}

/** One changed region of a file, as a unified diff hunk: each line prefixed with " ", "-" or "+". */
export interface PlanHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/** One file of a part's diff, inside the part's scopes. */
export interface PlanFileDiff {
  readonly path: string;
  readonly scopeId: string | null;
  readonly status: "added" | "deleted" | "modified";
  readonly hunks: readonly PlanHunk[];
  /** Why no hunks are shown: a binary file or one over the size cap; null when they are. */
  readonly omitted: "binary" | "too_large" | null;
}

/** Where a part's fix goes (PRD 4.2 step 3). */
export type PlanPlace =
  /** Code already on main in another scope: fixed in the originating feature's fork. */
  | { readonly kind: "scope"; readonly scope: string }
  /** Unfinished work in a running feature: fixed in that feature's fork. */
  | { readonly kind: "feature"; readonly feature: string };

/** A break as a plan states it: what the test protects, in the repository's words, and how it failed. */
export interface PlanBreakFact {
  /** `main` or the running feature the originating checkpoint was merged onto. */
  readonly target: string;
  readonly scopeId: string;
  readonly commandId: string;
  readonly nodeId: string;
  /** The test's docstring, or its function name in words when it has none. */
  readonly statement: string;
  readonly statementFrom: "docstring" | "test_name";
  readonly assertion: string | null;
  readonly error: string | null;
  readonly fingerprint: string | null;
}

export interface PlanInvariantFact {
  readonly scopeId: string;
  readonly id: string;
  readonly statement: string;
  readonly protected: boolean;
}

/**
 * Where one part's approval stands (PRD 4.3 step 3). `pending`: the part's current revision waits for
 * its author. `approved`: the author approved that revision. `change_requested`: the author asked for
 * a change, which goes back to the originating agent. `round_limit`: the author asked for one change
 * more than the project's round limit, so the part waits on the originating feature's person.
 */
export const PLAN_PART_STATES = ["pending", "approved", "change_requested", "round_limit"] as const;
export type PlanPartState = (typeof PLAN_PART_STATES)[number];

/** An author's request for a change to one revision of a part. */
export interface PlanChangeRequest {
  /** The person who asked: the part's owner or that owner's delegate. */
  readonly by: string;
  /** The revision the request concerns. */
  readonly revision: number;
  /** What the author asks for, in their words; data, never an instruction to Penguin. */
  readonly text: string;
  readonly at: string;
  /** The signed `request_plan_change` record. */
  readonly recordId: string;
}

export interface PlanPart {
  readonly partId: string;
  /** 1 as proposed; each revision the originating agent makes after a requested change adds one. */
  readonly revision: number;
  readonly place: PlanPlace;
  /** The person who approves the part: the scope's owner or the feature's person. */
  readonly owner: string;
  /** The scopes of the place the change affects; the part's diff is read only inside them. */
  readonly scopes: readonly string[];
  readonly kind: PlanPartKind;
  /** Why Penguin classified the fix this way, from the diff and the contract diff. */
  readonly kindReason: string;
  /**
   * The proposed fix. For code on main: a commit in the originating fork against its base, read
   * through Artifacts. For a running feature: a patch against that feature's fork head, kept whole
   * so the fix can be written into the fork once its person approves.
   */
  readonly diff: {
    readonly source: "commit" | "patch";
    /** The fork the fix is read from (a commit) or written into (a patch). */
    readonly repo: string;
    /** `<repo>@<commit>`, or `<repo>@<base>+patch:sha256:<hex>` for a patch: how records name the fix. */
    readonly ref: string;
    /** The commit holding the fix, or null for a patch. */
    readonly commit: string | null;
    /** The commit the fix applies to: the commit's base, or the feature's fork head for a patch. */
    readonly base: string | null;
    /** The patch as the agent submitted it, or null for a commit. */
    readonly patch: string | null;
    readonly files: readonly PlanFileDiff[];
    /** True when a file or line was cut at PLAN_LIMITS; a patch is never cut. */
    readonly truncated: boolean;
  };
  /** Uses of a changed symbol in this place: callers on main, or in the feature's fork. */
  readonly callers: readonly ImpactUse[];
  readonly breaks: readonly PlanBreakFact[];
  readonly invariants: readonly PlanInvariantFact[];
  /** The originating agent's note on the part, or null. */
  readonly note: string | null;
  readonly approvalState: PlanPartState;
  /** The person whose approval of the current revision is recorded, or null. */
  readonly approvedBy: string | null;
  /** The changes the author asked for on this part so far, one per round. */
  readonly changeRequests: number;
  /** The latest requested change, or null before the first. */
  readonly changeRequest: PlanChangeRequest | null;
}

/** A running feature the change reaches, and how Penguin knows. */
export interface PlanAffectedFeature {
  readonly feature: string;
  readonly person: string;
  /** The feature's fork head the facts run tested: the commit a part's patch must apply to. */
  readonly head: string;
  readonly scopes: readonly string[];
  /** Uses of a changed symbol in the feature's fork. */
  readonly uses: number;
  readonly breaks: number;
  /** The feature reads a scope the change touches, by a declared scope dependency. */
  readonly dependsOn: readonly string[];
}

/** Which tool or read produced each fact, so the plan shows how it was found. */
export interface PlanFactSource {
  readonly fact: "change" | "contract_diff" | "callers" | "affected_features" | "invariants" | "breaks" | "changed_lines";
  readonly tool: string;
  readonly detail: string;
}

export interface PlanFacts {
  /** The change in plain words: the checkpoint commit's subject and the identity that reported it. */
  readonly change: {
    readonly checkpoint: string;
    readonly baseline: string;
    readonly subject: string;
    readonly madeBy: string;
  };
  /** The contract diff from the impact report; null while the check runner has not reported it. */
  readonly contractDiff: {
    readonly base: string;
    readonly head: string;
    readonly complete: boolean;
    readonly contracts: readonly string[];
    readonly changes: ImpactReport["changes"];
    readonly signatures: ImpactReport["signatures"];
    readonly removedExports: ImpactReport["removedExports"];
    readonly dataShapes: ImpactReport["dataShapes"];
  } | null;
  /** Callers already on main, outside the changed files. */
  readonly mainCallers: readonly ImpactUse[];
  readonly affectedFeatures: readonly PlanAffectedFeature[];
  readonly invariants: readonly PlanInvariantFact[];
  readonly breaks: readonly PlanBreakFact[];
  readonly sources: readonly PlanFactSource[];
  /** The facts run the runner reported, or null while it waits. */
  readonly run: { readonly runId: string; readonly durationMs: number; readonly reportedAt: string } | null;
}

export type PlanState = "proposed";

export interface Plan {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly featureId: string;
  readonly version: number;
  readonly state: PlanState;
  readonly person: string;
  /** The identity of the session that proposed it. */
  readonly proposedBy: string;
  readonly proposedAt: string;
  /** The signed record the plan is kept under. */
  readonly recordId: string;
  readonly breakLimit: number;
  readonly facts: PlanFacts;
  readonly parts: readonly PlanPart[];
  /** How long Penguin took to assemble the facts and parts, in milliseconds. */
  readonly assembledMs: number;
}

/** The plan's id: the feature and the plan's version. */
export function planId(featureId: string, version: number): string {
  return `${featureId}/v${version}`;
}

/** A place as one line: `scope analytics` or `feature jun-weekly-report`. */
export function placeLabel(place: PlanPlace): string {
  return place.kind === "scope" ? `scope ${place.scope}` : `feature ${place.feature}`;
}

/** A test's function name in words: `test_fires_at_the_local_hour` becomes `fires at the local hour`. */
export function testNameWords(nodeId: string): string {
  const last = nodeId.split("::").at(-1) ?? nodeId;
  const name = last.replace(/\[.*$/u, "").replace(/^test_?/u, "");
  return name.replaceAll("_", " ").trim();
}

/** The plan as text: the change, the facts with their tools, and each part with its breaks and hunks. */
export function formatPlan(plan: Plan): string {
  const { facts } = plan;
  const lines: string[] = [
    `Plan ${plan.planId} (${plan.state}) for feature ${plan.featureId}, proposed by ${plan.proposedBy}`,
    `Change: "${facts.change.subject}" by ${facts.change.madeBy} at ${facts.change.checkpoint.slice(0, 12)}`,
  ];
  for (const source of facts.sources) lines.push(`  ${source.fact}: ${source.tool} (${source.detail})`);
  const diff = facts.contractDiff;
  if (diff !== null) {
    lines.push(`Contract diff (${diff.complete ? "complete" : "incomplete"}):`);
    for (const change of diff.changes) {
      const contract = change.contract === null ? "" : ` [contract ${change.contract}]`;
      lines.push(`  ${change.change} ${change.kind} ${change.symbol} at ${change.path}:${change.line}${contract}`);
    }
    for (const signature of diff.signatures) {
      lines.push(`  signature ${signature.symbol}: ${signature.before} -> ${signature.after}${signature.breaking ? " (breaking)" : ""}`);
    }
  }
  for (const use of facts.mainCallers) lines.push(`  caller on main: ${use.path}:${use.line} ${use.kind} ${use.symbol}`);
  for (const feature of facts.affectedFeatures) {
    lines.push(`Affected feature ${feature.feature} (${feature.person}): ${feature.uses} uses, ${feature.breaks} breaks`);
  }
  for (const invariant of facts.invariants) {
    lines.push(`Invariant ${invariant.scopeId}/${invariant.id}${invariant.protected ? " (protected)" : ""}: ${invariant.statement}`);
  }
  for (const part of plan.parts) {
    lines.push("", `Part ${part.partId} revision ${part.revision} (${part.approvalState}): ${placeLabel(part.place)}, approved by ${part.owner}, ${part.kind}`);
    lines.push(`  why ${part.kind}: ${part.kindReason}`);
    for (const use of part.callers) lines.push(`  caller: ${use.path}:${use.line} ${use.kind} ${use.symbol}`);
    for (const each of part.breaks) {
      lines.push(`  breaks on ${each.target}: ${each.statement} (${each.nodeId})`);
      if (each.assertion !== null) lines.push(`    at: ${each.assertion}`);
      if (each.error !== null) lines.push(`    error: ${each.error}`);
    }
    const at = part.diff.source === "patch" ? `patch on ${part.diff.repo} at ${(part.diff.base ?? "").slice(0, 12)}` : `commit ${part.diff.repo}@${(part.diff.commit ?? "").slice(0, 12)}`;
    lines.push(`  proposed fix: ${at}:`);
    for (const file of part.diff.files) {
      lines.push(`    ${file.path} (${file.status})`);
      for (const hunk of file.hunks) {
        lines.push(`    @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) lines.push(`    ${line}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
