// The feature page (PRD section 10, #124): one feature, the unit of work, in three levels.
//
// 1. The header stays in view: the breadcrumb (Org, the person's team, the person, the feature, then
//    the part and the file an anchor opened), the feature with its
//    person and its scopes, the timeline bar with the branches to other people, and at most three
//    summary lines, each opening the place it sums up.
// 2. Four views below it, each a tab with its own anchor: Changes (the contract change, then each place
//    the plan fixes, its files and their hunks), Pipeline (each stage with its jobs and what they ran),
//    People (the features that read this one, the starts it waited on, its agents) and Record.
// 3. Rows inside a view stay folded except those that need the viewer.
//
// A part's changed lines show only to the people the server sends them to. The page reads again on
// every live message. Every value renders as React text.

import { blockCheckKind, BLOCK_CHECK_NAMES, decisionRouteText, VALIDATION_KIND_LABEL, type BlockCheck, type BlockCheckName, type DecisionRoute, type FeaturePage, type PipelineStageKey, type PipelineStrip, type TeamView, type ToolRunView } from "@penguin/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Agent } from "./agent-directory.tsx";
import { fetchFeaturePage } from "./api.ts";
import { viewerToDos, type ToDo } from "./banner-view.ts";
import { ChangeTree } from "./change-tree.tsx";
import { checksByTool, counted, partStateText, recordLabel, shortSha } from "./feature-view.ts";
import { Fold, FoldProvider, useFolds } from "./fold.tsx";
import { Icon } from "./icon.tsx";
import { useRead } from "./inbox-page.tsx";
import { linkHandler } from "./links.ts";
import {
  CONTRACT_FOLD,
  foldParents,
  initialFolds,
  readByRows,
  recordKinds,
  stageAnchor,
  summaryLines,
  viewOf,
  VIEW_LABEL,
  VIEWS,
  type ReadByRow,
  type SummaryLine,
  type Tone,
  type View,
} from "./page-view.ts";
import { PersonPill, ScopePill, TonePill } from "./pills.tsx";
import { partAnchor, STAGE_LABEL, stageCount, STATUS_LABEL } from "./pipeline-view.ts";
import { ReviewCard } from "./review-card.tsx";
import { ValidationPanel } from "./review-policy.tsx";
import { Breadcrumb, hierarchyCrumbs, type Crumb } from "./hierarchy-parts.tsx";
import { partCrumbs } from "./hierarchy-view.ts";
import { featurePath } from "./routes.ts";
import { StageBody, Timeline } from "./timeline.tsx";
import type { Live } from "./use-live.ts";

