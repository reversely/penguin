// The sandbox's review policy on the dashboard (#175, #177, docs/review-policies.md and
// docs/validation.md): the release pipeline row whose stage sets the policy, the How Penguin validates
// panel, the settings view a team lead changes it from and the measured split of approvals on the org
// and team pages. The shell reads GET /api/review-policy once and hands it down
// through PolicyContext. Every value renders as React text.

import {
  APPROVAL_TYPE_FLAG,
  APPROVAL_TYPE_KIND,
  APPROVAL_TYPE_LABEL,
  APPROVAL_TYPES,
  DEFAULT_REVIEW_POLICY,
  penguinPercent,
  PIPELINE_STAGES,
  policyName,
  PRESET_POLICIES,
  VALIDATION_KIND_CHECKS,
  VALIDATION_KIND_LABEL,
  VALIDATION_KINDS,
  type ApprovalType,
  type Decider,
  type ReviewPolicy,
  type ReviewPolicyView,
  type ReviewPreset,
  type ReviewSplit,
  type ValidationKind,
} from "@penguin/protocol";
import { createContext, useContext, useEffect, useState } from "react";

import { changeReviewPolicy, SignedOut } from "./api.ts";
import { Breadcrumb } from "./hierarchy-parts.tsx";
import { linkHandler } from "./links.ts";
import { PersonPill } from "./pills.tsx";
import { ORG_PATH, POLICY_PATH } from "./routes.ts";

/** The policy view the shell read; undefined while it loads or on a failed read. */
export const PolicyContext = createContext<ReviewPolicyView | undefined>(undefined);

const DECIDER_LABEL: Readonly<Record<Decider, string>> = { penguin: "Auto-merge", person: "Worktree owner reviews" };

/**
 * Who decides a result of each kind under the policy, as bare labels: one label, or one per policy row
 * when the kind's rows differ, such as `Custom path rules: Worktree owner reviews` and `Place: Auto-merge`. An
 * overlapping start opens at every stage and its owner is told.
 */
export function kindDeciders(policy: ReviewPolicy, kind: ValidationKind): string[] {
  if (kind === "tests") return ["Agent fixes a failure"];
  if (kind === "overlapping_starts") return ["Penguin", "Owner told"];
  if (policy.preset === "production") return ["Worktree owner reviews"];
  const rows = APPROVAL_TYPES.filter((type) => APPROVAL_TYPE_KIND[type] === kind);
  const deciders = new Set(rows.map((type) => policy.rows[type]));
  if (deciders.size === 1) return [DECIDER_LABEL[[...deciders][0] as Decider]];
  return rows.map((type) => `${APPROVAL_TYPE_LABEL[type]}: ${DECIDER_LABEL[policy.rows[type]]}`);
}

/** What each stage's preset sends to the worktree owner, as the label under the stage. */
const STAGE_SENDS: Readonly<Record<ReviewPreset, string>> = {
  local_development: "Auto-merged, worktree owner told",
  central_development: "Worktree owner reviews flagged updates",
  pre_production: "Worktree owner reviews flagged updates and migration differences",
  production: "Worktree owner reviews every update",
};

/**
 * The release pipeline in one row, left to right, with the stage the policy sets marked. Test shares
 * Pre-production's setting. With `onSelect` each stage with its own setting is a choice.
 */
