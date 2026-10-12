// The feature page (PRD section 10): the feature's declaration and who it waits on, its agents, the
// merge plan with each affected place and its state, the reviews, the fixes that go into other forks,
// the block's checks grouped by the tool that ran them, every agent tool call with what the tool
// reported, and the signed record. Each deterministic tool shows by name beside its output, so a
// reader sees which step a tool settled and which needed an agent or a person (docs/demo-story.md,
// Tools on screen). A part's changed lines show only to the people the server sends them to. The page
// reads again on every live message. Every value renders as React text.

import type { BlockCheck, FeaturePage, FeaturePlanView, PlanPartView, ToolRunView } from "@penguin/protocol";
import { useCallback, useState } from "react";

import { Agent } from "./agent-directory.tsx";
import { fetchFeaturePage } from "./api.ts";
import { Disclosure } from "./disclosure.tsx";
import { PersonAvatar } from "./avatar.tsx";
import {
  checksByTool,
  counted,
  PART_STATE_LABEL,
  partNumber,
  placeText,
  recordLabel,
  roundText,
  shortSha,
  stateClass,
} from "./feature-view.ts";
import { Icon } from "./icon.tsx";
import { useRead } from "./inbox-page.tsx";
import { linkHandler } from "./links.ts";
import { BreakList, DiffFiles, ReviewCard } from "./review-card.tsx";
import { featurePath, personPath } from "./routes.ts";
import type { Live } from "./use-live.ts";