interface Props {
  readonly featureId: string;
  /** The signed-in person, whose parts open on their own. */
  readonly viewer: string;
  /** The team view, for each reading feature's stage and each scope's owner. */
  readonly team: TeamView | undefined;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export function FeaturePageView({ featureId, viewer, team, live, navigate, onSignedOut }: Props) {
  const read = useCallback(() => fetchFeaturePage(featureId), [featureId]);
  const page = useRead(read, `${live.revision}:${live.inboxRevision}:${live.featuresRevision}:${live.status === "live"}`, onSignedOut);
  if (page.kind === "loading") return <div className="feature" aria-busy="true" />;
  if (page.kind === "failed" || page.value === undefined) {
    return (
      <div className="feature">
        <a className="back-link" href="/" onClick={linkHandler(navigate, "/")}>
          <Icon name="back" />
          Team
        </a>
        <h1>{page.kind === "failed" ? "Feature" : "Feature not found"}</h1>
        <p className="muted">{page.kind === "failed" ? "Please reload the page" : "Please choose a feature on the team page"}</p>
      </div>
    );
  }
  return <FeatureView page={page.value} viewer={viewer} team={team} navigate={navigate} />;
}

interface ViewProps {
  readonly page: FeaturePage;
  readonly viewer: string;
  readonly team?: TeamView | undefined;
  readonly navigate: (path: string) => void;
  /** Folds open from the start besides the viewer's own, such as every section in a test. */
  readonly open?: readonly string[];
  /** The view shown first; the page's anchor picks it in a browser. */
  readonly view?: View;
}

/** Each feature's strip and each scope's owner, from the team view. */
function teamFacts(team: TeamView | undefined): { readonly strips: Map<string, PipelineStrip>; readonly owners: Map<string, string> } {
  const strips = new Map<string, PipelineStrip>();
  const owners = new Map<string, string>();
  for (const person of team?.people ?? []) {
    for (const feature of person.features) strips.set(feature.id, feature.strip);
    for (const scope of [...person.role.scopes, ...person.role.dependents, ...person.role.dependencies]) owners.set(scope.id, scope.ownerId);
  }
  return { strips, owners };
}

/** The page as read, without the fetch, so it renders on the server in a test. */
export function FeatureView({ page, viewer, team, navigate, open = [], view: firstView = "changes" }: ViewProps) {
  const { feature } = page;
  const ownStages = feature.person === viewer ? page.pipeline.stages.filter((stage) => stage.status === "person" || stage.status === "failed").map((stage) => stageAnchor(stage.key)) : [];
  // On a colleague's feature the main change is what the viewer reads first, so it opens.
  const colleague = feature.person === viewer ? [] : [CONTRACT_FOLD];
  const folds = useFolds(() => [...initialFolds(page, viewer), ...ownStages, ...colleague, ...open], foldParents);
  const todos = useMemo(() => viewerToDos(page, viewer), [page, viewer]);
  const [view, setView] = useState<View>(firstView);
  // The part and file the page last opened by anchor, which the breadcrumb names under the feature.
  const [anchor, setAnchor] = useState("");
  const reveal = useCallback(
    (id: string) => {
      setAnchor(id);
      const target = viewOf(id) ?? foldParents(id).map(viewOf).find((each) => each !== undefined);
      if (target !== undefined) setView(target);
      if (!(VIEWS as readonly string[]).includes(id)) folds.reveal(id);
    },
    [folds],
  );
  // A link from the inbox, a banner or the team view names a view, a part or a file in the anchor.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id !== "") reveal(id);
    // Only the anchor the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const facts = useMemo(() => teamFacts(team), [team]);
  const lines = useMemo(() => summaryLines(page), [page]);
  const choose = (next: View) => {
    setView(next);
    setAnchor("");
    window.history.replaceState(null, "", `#${next}`);
  };
  return (
    <FoldProvider value={folds.value}>
      <article className="feature" aria-labelledby="feature-heading">
        <Breadcrumb crumbs={[...hierarchyCrumbs(team?.teams ?? [], { person: feature.person, feature: feature.id }), ...partCrumbs(page.plan, anchor).map((crumb): Crumb => ({ label: crumb.label, path: `#${crumb.anchor}`, onOpen: () => reveal(crumb.anchor) }))]} navigate={navigate} />
        <header className="feature-head">
          <h1 id="feature-heading">{feature.id}</h1>
          <PersonPill id={feature.person} navigate={navigate} />
          {feature.area.scopes.length === 0 ? null : (
            <ul className="pill-list" aria-label="Scopes">
              {feature.area.scopes.map((scope) => (
                <li key={scope.id}>
                  <ScopePill name={scope.name} owner={scope.ownerId === "" ? null : scope.ownerId} />
                </li>
              ))}
            </ul>
          )}
        </header>
        <Timeline pipeline={page.pipeline} feature={feature.id} tasks={page.editTasks ?? []} reveal={reveal} />
        {todos.length === 0 ? null : <ToDos todos={todos} reveal={reveal} navigate={navigate} />}
        {lines.length === 0 ? null : <Summary lines={lines} reveal={reveal} />}
        <ValidationPanel navigate={navigate} />
        <div className="tabs" role="tablist" aria-label="Views">
          {VIEWS.map((each) => (
            <a
              key={each}
              id={`tab-${each}`}
              className="tab"
              role="tab"
              href={`#${each}`}
              aria-selected={view === each}
              aria-controls={each}
              tabIndex={view === each ? 0 : -1}
              onClick={(event) => {
                event.preventDefault();
                choose(each);
              }}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (step === 0) return;
                event.preventDefault();
                const next = VIEWS[(VIEWS.indexOf(each) + step + VIEWS.length) % VIEWS.length] as View;
                choose(next);
                document.getElementById(`tab-${next}`)?.focus();
              }}
            >
              {VIEW_LABEL[each]}
              {each === "record" ? <span className="tab-count">{page.records.length}</span> : null}
            </a>
          ))}
        </div>
        <section className="view" id={view} role="tabpanel" aria-labelledby={`tab-${view}`}>
          {view === "changes" ? <ChangesView page={page} viewer={viewer} owners={facts.owners} navigate={navigate} /> : null}
          {view === "pipeline" ? <PipelineView page={page} reveal={reveal} /> : null}
          {view === "people" ? <PeopleView page={page} strips={facts.strips} owners={facts.owners} navigate={navigate} reveal={reveal} /> : null}
          {view === "record" ? <RecordView page={page} /> : null}
        </section>
      </article>
    </FoldProvider>
  );
}

