// The feature's merge as a timeline bar (#124): one node per stage with its status and count, the
// current stage marked. Work that reached another person or their agent hangs from the stage where it
// happened as one branch per person (#137): the person's agent, the count of their parts and edit
// tasks and the most urgent tag, opening to one line per item with a link to the part's diff. A
// branch of one item shows the item on its line. A settled branch
// has rejoined the bar and shows as the person's avatar beside the stage. A node opens its stage in the
// page's Pipeline view, where each job shows one line; failed and person-needed jobs show their facts.
// GitHub Actions draws a run the same way: "An icon to the left of the job name indicates the status
// of the job" (docs/research/github-actions-visualization-graph.md). Every value renders as text.

import type { EditTaskView, FeaturePipeline, PipelineJob, PipelineStage, PipelineStageKey, PipelineStrip } from "@penguin/protocol";
import { useState } from "react";

import { Agent } from "./agent-directory.tsx";
import { PersonAvatar } from "./avatar.tsx";
import { counted, partNumber, shortSha } from "./feature-view.ts";
import { Icon } from "./icon.tsx";
import { stageAnchor } from "./page-view.ts";
import {
  ASK_REASON_LABEL,
  branchRows,
  currentStageText,
  groupCount,
  jobText,
  partAnchor,
  settledAt,
  STAGE_LABEL,
  stageCount,
  STATUS_LABEL,
  taskText,
  taskVia,
  type BranchItem,
  type BranchRow,
} from "./pipeline-view.ts";

/** Branch rows shown before a "more" button. */
const BRANCH_CAP = 6;

interface TimelineProps {
  readonly pipeline: FeaturePipeline;
  /** The feature's id, whose own edit tasks hang as branches. */
  readonly feature: string;
  /** The page's edit tasks (`editTasks`). */
  readonly tasks: readonly EditTaskView[];
  /** Opens and scrolls to an element of the page by id, such as a part's node in the change tree. */
  readonly reveal: (id: string) => void;
}

export function Timeline({ pipeline, feature, tasks, reveal }: TimelineProps) {
  const [all, setAll] = useState(false);
  const rows = branchRows(pipeline, feature, tasks);
  const shown = all ? rows : rows.slice(0, BRANCH_CAP);
  const columns = `cols-${pipeline.stages.length}`;
  return (
    <section className="timeline" aria-label="Pipeline">
      <ol className={`timeline-bar ${columns}`}>
        {pipeline.stages.map((each, index) => (
          <StageNode
            key={each.key}
            stage={each}
            pipeline={pipeline}
            current={index === pipeline.current}
            branches={rows.some((row) => row.column === index)}
            onOpen={() => reveal(stageAnchor(each.key))}
          />
        ))}
      </ol>
      {rows.length === 0 ? null : (
        <ol className="branches" aria-label="Other people">
          {shown.map((row) => (
            <Branch key={row.group.key} row={row} columns={columns} pipeline={pipeline} reveal={reveal} />
          ))}
        </ol>
      )}
      {rows.length > shown.length ? (
        <button type="button" className="button quiet show-more" onClick={() => setAll(true)}>
          {rows.length - shown.length} more
        </button>
      ) : null}
    </section>
  );
}

interface NodeProps {
  readonly stage: PipelineStage;
  readonly pipeline: FeaturePipeline;
  readonly current: boolean;
  /** Whether open branches hang from the stage, which then runs a rail down to them. */
  readonly branches: boolean;
  /** Opens the stage in the Pipeline view. */
  readonly onOpen: () => void;
}