export function ReleasePipeline({ preset, onSelect }: { readonly preset: ReviewPreset; readonly onSelect?: (preset: ReviewPreset) => void }) {
  return (
    <div className="timeline release-pipeline" role={onSelect === undefined ? undefined : "radiogroup"} aria-label="Release pipeline">
      <ol className="timeline-bar cols-5">
        {PIPELINE_STAGES.map((stage, index) => {
          const current = stage.preset === preset;
          // Test sits before Pre-production and takes its setting.
          const shared = PIPELINE_STAGES[index + 1]?.preset === stage.preset;
          const body = (
            <>
              <span className="stage-dot" aria-hidden="true" />
              <span className="stage-name">{stage.label}</span>
              <span className="stage-meta">{shared ? "Same setting as Pre-production" : STAGE_SENDS[stage.preset]}</span>
            </>
          );
          return (
            <li key={stage.label} className="stage" data-current={current ? true : undefined} aria-current={onSelect === undefined && current ? "step" : undefined}>
              {onSelect === undefined || shared ? (
                <span className="stage-node">{body}</span>
              ) : (
                <button type="button" role="radio" aria-checked={current} className="stage-node" onClick={() => onSelect(stage.preset)}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The panel's anchor: a link to it opens the panel. */
export const VALIDATION_ANCHOR = "validation";

/** The six kinds of validation, one line each, with who decides each under the sandbox's policy. */
export function ValidationPanel({ navigate, link = true }: { readonly navigate: (path: string) => void; readonly link?: boolean }) {
  const view = useContext(PolicyContext);
  const policy = view?.policy ?? DEFAULT_REVIEW_POLICY;
  // A link to `#validation`, such as one shared from another page, opens the panel.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (window.location.hash === `#${VALIDATION_ANCHOR}`) setOpen(true);
  }, []);
  return (
    <details id={VALIDATION_ANCHOR} className="validation-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        How Penguin validates <span className="tag tag-data">{policyName(policy)}</span>
      </summary>
      {/* The body renders only while the panel is open, as a fold's does (fold.tsx). */}
      {open ? (
        <>
          {link ? <ReleasePipeline preset={policy.preset} /> : null}
          <div className="table-scroll">
            <table className="people-table hierarchy-table validation-table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Checks</th>
                  <th scope="col">Decided by</th>
                </tr>
              </thead>
              <tbody>
                {VALIDATION_KINDS.map((kind) => (
                  <tr key={kind}>
                    <th scope="row">{VALIDATION_KIND_LABEL[kind]}</th>
                    <td data-label="Checks">{VALIDATION_KIND_CHECKS[kind]}</td>
                    <td data-label="Decided by">
                      <span className="role-source">
                        {kindDeciders(policy, kind).map((label) => (
                          <span key={label} className="tag tag-data">
                            {label}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {link ? (
            <a className="role-more" href={POLICY_PATH} onClick={linkHandler(navigate, POLICY_PATH)}>
              Review policy
            </a>
          ) : null}
        </>
      ) : null}
    </details>
  );
}

/** The share Penguin approved, as `62%`, or empty with nothing approved. */
function shareText(count: { readonly penguin: number; readonly people: number }): string {
  const percent = penguinPercent(count);
  return percent === null ? "" : `${percent}%`;
}

/**
 * The measured split of approvals over the window: Penguin automatically against a person in the
 * dashboard, overall and per type of approval, as counts and Penguin's share.
 */
export function SplitTable({ split, label }: { readonly split: ReviewSplit; readonly label: string }) {
  const rows: readonly { readonly key: string; readonly name: string; readonly count: ReviewSplit["overall"] }[] = [
    { key: "all", name: "Every approval", count: split.overall },
    ...APPROVAL_TYPES.map((type) => ({ key: type, name: APPROVAL_TYPE_LABEL[type], count: split.byType[type] })),
  ];
  return (
    <div className="table-scroll">
      <table className="people-table hierarchy-table scopes-table split-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Penguin automatically</th>
            <th scope="col">Worktree owner reviews</th>
            <th scope="col">Penguin share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.name}</th>
              <td className="hierarchy-count" data-label="Penguin automatically">{row.count.penguin}</td>
              <td className="hierarchy-count" data-label="Worktree owner reviews">{row.count.people}</td>
              <td className="hierarchy-count" data-label="Penguin share">{shareText(row.count) || <span className="muted">None</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The policy section of the org and team pages: the preset, a link to the settings and the split. */
export function PolicySplitSection({ team, navigate }: { readonly team?: string; readonly navigate: (path: string) => void }) {
  const view = useContext(PolicyContext);
  if (view === undefined) return null;
  const split = team === undefined ? view.split : view.teams.find((each) => each.team === team)?.split;
  if (split === undefined) return null;
  return (
    <section className="team-section policy-section" aria-labelledby="policy-heading">
      <h2 id="policy-heading" className="team-section-heading">
        Review policy <span className="tag tag-data">{policyName(view.policy)}</span>
        {view.locked ? <span className="tag tag-attention">Locked by admin mode</span> : null}
      </h2>
      <p className="muted">
        Approvals in the last {split.days} days{" "}
        <a className="role-more" href={POLICY_PATH} onClick={linkHandler(navigate, POLICY_PATH)}>
          Settings
        </a>
      </p>
      <SplitTable split={split} label={team === undefined ? "Approvals by route" : `Approvals by route in ${team}`} />
    </section>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The settings view: the preset, one row per type of approval, the last change and the split. */
export function PolicyPage({ navigate, onSignedOut, onChanged }: { readonly navigate: (path: string) => void; readonly onSignedOut: () => void; readonly onChanged: () => void }) {
  const view = useContext(PolicyContext);
  if (view === undefined) return <div className="team" aria-busy="true" />;
  return <PolicyView view={view} navigate={navigate} onSignedOut={onSignedOut} onChanged={onChanged} />;
}

interface PolicyViewProps {
  readonly view: ReviewPolicyView;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
  readonly onChanged: () => void;
}

/** The settings view as read, without the fetch, so it renders on the server in a test. */
export function PolicyView({ view, navigate, onSignedOut, onChanged }: PolicyViewProps) {
  const [draft, setDraft] = useState<ReviewPolicy>(view.policy);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const editable = view.canChange;
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.policy);
  const setRow = (type: ApprovalType, decider: Decider) => setDraft({ ...draft, rows: { ...draft.rows, [type]: decider } });
  const save = () => {
    setState("saving");
    changeReviewPolicy(draft).then(
      (ok) => {
        setState(ok ? "idle" : "failed");
        if (ok) onChanged();
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        else setState("failed");
      },
    );
  };
  return (
    <article className="team hierarchy policy-page" aria-labelledby="policy-page-heading">
      <Breadcrumb crumbs={[{ label: "Org", path: ORG_PATH }, { label: "Review policy" }]} navigate={navigate} />
      <header className="page-header">
        <h1 id="policy-page-heading">Review policy</h1>
      </header>
      <ValidationPanel navigate={navigate} link={false} />
      <p className="policy-change muted">
        {view.changedBy === null || view.changedAt === null ? (
          "Central development by default"
        ) : (
          <>
            Changed by <PersonPill id={view.changedBy} navigate={navigate} /> <time dateTime={view.changedAt}>{TIME.format(Date.parse(view.changedAt))}</time>
          </>
        )}
      </p>
      {view.locked ? <p className="notice">Admin mode sends every update to its worktree owner</p> : null}
      {!editable && !view.locked ? <p className="muted">Please ask a team lead to change the policy</p> : null}
      <section className="team-section" aria-labelledby="policy-preset">
        <h2 id="policy-preset" className="team-section-heading">
          Stage
        </h2>
        <ReleasePipeline preset={draft.preset} {...(editable ? { onSelect: (preset: ReviewPreset) => setDraft(PRESET_POLICIES[preset]) } : {})} />
      </section>
      <section className="team-section" aria-labelledby="policy-rows">
        <h2 id="policy-rows" className="team-section-heading">
          Types of approval
        </h2>
        <div className="table-scroll">
          <table className="people-table hierarchy-table policy-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Sends a part when</th>
                <th scope="col">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {APPROVAL_TYPES.map((type) => (
                <tr key={type}>
                  <th scope="row">
                    {APPROVAL_TYPE_LABEL[type]}
                    {/* Custom path rules and Place are two rows of one kind, which their sub-line names. */}
                    {VALIDATION_KIND_LABEL[APPROVAL_TYPE_KIND[type]] === APPROVAL_TYPE_LABEL[type] ? null : (
                      <span className="muted hierarchy-sub">{VALIDATION_KIND_LABEL[APPROVAL_TYPE_KIND[type]]}</span>
                    )}
                  </th>
                  <td data-label="Sends a part when">{APPROVAL_TYPE_FLAG[type]}</td>
                  <td data-label="Decided by">
                    <span className="decider-choice" role="radiogroup" aria-label={`${APPROVAL_TYPE_LABEL[type]} decided by`}>
                      {(["penguin", "person"] as const).map((decider) => (
                        <button
                          key={decider}
                          type="button"
                          role="radio"
                          className="pill pill-filter"
                          aria-checked={draft.rows[type] === decider}
                          disabled={!editable}
                          onClick={() => setRow(type, decider)}
                        >
                          {DECIDER_LABEL[decider]}
                        </button>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">A failed test always goes back to the agent</p>
        {editable ? (
          <p className="policy-actions">
            <button type="button" className="button primary" disabled={!dirty || state === "saving"} onClick={save}>
              Save policy
            </button>
            {state === "failed" ? (
              <span className="notice" role="alert">
                Please reload the page and try again
              </span>
            ) : null}
          </p>
        ) : null}
      </section>
      <section className="team-section" aria-labelledby="policy-split">
        <h2 id="policy-split" className="team-section-heading">
          Approvals in the last {view.split.days} days
        </h2>
        <SplitTable split={view.split} label="Approvals by route" />
      </section>
    </article>
  );
}