/** What the viewer must do on a colleague's feature, each with the part it concerns and the inbox where they act. */
function ToDos({ todos, reveal, navigate }: { readonly todos: readonly ToDo[]; readonly reveal: (id: string) => void; readonly navigate: (path: string) => void }) {
  return (
    <ul className="todos" aria-label="For you">
      {todos.map((todo) => (
        <li key={todo.text}>
          <span className="tag tag-attention">Your decision</span>
          {todo.anchor === null ? (
            <span>{todo.text}</span>
          ) : (
            <a
              href={`#${todo.anchor}`}
              onClick={(event) => {
                event.preventDefault();
                reveal(todo.anchor as string);
              }}
            >
              {todo.text}
            </a>
          )}
          <a className="todo-inbox" href="/inbox" onClick={linkHandler(navigate, "/inbox")}>
            Inbox
          </a>
        </li>
      ))}
    </ul>
  );
}

/** At most three lines, each opening the place it sums up. */
function Summary({ lines, reveal }: { readonly lines: readonly SummaryLine[]; readonly reveal: (id: string) => void }) {
  return (
    <ul className="feature-summary" aria-label="Summary">
      {lines.map((line) => (
        <li key={line.target} data-tone={line.tone}>
          <a
            href={`#${line.target}`}
            onClick={(event) => {
              event.preventDefault();
              reveal(line.target);
            }}
          >
            {line.label}
          </a>
          {line.fact === null ? null : <span className="muted"> {line.fact}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Changes: the contract change, each place the plan fixes, then the declared area. */
interface ChangesProps {
  readonly page: FeaturePage;
  readonly viewer: string;
  readonly owners: ReadonlyMap<string, string>;
  readonly navigate: (path: string) => void;
}

function ChangesView({ page, viewer, owners, navigate }: ChangesProps) {
  const { feature } = page;
  return (
    <div className="view-body">
      <ChangeTree
        writes={fixWrites(page)}
        plan={page.plan}
        contract={page.contract ?? null}
        fixes={page.fixes}
        featureId={feature.id}
        person={feature.person}
        viewer={viewer}
        dependents={page.dependents}
        owners={owners}
        navigate={navigate}
      />
      <Fold id="area" className="tree-node" summary={<span className="tree-title">Area</span>}>
        <div className="tree-body">
          <dl className="facts">
            {feature.area.contracts.length === 0 ? null : (
              <Fact term="Contracts">
                {feature.area.contracts.map((contract) => (
                  <code key={contract} className="code-chip">
                    {contract}
                  </code>
                ))}
              </Fact>
            )}
            <Fact term="Paths">
              {feature.area.paths.length === 0 ? <span className="muted">None</span> : <Capped inline items={feature.area.paths} render={(path) => <code key={path} className="code-chip">{path}</code>} />}
            </Fact>
            {feature.latestCheckpoint === null ? null : (
              <Fact term="Checkpoint">
                <code>{shortSha(feature.latestCheckpoint)}</code>
              </Fact>
            )}
          </dl>
        </div>
      </Fold>
    </div>
  );
}

/** Each part's fix write route, from the newest `fix_write` record naming the part. */
function fixWrites(page: FeaturePage): Map<string, DecisionRoute> {
  const writes = new Map<string, DecisionRoute>();
  for (const record of page.records) if (record.type === "fix_write" && record.partId && record.route) writes.set(record.partId, record.route);
  return writes;
}

/** Which stage holds what a job ran: reviews, tool runs and the block checks. */
function stageOf(keys: readonly PipelineStageKey[], wanted: PipelineStageKey, fallback: PipelineStageKey): PipelineStageKey {
  return keys.includes(wanted) ? wanted : fallback;
}

/** Pipeline: each stage with its jobs, then what they ran: the plan's facts, reviews, writes, checks and tool runs. */
function PipelineView({ page, reveal }: { readonly page: FeaturePage; readonly reveal: (id: string) => void }) {
  const { pipeline } = page;
  const keys = pipeline.stages.map((stage) => stage.key);
  const planStage = stageOf(keys, "plan", "expand");
  const reviewStage = stageOf(keys, "review", "migrate");
  const checkStage = stageOf(keys, "checks", "migrate");
  const fixStage = stageOf(keys, "fixes", "migrate");
  const toolStage = (tool: string): PipelineStageKey => (tool === "check" ? checkStage : tool === "apply_fix" ? fixStage : planStage);
  return (
    <ol className="tree">
      {pipeline.stages.map((stage, index) => {
        const tools = page.tools.filter((run) => toolStage(run.tool) === stage.key);
        const count = stageCount({ passed: stage.jobs.filter((job) => job.status === "passed").length, jobs: stage.jobs.length });
        return (
          <li key={stage.key}>
            <Fold
              id={stageAnchor(stage.key)}
              className="tree-node stage-fold"
              summary={
                <span className="tree-head" data-status={stage.status}>
                  <span className="stage-dot" aria-hidden="true" />
                  <span className="tree-title">{STAGE_LABEL[stage.key]}</span>
                  <span className={stage.status === "person" ? "tag tag-attention" : stage.status === "failed" ? "tag tag-failure" : "muted"}>{STATUS_LABEL[stage.status]}</span>
                  {count === null ? null : <span className="muted">{count}</span>}
                </span>
              }
            >
              <div className="tree-body">
                <StageBody stage={stage} current={index === pipeline.current} pipeline={pipeline} reveal={reveal}>
                  {stage.key === planStage && page.plan !== null ? <PlanFacts page={page} /> : null}
                  {stage.key === reviewStage && page.reviews.length > 0 ? (
                    <Fold id="reviews" className="tree-node" summary={<span className="tree-title">Reviews {page.reviews.length}</span>}>
                      {page.reviews.map((review) => (
                        <ReviewCard key={review.reviewId} review={review} />
                      ))}
                    </Fold>
                  ) : null}
                  {stage.key === checkStage && page.checks !== null ? (
                    <Fold id="checks" className="tree-node" summary={<span className="tree-title">Results {page.checks.checks.length}</span>}>
                      <ChecksView run={page.checks} />
                    </Fold>
                  ) : null}
                  {tools.length === 0 ? null : (
                    <Fold id={`${stageAnchor(stage.key)}-tools`} className="tree-node" summary={<span className="tree-title">Tool runs {tools.length}</span>}>
                      <ol className="tool-runs">
                        {[...tools].reverse().map((run) => (
                          <ToolRun key={run.id} run={run} />
                        ))}
                      </ol>
                    </Fold>
                  )}
                </StageBody>
              </div>
            </Fold>
          </li>
        );
      })}
    </ol>
  );
}

/** The plan's id, its agent, its change in plain words and each fact with the tool or read that produced it. */
function PlanFacts({ page }: { readonly page: FeaturePage }) {
  const plan = page.plan;
  if (plan === null) return null;
  return (
    <div className="plan-facts">
      <p className="plan-head">
        <span className="plan-id">{plan.planId}</span>
        <Agent handle={plan.proposedBy} person={page.feature.person} variant="compact" />
        <time dateTime={plan.proposedAt}>{timeText(plan.proposedAt)}</time>
      </p>
      <blockquote className="plan-change">
        <p>{plan.change.subject}</p>
      </blockquote>
      <ul className="tool-facts" aria-label="Facts">
        {plan.sources.map((source) => (
          <li key={source.fact} className="tool-fact">
            <span className="tool-fact-name">{source.fact.replaceAll("_", " ")}</span>
            <code className="tool-name">{source.tool}</code>
            <span className="muted">{source.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LABEL_TONE: Readonly<Record<string, Tone>> = { "needs the worktree owner's review": "person", approved: "passed", "fix written": "passed", reviewing: "running", sent: "waiting", waiting: "waiting" };

interface PeopleProps {
  readonly page: FeaturePage;
  readonly strips: ReadonlyMap<string, PipelineStrip>;
  readonly owners: ReadonlyMap<string, string>;
  readonly navigate: (path: string) => void;
  readonly reveal: (id: string) => void;
}

/** People: the running features that read this one, the starts it waited on and its agents. */
function PeopleView({ page, strips, owners, navigate, reveal }: PeopleProps) {
  const rows = readByRows(page, strips, owners);
  return (
    <div className="view-body">
      <section className="feature-section" id="read-by" aria-labelledby="read-by-heading">
        <h2 id="read-by-heading" className="team-section-heading">
          Read by <span className="tab-count">{rows.length}</span>
        </h2>
        {rows.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <div className="table-scroll">
            <table className="people-table">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">Worktree owner</th>
                  <th scope="col">Reads</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Part</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ReadByLine key={`${row.feature} ${row.reads.scope} ${row.from.scope}`} row={row} page={page} navigate={navigate} reveal={reveal} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {page.waitingOn.length === 0 ? null : (
        <section className="feature-section" id="start" aria-labelledby="start-heading">
          <h2 id="start-heading" className="team-section-heading">
            Start <span className="tab-count">{page.waitingOn.length}</span>
          </h2>
          <div className="table-scroll">
            <table className="people-table">
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">Worktree owner</th>
                  <th scope="col">Lock</th>
                  <th scope="col">Approved by</th>
                </tr>
              </thead>
              <tbody>
                {page.waitingOn.map((lock) => (
                  <tr key={lock.feature}>
                    <td>
                      <FeatureLink feature={lock.feature} navigate={navigate} />
                    </td>
                    <td>
                      <PersonPill id={lock.person} navigate={navigate} />
                    </td>
                    <td>
                      <TonePill tone={lock.state === "open" ? "person" : "passed"}>{lock.state === "open" ? "waiting" : "approved"}</TonePill>
                    </td>
                    <td>{lock.state === "approved" ? <PersonPill id={lock.approvedBy ?? lock.person} navigate={navigate} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="feature-section" id="agents" aria-labelledby="agents-heading">
        <h2 id="agents-heading" className="team-section-heading">
          Agents <span className="tab-count">{page.agents.length}</span>
        </h2>
        {page.agents.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <ul className="agent-list">
            {page.agents.map((agent) => (
              <li key={agent.handle}>
                <Agent handle={agent.handle} person={agent.person} online={agent.online} navigate={navigate} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReadByLine({ row, page, navigate, reveal }: { readonly row: ReadByRow; readonly page: FeaturePage; readonly navigate: (path: string) => void; readonly reveal: (id: string) => void }) {
  const branch = row.part === null ? undefined : page.pipeline.branches.find((each) => each.partId === row.part?.partId);
  const label = row.part === null ? null : (branch?.label ?? partStateText(row.part.state, null));
  const anchor = row.part === null ? null : partAnchor(row.part.partId);
  return (
    <tr>
      <td>
        <FeatureLink feature={row.feature} navigate={navigate} />
      </td>
      <td>
        <PersonPill id={row.person} navigate={navigate} />
      </td>
      <td>
        <span className="reads">
          <ScopePill name={row.reads.scope} owner={row.reads.owner} />
          <span className="reads-arrow">
            <Icon name="back" />
          </span>
          <span className="visually-hidden">reads</span>
          <ScopePill name={row.from.scope} owner={row.from.owner} />
        </span>
      </td>
      <td>{row.stage === null ? null : <TonePill tone={row.stage.status}>{STAGE_LABEL[row.stage.key]}</TonePill>}</td>
      <td>
        {anchor === null || label === null ? null : (
          <a
            className={`pill pill-tone-${LABEL_TONE[label] ?? "waiting"}`}
            href={`#${anchor}`}
            onClick={(event) => {
              event.preventDefault();
              reveal(anchor);
            }}
          >
            {label}
          </a>
        )}
      </td>
    </tr>
  );
}

/** Record: the signed records, filtered by kind. */
function RecordView({ page }: { readonly page: FeaturePage }) {
  const [kind, setKind] = useState<string | null>(null);
  const kinds = recordKinds(page.records);
  const shown = kind === null ? page.records : page.records.filter((record) => record.type === kind);
  return (
    <div className="view-body">
      <div className="record-filter" role="group" aria-label="Kind">
        <button type="button" className="pill pill-filter" aria-pressed={kind === null} onClick={() => setKind(null)}>
          All <span className="tab-count">{page.records.length}</span>
        </button>
        {kinds.map((each) => (
          <button key={each.type} type="button" className="pill pill-filter" aria-pressed={kind === each.type} onClick={() => setKind(kind === each.type ? null : each.type)}>
            {recordLabel(each.type)} <span className="tab-count">{each.count}</span>
          </button>
        ))}
      </div>
      <ol className="record-list">
        {shown.map((record) => (
          <li key={record.recordId} className="record-row">
            <span className="record-type">{recordLabel(record.type)}</span>
            <span className="muted record-route">{record.route === undefined ? record.author : routeWords(record.route)}</span>
            {(record.kinds ?? []).map((kind) => (
              <span key={kind} className="tag tag-data kind-tag">
                {VALIDATION_KIND_LABEL[kind]}
              </span>
            ))}
            <time dateTime={record.createdAt}>{timeText(record.createdAt)}</time>
            {record.commit ? (
              // The signed file as the record repo holds it, read at the commit that added it.
              <a className="record-path" href={`/api/features/${page.feature.id}/records/${record.recordId}`} title={`In the record repo at ${shortSha(record.commit)}`}>
                <code>{record.path}</code>
              </a>
            ) : (
              <code className="record-path">{record.path}</code>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A record's route as the record view names it: an agent through MCP, Penguin automatically or a person in the dashboard. */
function routeWords(route: DecisionRoute): string {
  return route.route === "penguin" ? "Penguin automatically" : decisionRouteText(route);
}

const LIST_CAP = 8;

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function timeText(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : TIME.format(time);
}

function Fact({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The first LIST_CAP items, then a count of the rest. */
function Capped<T>({ items, render, inline = false }: { readonly items: readonly T[]; readonly render: (item: T) => React.ReactNode; readonly inline?: boolean }) {
  const [all, setAll] = useState(false);
  const rest = items.length - LIST_CAP;
  const more =
    rest > 0 && !all ? (
      <button type="button" className="button quiet show-more" onClick={() => setAll(true)}>
        {rest} more
      </button>
    ) : null;
  return (
    <>
      {(all ? items : items.slice(0, LIST_CAP)).map(render)}
      {more === null ? null : inline ? more : <li>{more}</li>}
    </>
  );
}

function FeatureLink({ feature, navigate }: { readonly feature: string; readonly navigate: (path: string) => void }) {
  const path = featurePath(feature);
  return (
    <a className="feature-link" href={path} onClick={linkHandler(navigate, path)}>
      {feature}
    </a>
  );
}

const RESULT_CLASS: Readonly<Record<string, string>> = {
  passed: "tag tag-verified",
  failed: "tag tag-failure",
  error: "tag tag-failure",
  "not-affected": "tag",
  "not-run": "tag",
};

/** The newest `check`: each tool's results per target, then one next step per failing check. */
function ChecksView({ run }: { readonly run: ToolRunView }) {
  const groups = checksByTool(run.checks);
  return (
    <div className="checks-view">
      <p className="muted">
        {counted(run.checks.length, "check")} {counted(groups.reduce((sum, group) => sum + group.failing, 0), "failing", "failing")}{" "}
        <time dateTime={run.completedAt ?? run.createdAt}>{timeText(run.completedAt ?? run.createdAt)}</time>
      </p>
      <ul className="tool-groups">
        {groups.map((group) => (
          <li key={group.key} className="tool-group card-raised">
            <p className="tool-line">
              <code className="tool-name">{group.tool}</code>
              <code className="muted">{group.commandId}</code>
              <span className="tool-check">{group.check}</span>
              {checkKind(group.check)}
              {group.failing > 0 ? <span className="tag tag-failure">{counted(group.failing, "failing", "failing")}</span> : null}
            </p>
            <ul className="target-rows">
              {group.checks.filter(shownAsRow).map((check, index) => (
                <CheckRow key={`${check.target} ${index}`} check={check} />
              ))}
              {group.checks.every(shownAsRow) ? null : (
                <li className="muted target-others">
                  {otherResults(group.checks.filter((check) => !shownAsRow(check))).map((text) => (
                    <span key={text}>{text} </span>
                  ))}
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
      {run.decisions.length === 0 ? null : (
        <>
          <h3 className="plan-subheading">Next steps</h3>
          <ul className="plain-list">
            {run.decisions.map((decision, index) => (
              <li key={index}>
                <span className="tag tag-data">step {decision.step}</span> {decision.check} on {decision.target} <span className="next-step">{decision.nextStep}</span> <span className="muted">{decision.actor}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The kind of validation a block check belongs to, as a tag. */
function checkKind(check: string): React.ReactNode {
  if (!(BLOCK_CHECK_NAMES as readonly string[]).includes(check)) return null;
  return <span className="tag tag-data kind-tag">{VALIDATION_KIND_LABEL[blockCheckKind(check as BlockCheckName)]}</span>;
}

/**
 * A check gets a row of its own when it failed or erred, or when it passed with findings: the
 * dependency diff passes and still names the changed library and each place the target imports it.
 */
function shownAsRow(check: BlockCheck): boolean {
  return check.result === "failed" || check.result === "error" || check.findingCount > 0;
}

/** The targets left without a row, counted by result, one label each: `passed on 3 targets`. */
function otherResults(checks: readonly BlockCheck[]): string[] {
  const counts = new Map<string, number>();
  for (const check of checks) counts.set(check.result, (counts.get(check.result) ?? 0) + 1);
  return [...counts].map(([result, count]) => `${result} on ${counted(count, "target")}`);
}

function CheckRow({ check }: { readonly check: BlockCheck }) {
  return (
    <li className="target-row">
      <span className="target-name">{check.target}</span>
      <span className={RESULT_CLASS[check.result] ?? "tag"}>{check.result}</span>
      <span className="target-summary">{check.summary}</span>
      {check.findings.length === 0 ? null : (
        <ul className="findings">
          {check.findings.slice(0, 3).map((finding, index) => (
            <li key={index}>
              {finding.path === null ? null : (
                <code>
                  {finding.path}
                  {finding.line === null ? "" : `:${finding.line}`}
                </code>
              )}{" "}
              {finding.code === null ? null : <code className="muted">{finding.code}</code>} {finding.message}
            </li>
          ))}
          {check.findingCount > 3 ? <li className="muted">{counted(check.findingCount - 3, "more finding")}</li> : null}
        </ul>
      )}
    </li>
  );
}

const TOOL_RESULT_CLASS: Readonly<Record<string, string>> = { error: "tag tag-failure", refused: "tag tag-failure", waiting: "tag tag-attention" };

function ToolRun({ run }: { readonly run: ToolRunView }) {
  return (
    <li className="tool-run card-raised">
      <p className="tool-line">
        <code className="tool-name">{run.tool}</code>
        <Agent handle={run.caller} variant="compact" />
        <span className={TOOL_RESULT_CLASS[run.result] ?? "tag"}>{run.result}</span>
        <time className="muted" dateTime={run.createdAt}>
          {timeText(run.createdAt)}
        </time>
      </p>
      <p className="tool-summary">{run.summary}</p>
      {run.impact === null ? null : (
        <div className="tool-detail">
          <p className="tool-line">
            <code className="tool-name">{run.impact.tool}</code>
            <code className="muted">{run.impact.commandId}</code>
            <span className="muted">{counted(run.impact.changes.length, "change")}</span>
          </p>
          <ul className="code-list">
            <Capped
              items={run.impact.changes}
              render={(change) => (
                <li key={`${change.symbol} ${change.change}`}>
                  <span className="tag tag-data">{change.change}</span> <code>{change.symbol}</code>{" "}
                  <span className="muted">
                    {change.path}:{change.line}
                  </span>
                </li>
              )}
            />
          </ul>
          {run.impact.forks.some((fork) => fork.uses > 0) ? (
            <ul className="chip-list" aria-label="Forks that use the change">
              {run.impact.forks
                .filter((fork) => fork.uses > 0)
                .map((fork) => (
                  <li key={fork.id} className="chip">
                    {fork.id} <span className="muted">{counted(fork.uses, "use")}</span>
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      )}
      {run.fix === null ? null : (
        <div className="tool-detail">
          <p className="tool-line">
            {run.fix.commandId === null ? null : <code className="tool-name">{run.fix.commandId}</code>}
            <span>{run.fix.summary}</span>
          </p>
          <ul className="chip-list">
            {run.fix.paths.map((path) => (
              <li key={path} className="code-chip">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.checks.length === 0 ? null : <p className="muted">{counted(run.checks.length, "block check")} under Block checks</p>}
    </li>
  );
}