interface Props {
  readonly featureId: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export function FeaturePageView({ featureId, live, navigate, onSignedOut }: Props) {
  const read = useCallback(() => fetchFeaturePage(featureId), [featureId]);
  const page = useRead(read, `${live.revision}:${live.inboxRevision}:${live.status === "live"}`, onSignedOut);
  const back = (
    <a className="back-link" href="/" onClick={linkHandler(navigate, "/")}>
      <Icon name="back" />
      Team
    </a>
  );
  if (page.kind === "loading") return <div className="feature" aria-busy="true" />;
  if (page.kind === "failed" || page.value === undefined) {
    return (
      <div className="feature">
        {back}
        <h1>{page.kind === "failed" ? "Feature" : "Feature not found"}</h1>
        <p className="muted">{page.kind === "failed" ? "Please reload the page" : "Please choose a feature on the team view"}</p>
      </div>
    );
  }
  return <FeatureView page={page.value} navigate={navigate} back={back} />;
}

const LIST_CAP = 8;

/** The page as read, without the fetch, so it renders on the server in a test. */
export function FeatureView({ page, navigate, back }: { readonly page: FeaturePage; readonly navigate: (path: string) => void; readonly back?: React.ReactNode }) {
  const { feature } = page;
  const personLink = personPath(feature.person);
  return (
    <article className="feature" aria-labelledby="feature-heading">
      {back}
      <header className="feature-head">
        <h1 id="feature-heading">{feature.id}</h1>
        <span className={stateClass(feature.state)}>{feature.state}</span>
        <p className="feature-meta">
          <a className="approval-person" href={personLink} onClick={linkHandler(navigate, personLink)}>
            <PersonAvatar id={feature.person} size="card" />
            {feature.person}
          </a>
          {feature.repo === null ? null : <code>{feature.repo}</code>}
          {feature.latestCheckpoint === null ? null : (
            <span>
              checkpoint <code>{shortSha(feature.latestCheckpoint)}</code>
            </span>
          )}
        </p>
      </header>

      <Section id="declaration" title="Declaration">
        <dl className="facts">
          <Fact term="Scopes">
            {feature.area.scopes.length === 0 ? <span className="muted">None</span> : feature.area.scopes.map((scope) => <span key={scope.id} className="chip">{scope.name}</span>)}
          </Fact>
          {feature.area.contracts.length === 0 ? null : (
            <Fact term="Contracts">
              {feature.area.contracts.map((contract) => (
                <code key={contract} className="code-chip">
                  {contract}
                </code>
              ))}
            </Fact>
          )}
          {feature.area.paths.length === 0 ? null : (
            <Fact term="Paths">
              <Capped inline items={feature.area.paths} render={(path) => <code key={path} className="code-chip">{path}</code>} />
            </Fact>
          )}
        </dl>
        {page.waitingOn.length === 0 ? null : (
          <ul className="plain-list" aria-label="Start">
            {page.waitingOn.map((lock) => (
              <li key={lock.feature} className={lock.state === "open" ? "attention" : undefined}>
                {lock.state === "open" ? `Start waits for ${lock.person} beside ` : `Start approved by ${lock.approvedBy ?? lock.person} beside `}
                <FeatureLink feature={lock.feature} navigate={navigate} />
              </li>
            ))}
          </ul>
        )}
        {page.dependents.length === 0 ? null : (
          <ul className="plain-list" aria-label="Read by">
            <Capped
              items={page.dependents}
              render={(dependent) => (
                <li key={`${dependent.feature} ${dependent.consumerScope}`}>
                  <FeatureLink feature={dependent.feature} navigate={navigate} /> of {dependent.person} reads {dependent.providerScope} from {dependent.consumerScope}
                </li>
              )}
            />
          </ul>
        )}
      </Section>

      <Section id="agents" title="Agents" count={page.agents.length}>
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
      </Section>

      <Section id="plan" title="Merge plan">
        {page.plan === null ? <p className="muted">No merge plan</p> : <PlanView plan={page.plan} person={feature.person} navigate={navigate} />}
      </Section>

      {page.reviews.length === 0 ? null : (
        <Section id="reviews" title="Reviews" count={page.reviews.length}>
          {page.reviews.map((review) => (
            <ReviewCard key={review.reviewId} review={review} />
          ))}
        </Section>
      )}

      {page.fixes.length === 0 ? null : (
        <Section id="fixes" title="Fixes in other forks" count={page.fixes.length}>
          <ul className="fix-list">
            {page.fixes.map((fix) => (
              <li key={fix.partId} className="fix-row">
                <code>feature-{fix.feature}</code>
                <span className="approval-person">
                  <PersonAvatar id={fix.person} size="card" />
                  {fix.person}
                </span>
                <span className="muted">
                  part {partNumber(fix.partId)} revision {fix.revision}
                </span>
                <span className={fix.state === "approved" ? "tag tag-verified" : fix.state === "pending" ? "tag tag-attention" : "tag"}>{PART_STATE_LABEL[fix.state]}</span>
                {fix.write === null ? null : <FixWriteText write={fix.write} />}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section id="checks" title="Block checks">
        {page.checks === null ? <p className="muted">No block checks yet</p> : <ChecksView run={page.checks} />}
      </Section>

      <Section id="tools" title="Tool runs" count={page.tools.length}>
        {page.tools.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <ol className="tool-runs">
            {[...page.tools].reverse().map((run) => (
              <ToolRun key={run.id} run={run} />
            ))}
          </ol>
        )}
      </Section>

      <Section id="record" title="Record" count={page.records.length}>
        <ol className="record-list">
          {page.records.map((record) => (
            <li key={record.recordId} className="record-row">
              <span className="record-type">{recordLabel(record.type)}</span>
              <span className="muted">{record.author}</span>
              <time dateTime={record.createdAt}>{timeText(record.createdAt)}</time>
              <code className="record-path">{record.path}</code>
            </li>
          ))}
        </ol>
      </Section>
    </article>
  );
}

const WRITE_STATE: Readonly<Record<string, string>> = {
  queued: "write queued for the check runner",
  granted: "write token granted",
  written: "written",
  withdrawn: "write withdrawn",
};

/** Where a fix's write stands: who writes it and, once written, the commit in the fork. */
function FixWriteText({ write }: { readonly write: NonNullable<FeaturePage["fixes"][number]["write"]> }) {
  return (
    <span className="fix-write">
      <span className={write.state === "written" ? "verdict-holds" : "muted"}>{WRITE_STATE[write.state] ?? write.state}</span>
      <span className="muted">by {write.writer === "runner" ? "the check runner" : "the originating agent"}</span>
      {write.commit === null ? null : <code>{shortSha(write.commit)}</code>}
      {write.rebased ? <span className="muted">rebased onto the fork head</span> : null}
    </span>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function timeText(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : TIME.format(time);
}

function Section({ id, title, count, children }: { readonly id: string; readonly title: string; readonly count?: number; readonly children: React.ReactNode }) {
  return (
    <section className="feature-section" aria-labelledby={`feature-${id}`}>
      <h2 id={`feature-${id}`} className="team-section-heading">
        {title} {count === undefined ? null : <span className="tab-count">{count}</span>}
      </h2>
      {children}
    </section>
  );
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

function PlanView({ plan, person, navigate }: { readonly plan: FeaturePlanView; readonly person: string; readonly navigate: (path: string) => void }) {
  const diff = plan.contractDiff;
  return (
    <div className="plan">
      <p className="plan-head">
        <span className="plan-id">{plan.planId}</span>
        <span className="muted">proposed by</span>
        <Agent handle={plan.proposedBy} person={person} variant="compact" />
        <time dateTime={plan.proposedAt}>{timeText(plan.proposedAt)}</time>
      </p>
      <blockquote className="plan-change">
        <p>{plan.change.subject}</p>
        <footer className="muted">
          checkpoint <code>{shortSha(plan.change.checkpoint)}</code>
        </footer>
      </blockquote>
      <h3 className="plan-subheading">Facts and their tools</h3>
      <ul className="tool-facts">
        {plan.sources.map((source) => (
          <li key={source.fact} className="tool-fact">
            <span className="tool-fact-name">{source.fact.replaceAll("_", " ")}</span>
            <code className="tool-name">{source.tool}</code>
            <span className="muted">{source.detail}</span>
          </li>
        ))}
      </ul>
      {diff === null ? null : (
        <>
          <h3 className="plan-subheading">Contract diff</h3>
          <ul className="code-list">
            <Capped
              items={diff.changes}
              render={(change) => (
                <li key={`${change.symbol} ${change.change}`}>
                  <span className="tag tag-data">{change.change}</span> <code>{change.symbol}</code>{" "}
                  <span className="muted">
                    {change.kind} at {change.path}:{change.line}
                  </span>
                </li>
              )}
            />
          </ul>
          {diff.signatures.length === 0 ? null : (
            <ul className="code-list" aria-label="Signatures">
              {diff.signatures.map((signature) => (
                <li key={signature.symbol}>
                  <code>{signature.before}</code> <span className="muted">to</span> <code>{signature.after}</code>
                  {signature.breaking ? <span className="tag tag-attention">breaking</span> : null}
                </li>
              ))}
            </ul>
          )}
          {diff.dataShapes.length === 0 ? null : (
            <ul className="code-list" aria-label="Stored data shapes">
              {diff.dataShapes.map((shape) => (
                <li key={shape.symbol}>
                  <code>{shape.symbol}</code> <span className="muted">fields</span> <code>{shape.before.join(", ")}</code> <span className="muted">to</span>{" "}
                  <code>{shape.after.join(", ")}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {plan.mainCallers.length === 0 ? null : (
        <>
          <h3 className="plan-subheading">Callers on main</h3>
          <ul className="code-list">
            <Capped
              items={plan.mainCallers}
              render={(use) => (
                <li key={`${use.path}:${use.line}:${use.symbol}`}>
                  <code>
                    {use.path}:{use.line}
                  </code>{" "}
                  <span className="muted">
                    {use.kind} {use.symbol}
                  </span>
                </li>
              )}
            />
          </ul>
        </>
      )}
      <h3 className="plan-subheading">
        Affected places <span className="tab-count">{plan.parts.length}</span>
      </h3>
      <ol className="part-list">
        {plan.parts.map((part) => (
          <PartView key={part.partId} part={part} plan={plan} person={person} navigate={navigate} />
        ))}
      </ol>
    </div>
  );
}

function PartView({ part, plan, person, navigate }: { readonly part: PlanPartView; readonly plan: FeaturePlanView; readonly person: string; readonly navigate: (path: string) => void }) {
  const ownerPath = personPath(part.owner);
  return (
    <li className="part card-raised">
      <header className="approval-card-head">
        <h4 className="part-title">
          {partNumber(part.partId)} {part.place.kind === "feature" ? <FeatureLink feature={part.place.feature} navigate={navigate} /> : placeText(part.place)}
        </h4>
        <span className={part.state === "approved" ? "tag tag-verified" : part.state === "pending" ? "tag tag-attention" : "tag"}>{PART_STATE_LABEL[part.state]}</span>
      </header>
      <p className="approval-line">
        <a className="approval-person" href={ownerPath} onClick={linkHandler(navigate, ownerPath)}>
          <PersonAvatar id={part.owner} size="card" />
          {part.owner}
        </a>
        <span className="tag tag-data">{part.kind}</span>
        <span className="muted">
          revision {part.revision}, {roundText(part.changeRequests, plan.roundLimit)}
        </span>
      </p>
      {part.changeRequest === null ? null : (
        <blockquote className="approval-quote">
          <p>{part.changeRequest.text}</p>
          <footer className="muted">
            {part.changeRequest.by} on revision {part.changeRequest.revision}
          </footer>
        </blockquote>
      )}
      {/* A plan holds a part per affected place, so each part's facts open on request. */}
      <Disclosure
        className="part-details"
        summary={`${counted(part.breaks.length, "break")}, ${counted(part.invariants.length, "invariant")}, ${counted(part.callers.length, "use")}`}
      >
        <p className="muted approval-kind">{part.kindReason}</p>
        <BreakList breaks={part.breaks} />
        {part.invariants.length === 0 ? null : (
          <ul className="plain-list" aria-label="Invariants">
            {part.invariants.map((invariant) => (
              <li key={`${invariant.scopeId} ${invariant.id}`}>
                {invariant.statement} {invariant.protected ? <span className="tag tag-data">protected</span> : null}
              </li>
            ))}
          </ul>
        )}
        {part.files === null ? (
          <p className="muted">
            Changed lines show to {part.owner} and {person}
          </p>
        ) : (
          <DiffFiles files={part.files} />
        )}
      </Disclosure>
    </li>
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
        {run.summary}, <time dateTime={run.completedAt ?? run.createdAt}>{timeText(run.completedAt ?? run.createdAt)}</time>
      </p>
      <ul className="tool-groups">
        {groups.map((group) => (
          <li key={group.key} className="tool-group card-raised">
            <p className="tool-line">
              <code className="tool-name">{group.tool}</code>
              <code className="muted">{group.commandId}</code>
              <span className="tool-check">{group.check}</span>
              {group.failing > 0 ? <span className="tag tag-failure">{counted(group.failing, "failing", "failing")}</span> : null}
            </p>
            <ul className="target-rows">
              {group.checks
                .filter((check) => check.result === "failed" || check.result === "error")
                .map((check, index) => (
                  <CheckRow key={`${check.target} ${index}`} check={check} />
                ))}
              {group.failing === group.checks.length ? null : <li className="muted target-others">{otherResults(group.checks)}</li>}
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
                <span className="tag tag-data">step {decision.step}</span> {decision.check} on {decision.target}: {decision.nextStep} <span className="muted">{decision.actor}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The targets a tool did not fail on, counted by result: `passed on 3 targets, not-affected on 1`. */
function otherResults(checks: readonly BlockCheck[]): string {
  const counts = new Map<string, number>();
  for (const check of checks) if (check.result !== "failed" && check.result !== "error") counts.set(check.result, (counts.get(check.result) ?? 0) + 1);
  return [...counts].map(([result, count]) => `${result} on ${counted(count, "target")}`).join(", ");
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