function StageNode({ stage, pipeline, current, branches, onOpen }: NodeProps) {
  const count = stageCount({ passed: stage.jobs.filter((job) => job.status === "passed").length, jobs: stage.jobs.length });
  const settled = settledAt(pipeline, stage.key);
  const exception = stage.status === "failed" || stage.status === "person";
  return (
    <li className="stage" data-status={stage.status} data-current={current ? true : undefined} data-branches={branches ? true : undefined} aria-current={current ? "step" : undefined}>
      <a
        className="stage-node"
        href={`#${stageAnchor(stage.key)}`}
        onClick={(event) => {
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="stage-dot" aria-hidden="true" />
        <span className="stage-name">{STAGE_LABEL[stage.key]}</span>
        <span className="stage-meta">
          {count}
          {exception ? <span className="stage-status"> {STATUS_LABEL[stage.status]}</span> : <span className="visually-hidden"> {STATUS_LABEL[stage.status]}</span>}
        </span>
        {settled.length === 0 ? null : <Rejoined people={settled} />}
      </a>
    </li>
  );
}

/** The people whose branch settled at a stage, as avatars on the bar. */
function Rejoined({ people: settled }: { readonly people: readonly string[] }) {
  return (
    <>
      {settled.length === 0 ? null : (
        <span className="stage-rejoined" title={settled.join(" ")}>
          {settled.slice(0, 4).map((person) => (
            <PersonAvatar key={person} id={person} size="card" />
          ))}
          <span className="visually-hidden">Settled {settled.join(" ")}</span>
          {settled.length > 4 ? <span className="stage-rejoined-more">{settled.length - 4}</span> : null}
        </span>
      )}
    </>
  );
}

function jobOf(pipeline: FeaturePipeline, key: string): PipelineJob | undefined {
  for (const stage of pipeline.stages) for (const job of stage.jobs) if (job.key === key) return job;
  return undefined;
}

/**
 * One person's branch at one stage: its rails, then the person's agent, the count of their items and
 * the most urgent tag. A branch of one item shows the item on its line and opens to its fact; a branch
 * of several opens to one line per item.
 */
function Branch({ row, columns, pipeline, reveal }: { readonly row: BranchRow; readonly columns: string; readonly pipeline: FeaturePipeline; readonly reveal: (id: string) => void }) {
  const { group } = row;
  const single = group.items.length === 1 ? (group.items[0] as BranchItem) : null;
  const count = groupCount(group);
  const [open, setOpen] = useState(false);
  return (
    <li className={`branch-row ${columns}`}>
      {row.cells.slice(0, -1).map((cell, index) => (cell === "rail" ? <span key={index} className={`rail col-${index + 1}`} aria-hidden="true" /> : null))}
      <details className={`branch col-from-${row.column + 1}`} data-rail={row.cells.at(-1)} data-label={group.label} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="branch-stage">{STAGE_LABEL[group.stage]}</span>
          <Who agent={group.agent} person={group.person} />
          {count === null ? null : <span className="branch-count">{count}</span>}
          <ItemTag label={group.label} urgency={group.urgency} />
          {single === null ? (
            <span className="disclosure-mark">
              <Icon name="chevron" />
            </span>
          ) : (
            <ItemPlace item={single} pipeline={pipeline} reveal={reveal} />
          )}
        </summary>
        {!open ? null : single === null ? (
          <ul className="branch-items" aria-label={`${group.person} at ${STAGE_LABEL[group.stage]}`}>
            {group.items.map((item) => (
              <li key={item.key} className="branch-item">
                {group.agent === null ? <Who agent={item.agent} person={group.person} /> : null}
                <ItemTag label={item.label} urgency={item.urgency} />
                <ItemPlace item={item} pipeline={pipeline} reveal={reveal} />
              </li>
            ))}
          </ul>
        ) : (
          <ItemFact item={single} stage={group.stage} pipeline={pipeline} />
        )}
      </details>
    </li>
  );
}

/** The agent that took the work, or the person before one has. */
function Who({ agent, person }: { readonly agent: string | null; readonly person: string }) {
  if (agent !== null) return <Agent handle={agent} person={person} variant="compact" />;
  return (
    <span className="approval-person">
      <PersonAvatar id={person} size="card" />
      {person}
    </span>
  );
}

function ItemTag({ label, urgency }: { readonly label: string; readonly urgency: number }) {
  return <span className={urgency === 0 ? "tag tag-attention" : "tag"}>{label}</span>;
}

/**
 * Where an item points: a part's number and place, which opens its diff, or a task's kind and place
 * with the kind of identity that took it when the agent's name does not say it.
 */
function ItemPlace({ item, pipeline, reveal }: { readonly item: BranchItem; readonly pipeline: FeaturePipeline; readonly reveal: (id: string) => void }) {
  if (item.task !== null) {
    const via = taskVia(item.task);
    return (
      <span className="branch-task">
        {via === null ? null : <span className="muted">{via}</span>}
        {taskText(item.task)}
      </span>
    );
  }
  if (item.partId === null) return null;
  const anchor = partAnchor(item.partId);
  return (
    <a
      className="branch-diff"
      href={`#${anchor}`}
      onClick={(event) => {
        event.preventDefault();
        reveal(anchor);
      }}
    >
      {partLabel(item.partId, jobOf(pipeline, item.key))}
    </a>
  );
}

/** A lone item's fact under its branch: the job's fact, or why a task's person is asked or how its run ended. */
function ItemFact({ item, stage, pipeline }: { readonly item: BranchItem; readonly stage: PipelineStageKey; readonly pipeline: FeaturePipeline }) {
  const fact = itemFact(item, pipeline);
  if (fact === null) return null;
  return (
    <p className="branch-fact">
      <span className="muted">{STAGE_LABEL[stage]}</span> {fact}
    </p>
  );
}

function itemFact(item: BranchItem, pipeline: FeaturePipeline): string | null {
  const { task } = item;
  if (task !== null) return task.askReason === null ? task.outcome : ASK_REASON_LABEL[task.askReason];
  const job = jobOf(pipeline, item.key);
  return job === undefined ? null : jobText(job.fact).fact;
}

/** A part as its branch links it: its number and place, `#1 analytics`. */
function partLabel(partId: string, job: PipelineJob | undefined): string {
  return job === undefined ? partNumber(partId) : jobText(job.fact).label;
}

/** Where a job's facts open on the page: its part's diff, the reviews or the block checks. */
function jobTarget(job: PipelineJob): { readonly id: string; readonly text: string } | null {
  const { fact } = job;
  if (fact.kind === "part" || fact.kind === "write") return { id: partAnchor(fact.partId), text: "Diff" };
  if (fact.kind === "group" && fact.partId !== null) return { id: partAnchor(fact.partId), text: "Diff" };
  // A passed check needs no link: its row says all there is.
  if ((fact.kind === "check" || fact.kind === "block") && job.status === "failed") return { id: "checks", text: "Results" };
  if (fact.kind === "plan" && fact.planId !== null) return { id: "changes", text: "Changes" };
  return null;
}

interface StageBodyProps {
  readonly stage: PipelineStage;
  readonly current: boolean;
  readonly pipeline: FeaturePipeline;
  readonly reveal: (id: string) => void;
  /** What the stage's jobs ran or produced: reviews, writes, checks, tool runs. */
  readonly children?: React.ReactNode;
}

/** A stage's body in the Pipeline view: the agents' checkpoints on the current stage, its jobs, then what they produced. */
export function StageBody({ stage, current, pipeline, reveal, children }: StageBodyProps) {
  return (
    <div className="stage-body">
      {current && pipeline.activity.length > 0 ? (
        <ul className="activity" aria-label="Checkpoints">
          {pipeline.activity.map((entry) => (
            <li key={`${entry.agent} ${entry.checkpoint}`} className="activity-row">
              <Agent handle={entry.agent} variant="compact" />
              <code>{shortSha(entry.checkpoint)}</code>
              {entry.checks === null ? null : (
                <span className={entry.checks.failed > 0 ? "verdict-breaks" : "muted"}>
                  {entry.checks.failed > 0 ? `${entry.checks.failed} of ${counted(entry.checks.total, "check")} failed` : `${counted(entry.checks.total, "check")} passed`}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {stage.jobs.length === 0 ? null : (
        <ul className="jobs">
          {stage.jobs.map((job) => (
            <JobRow key={job.key} job={job} reveal={reveal} />
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

function JobRow({ job, reveal }: { readonly job: PipelineJob; readonly reveal: (id: string) => void }) {
  const text = jobText(job.fact);
  const target = jobTarget(job);
  const open = job.status === "failed" || job.status === "person";
  return (
    <li className="job" data-status={job.status}>
      <span className="stage-dot" aria-hidden="true" />
      <span className="job-label">{text.label}</span>
      <span className="job-fact">
        <span className="visually-hidden">{STATUS_LABEL[job.status]} </span>
        {text.fact}
      </span>
      {target === null ? null : (
        <a
          className="job-link"
          href={`#${target.id}`}
          onClick={(event) => {
            event.preventDefault();
            reveal(target.id);
          }}
        >
          {target.text}
        </a>
      )}
      {open && job.fact.kind === "check" && job.fact.failing.length > 0 ? (
        <ul className="chip-list job-more" aria-label="Failing targets">
          {job.fact.failing.map((target, index) => (
            <li key={`${target} ${index}`} className="chip">
              {target}
            </li>
          ))}
        </ul>
      ) : null}
      {job.fact.kind === "check" && job.fact.findings.length > 0 ? (
        <ul className="plain-list job-more job-findings" aria-label="Findings">
          {job.fact.findings.map((finding, index) => (
            <li key={index}>
              <span className="target-name">{finding.target}</span> {finding.path === null ? null : <code>{finding.path}</code>} {finding.message}
            </li>
          ))}
        </ul>
      ) : null}
      {job.fact.kind === "stopped" ? <span className="job-more job-reason">{job.fact.reason}</span> : null}
      {open && job.fact.kind === "part" && job.fact.reviewer !== null ? (
        <span className="job-more">
          <Agent handle={job.fact.reviewer} person={job.fact.owner} variant="compact" />
        </span>
      ) : null}
    </li>
  );
}

/** The compact strip beside a feature on the team view: a dot per stage, the current one ringed, then its name. */
export function StageStrip({ strip }: { readonly strip: PipelineStrip }) {
  const label = `Stage ${strip.current + 1} of ${strip.stages.length}`;
  return (
    <span className="strip">
      <span className="strip-dots" role="img" aria-label={label}>
        {strip.stages.map((stage, index) => (
          <span key={stage.key} className="strip-dot" data-status={stage.status} data-current={index === strip.current ? true : undefined} />
        ))}
      </span>
      <span className="strip-stage" data-status={strip.stages[strip.current]?.status}>
        {currentStageText(strip)}
      </span>
    </span>
  );
}
