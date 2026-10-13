// The approvals inbox (PRD section 10): what waits on the signed-in person, each item with the facts
// behind it. Overlapping starts show where the two areas meet: Penguin lets each one open and the
// person is told, with no control. Each merge plan is one card: why it
// needs the person, each review its parts carry (once, however many parts share it) and then the
// person's parts, each with its rounds, its breaks and changed lines behind a line counting them, and
// Approve and Request change on a part that waits on them. A part Penguin approved because every check
// was clean shows who approved it and Reverse approval until its block reaches main. Custom path rule confirmations and parts past
// the round limit sit in their plan's card without controls. A feature's own change to a path the
// person covers with a custom path rule is its own card, with the changed lines and Confirm lines while it waits; a
// confirmed one stays, marked confirmed, until a later checkpoint changes the lines. Review exceptions
// and plans returned over the break limit follow; an exception whose review a plan card already shows
// links to it. The server names the approver, the decider and the confirmer from the session; an
// agent never approves. The lists are read again on each inbox-changed or features-changed message
// and after a reconnect. Every value renders as text.

import { isOwnerLockId, type OverlapRequest, type PlanInbox, type PlanPartRequest, type ProtectedChangeRequest, type ReviewExceptionRequest } from "@penguin/protocol";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { approveOverlap, confirmProtectedChange, decidePlanPart, fetchOverlapRequests, fetchPlanInbox, SignedOut } from "./api.ts";
import {
  counted,
  partNumber,
  partRouteText,
  placeText,
  planGroups,
  reviewAnchor,
  reviewExceptionText,
  roundText,
  shortSha,
  type PlanGroup,
} from "./feature-view.ts";
import { PersonAvatar } from "./avatar.tsx";
import { Disclosure } from "./disclosure.tsx";
import { linkHandler } from "./links.ts";
import { BreakList, DiffFiles, ReviewCard } from "./review-card.tsx";
import { changePath } from "./banner-view.ts";
import { partAnchor } from "./pipeline-view.ts";
import { featurePath } from "./routes.ts";
import type { Live } from "./use-live.ts";

interface Props {
  readonly state: ApprovalsState;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export interface ApprovalsState {
  readonly approvals: Approvals;
  readonly loaded: boolean;
  /** Whether the last read failed; the lists shown are then the last ones read, or empty. */
  readonly failed: boolean;
  /** Reads the approvals again; resolves once the new lists are shown. */
  readonly reload: () => Promise<void>;
}

export interface Approvals {
  readonly overlaps: readonly OverlapRequest[];
  readonly plan: PlanInbox;
}

const EMPTY: Approvals = { overlaps: [], plan: { parts: [], protectedChanges: [], reviewExceptions: [], returnedPlans: [] } };

/** How many items the approvals inbox shows the person; a confirmed protected change asks nothing. */
export function approvalCount({ overlaps, plan }: Approvals): number {
  const waiting = plan.protectedChanges.filter((change) => change.state === "pending").length;
  return overlaps.length + plan.parts.length + waiting + plan.reviewExceptions.length + plan.returnedPlans.length;
}

/** The key of a protected change's card: one per feature and protecting person. */
const changeKey = (change: ProtectedChangeRequest) => `change:${change.feature}/${change.owner}`;

/** Reads the person's approvals, again on each inbox change, after a reconnect and after each decision. */
export function useApprovals(live: Live, onSignedOut: () => void): ApprovalsState {
  const [approvals, setApprovals] = useState<Approvals>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only the newest read is shown, so a slow earlier answer never replaces a later one.
  const latest = useRef(0);
  const connected = live.status === "live";
  const reload = useCallback(async () => {
    const read = ++latest.current;
    try {
      const [overlaps, plan] = await Promise.all([fetchOverlapRequests(), fetchPlanInbox()]);
      if (read !== latest.current) return;
      setApprovals({ overlaps, plan });
      setFailed(false);
    } catch (error) {
      if (error instanceof SignedOut) onSignedOut();
      else if (read === latest.current) setFailed(true);
    }
    if (read === latest.current) setLoaded(true);
  }, [onSignedOut]);
  useEffect(() => {
    void reload();
  }, [live.inboxRevision, live.revision, live.featuresRevision, connected, reload]);
  return { approvals, loaded, failed, reload };
}

export function ApprovalsInbox({ state, navigate, onSignedOut }: Props) {
  const { approvals, reload } = state;
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  // An item stays busy until the lists read after its write are shown, so a decided card never offers
  // its decision again.
  const act = (key: string, write: () => Promise<boolean>) => {
    if (busy !== undefined) return;
    setBusy(key);
    setFailed(false);
    write().then(
      () =>
        reload().then(() => {
          setBusy(undefined);
          // A decided card leaves the list; focus then moves to the approvals rather than the page's body.
          requestAnimationFrame(() => {
            if (document.activeElement === document.body) document.getElementById("approvals")?.focus();
          });
        }),
      (error: unknown) => {
        setBusy(undefined);
        if (error instanceof SignedOut) onSignedOut();
        else setFailed(true);
      },
    );
  };
  return (
    <ApprovalsView
      approvals={approvals}
      busy={busy}
      failed={failed}
      unread={state.failed}
      navigate={navigate}
      onApproveStart={(request) => act(`${request.feature}/${request.blockedFeature}`, () => approveOverlap(request))}
      onDecide={(part, text) => {
        const decision = { feature: part.feature, part: part.partId, revision: part.revision };
        act(part.partId, () => decidePlanPart(text === undefined ? { kind: "approve", ...decision } : { kind: "request_change", ...decision, text }));
      }}
      onConfirm={(change) => act(changeKey(change), () => confirmProtectedChange(change))}
      onReverse={(part) => act(part.partId, () => decidePlanPart({ kind: "reverse", feature: part.feature, part: part.partId, revision: part.revision }))}
    />
  );
}

interface ViewProps {
  readonly approvals: Approvals;
  /** The item whose write is sending. */
  readonly busy: string | undefined;
  readonly failed: boolean;
  /** Whether the approvals could not be read. */
  readonly unread?: boolean;
  readonly navigate: (path: string) => void;
  readonly onApproveStart: (request: OverlapRequest) => void;
  readonly onDecide: (part: PlanPartRequest, text?: string) => void;
  readonly onConfirm?: (change: ProtectedChangeRequest) => void;
  /** Reverses Penguin's approval of a part. */
  readonly onReverse?: (part: PlanPartRequest) => void;
}

/** The approvals as read, without the fetch, so they render on the server in a test. */
export function ApprovalsView({ approvals, busy, failed, unread = false, navigate, onApproveStart, onDecide, onConfirm = () => undefined, onReverse = () => undefined }: ViewProps) {
  const { overlaps, plan } = approvals;
  const plans = planGroups(plan.parts);
  const shownReviews = new Set(plans.flatMap((group) => group.reviews.map((review) => review.reviewId)));
  return (
    <div className="approvals" id="approvals" tabIndex={-1}>
      {failed ? (
        <p className="notice" role="alert">
          Please try that decision again
        </p>
      ) : null}
      {unread ? (
        <p className="notice" role="alert">
          Please reload the page to see your approvals
        </p>
      ) : null}
      {overlaps.length === 0 ? null : (
        <section className="approval-group" aria-labelledby="approvals-overlaps">
          <h2 id="approvals-overlaps" className="approval-group-heading">
            Overlapping starts <span className="tab-count">{overlaps.length}</span>
          </h2>
          {overlaps.map((request) => (
            <OverlapCard
              key={`${request.feature}/${request.blockedFeature}`}
              request={request}
              sending={busy === `${request.feature}/${request.blockedFeature}`}
              navigate={navigate}
              onApprove={() => onApproveStart(request)}
            />
          ))}
        </section>
      )}
      {plans.length === 0 ? null : (
        <section className="approval-group" aria-labelledby="approvals-plans">
          <h2 id="approvals-plans" className="approval-group-heading">
            Plans <span className="tab-count">{plans.length}</span>
          </h2>
          {plans.map((group) => (
            <PlanCard key={group.planId} group={group} busy={busy} navigate={navigate} onDecide={onDecide} onReverse={onReverse} />
          ))}
        </section>
      )}
      {plan.protectedChanges.length === 0 ? null : (
        <section className="approval-group" aria-labelledby="approvals-protected">
          <h2 id="approvals-protected" className="approval-group-heading">
            Custom path rules <span className="tab-count">{plan.protectedChanges.length}</span>
          </h2>
          {plan.protectedChanges.map((change) => (
            <ProtectedChangeCard key={changeKey(change)} change={change} sending={busy === changeKey(change)} navigate={navigate} onConfirm={() => onConfirm(change)} />
          ))}
        </section>
      )}
      {plan.reviewExceptions.length === 0 ? null : (
        <section className="approval-group" aria-labelledby="approvals-exceptions">
          <h2 id="approvals-exceptions" className="approval-group-heading">
            Review exceptions <span className="tab-count">{plan.reviewExceptions.length}</span>
          </h2>
          {plan.reviewExceptions.map((item) => (
            <ExceptionCard key={item.reviewId} item={item} shownAbove={shownReviews.has(item.reviewId)} navigate={navigate} />
          ))}
        </section>
      )}
      {plan.returnedPlans.length === 0 ? null : (
        <section className="approval-group" aria-labelledby="approvals-returned">
          <h2 id="approvals-returned" className="approval-group-heading">
            Returned plans <span className="tab-count">{plan.returnedPlans.length}</span>
          </h2>
          {plan.returnedPlans.map((item) => (
            <article key={item.feature} className="approval-card card-raised" data-unread={item.read ? undefined : true}>
              <header className="approval-card-head">
                <h3 className="approval-card-title">
                  <FeatureLink feature={item.feature} navigate={navigate} />
                </h3>
                <span className="tag tag-attention">
                  {item.inPerson.length} of {item.breakLimit} needing the worktree owner's review
                </span>
              </header>
              <p className="muted">Please split the plan into smaller plans</p>
              <ul className="chip-list" aria-label="Places needing the worktree owner's review">
                {item.inPerson.map((place) => (
                  <li key={place} className="chip">
                    {place}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/** A feature's change page, anchored at the part, file or review an item concerns. */
function FeatureLink({ feature, anchor = null, navigate }: { readonly feature: string; readonly anchor?: string | null; readonly navigate: (path: string) => void }) {
  const path = anchor === null ? featurePath(feature) : changePath(feature, anchor);
  return (
    <a className="feature-link" href={path} onClick={linkHandler(navigate, path)}>
      {feature}
    </a>
  );
}

interface OverlapProps {
  readonly request: OverlapRequest;
  readonly sending: boolean;
  readonly navigate: (path: string) => void;
  readonly onApprove: () => void;
}

/**
 * A start Penguin let open beside the person's own feature, with where the two areas meet; a start
 * from before #177 that still waits on the person; or an expand checkpoint that adds to the person's
 * scopes and waits to reach main ahead of the rest of its feature.
 */
function OverlapCard({ request, sending, navigate, onApprove }: OverlapProps) {
  const expand = isOwnerLockId(request.feature);
  const meet = [...request.overlap.scopes.map((scope) => ({ key: `s ${scope}`, text: scope, code: false })), ...[...request.overlap.contracts, ...request.overlap.paths].map((text) => ({ key: `c ${text}`, text, code: true }))];
  return (
    <article className="approval-card card-raised" data-unread={request.read ? undefined : true}>
      <header className="approval-card-head">
        <h3 className="approval-card-title">
          <FeatureLink feature={request.blockedFeature} navigate={navigate} />
        </h3>
        <span className="approval-person">
          <PersonAvatar id={request.blockedPerson} size="card" />
          {request.blockedPerson}
        </span>
      </header>
      <p className="approval-line">
        {expand ? (
          "Expand into your scopes"
        ) : (
          <>
            Start beside <FeatureLink feature={request.feature} navigate={navigate} />
          </>
        )}
      </p>
      <ul className="chip-list" aria-label={expand ? "What it adds to" : "Where the areas meet"}>
        {meet.map((item) => (
          <li key={item.key} className={item.code ? "code-chip" : "chip"}>
            {item.text}
          </li>
        ))}
        {request.overlap.omittedPaths > 0 ? <li className="muted">{counted(request.overlap.omittedPaths, "more path")}</li> : null}
      </ul>
      {request.told ? (
        <p className="approval-line">
          <span className="tag tag-data">Approved by Penguin</span>
        </p>
      ) : (
        <div className="approval-actions">
          {/* While the approval sends the button keeps focus and refuses presses through aria-disabled. */}
          <button type="button" className="button primary progressive" aria-disabled={sending} onClick={() => sending || onApprove()}>
            {sending ? "Approving" : expand ? "Approve addition" : "Approve start"}
          </button>
        </div>
      )}
    </article>
  );
}

interface PlanProps {
  readonly group: PlanGroup;
  /** The item whose write is sending. */
  readonly busy: string | undefined;
  readonly navigate: (path: string) => void;
  readonly onDecide: (part: PlanPartRequest, text?: string) => void;
  readonly onReverse: (part: PlanPartRequest) => void;
}

/**
 * One merge plan: the feature and its person, why the plan needs the person, each review its parts
 * carry, then the person's parts with their decisions. A part is listed once per reason it reaches the
 * person, so a part they approve and also confirm a custom path rule for shows twice.
 */
function PlanCard({ group, busy, navigate, onDecide, onReverse }: PlanProps) {
  const inPerson = group.parts.some((part) => part.routing.inPerson);
  return (
    <article className="approval-card card-raised plan-card" data-unread={group.unread ? true : undefined} data-in-person={inPerson ? true : undefined}>
      <header className="approval-card-head">
        <h3 className="approval-card-title">
          <FeatureLink feature={group.feature} navigate={navigate} />
        </h3>
        <span className="approval-person">
          <PersonAvatar id={group.person} size="card" />
          {group.person}
        </span>
      </header>
      {group.reasons.length === 0 ? null : (
        <ul className="approval-reasons" aria-label="Reasons">
          {group.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {group.reviews.length === 0 ? (
        <p className="muted">No review form yet</p>
      ) : (
        group.reviews.map((review) => <ReviewCard key={review.reviewId} review={review} />)
      )}
      <ol className="plan-parts" aria-label="Your parts">
        {group.parts.map((part) => (
          <PartRow key={`${part.ask}/${part.partId}`} part={part} sending={busy === part.partId} navigate={navigate} onDecide={onDecide} onReverse={onReverse} />
        ))}
      </ol>
    </article>
  );
}

/** The tag beside a part: its state with who approved it, or why it reaches the person when they only confirm it. */
function partTag(part: PlanPartRequest): { readonly text: string; readonly attention: boolean } {
  if (part.ask === "protected_path") return { text: "Custom path rule", attention: false };
  if (part.ask === "stored_data") return { text: "Stored data needs a migration or backfill", attention: true };
  return { text: partRouteText(part, part.person), attention: part.ask === "approve" && part.state === "pending" };
}

interface PartProps {
  readonly part: PlanPartRequest;
  readonly sending: boolean;
  readonly onDecide: (part: PlanPartRequest, text?: string) => void;
  readonly onReverse: (part: PlanPartRequest) => void;
  readonly navigate: (path: string) => void;
}

/** One part in its plan's card: its place and rounds, its facts behind a counting line, and the decision. */
function PartRow({ part, sending, navigate, onDecide, onReverse }: PartProps) {
  const changePage = changePath(part.feature, partAnchor(part.partId));
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const fieldId = useId();
  const titleId = useId();
  const requestRef = useRef<HTMLButtonElement | null>(null);
  const tag = partTag(part);
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!sending && text.trim() !== "") onDecide(part, text);
  };
  const cancel = () => {
    setAsking(false);
    setText("");
    requestAnimationFrame(() => requestRef.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !sending) cancel();
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  // A part of the person's own plan that waits on them for their change's stored data takes their approval too.
  const decides = part.ask === "approve" || part.ask === "stored_data";
  const reverses = part.ask === "penguin_approved";
  return (
    <li className="plan-part" data-unread={part.read ? undefined : true}>
      <div className="plan-part-head">
        <h4 className="part-title" id={titleId} tabIndex={-1}>
          <a className="part-link" href={changePage} onClick={linkHandler(navigate, changePage)}>
            Part {partNumber(part.partId)} <span className="plan-part-place">{placeText(part.place)}</span>
          </a>
        </h4>
        <ul className="approval-facts" aria-label="Part">
          <li className="tag tag-data">{part.kind}</li>
          <li className="tag tag-data">revision {part.revision}</li>
          <li className="tag tag-data">{roundText(part.changeRequests, part.roundLimit)}</li>
        </ul>
        <span className={tag.attention ? "tag tag-attention plan-part-state" : reverses ? "tag tag-verified plan-part-state" : "tag plan-part-state"}>{tag.text}</span>
        {!reverses ? null : (
          // Penguin's approval stands until its author reverses it or the block reaches main.
          <div className="approval-actions">
            <button type="button" className="button" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || onReverse(part)}>
              {sending ? "Reversing" : "Reverse approval"}
            </button>
          </div>
        )}
        {!decides || asking ? null : (
          // While a decision sends the buttons keep focus and refuse presses through aria-disabled.
          <div className="approval-actions">
            <button type="button" className="button primary progressive" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || onDecide(part)}>
              {sending ? "Approving" : `Approve revision ${part.revision}`}
            </button>
            {part.state !== "pending" || part.ask !== "approve" ? null : (
              <button ref={requestRef} type="button" className="button" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || setAsking(true)}>
                Request change
              </button>
            )}
          </div>
        )}
      </div>
      {reverses ? <p className="muted approval-kind">You may reverse it until the block reaches main</p> : null}
      {decides && asking ? (
        // Asking for a change replaces the decision buttons: the request is then the one primary action.
        <form className="approval-reason" onSubmit={send} aria-labelledby={titleId}>
          <label htmlFor={fieldId}>Change to ask for</label>
          <textarea
            id={fieldId}
            rows={3}
            maxLength={2000}
            value={text}
            autoFocus
            readOnly={sending}
            onKeyDown={onKeyDown}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="approval-actions">
            <button type="submit" className="button primary progressive" aria-disabled={sending || text.trim() === ""}>
              {sending ? "Sending" : "Send request"}
            </button>
            <button type="button" className="button quiet" aria-disabled={sending} onClick={() => sending || cancel()}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {part.changeRequest === null ? null : (
        <blockquote className="approval-quote">
          <p>{part.changeRequest.text}</p>
          <footer className="muted">
            {part.changeRequest.by} on revision {part.changeRequest.revision}
          </footer>
        </blockquote>
      )}
      {/* A plan holds a part per affected place, so each part's facts open on request. */}
      <Disclosure className="part-details" summary={`${counted(part.breaks.length, "break")} ${counted(part.files.length, "changed file")}`}>
        <p className="muted approval-kind">{part.kindReason}</p>
        <BreakList breaks={part.breaks} />
        {part.files.length === 0 ? null : <DiffFiles files={part.files} />}
      </Disclosure>
    </li>
  );
}

interface ProtectedChangeProps {
  readonly change: ProtectedChangeRequest;
  readonly sending: boolean;
  readonly navigate: (path: string) => void;
  readonly onConfirm: () => void;
}

/**
 * A feature's own change to paths under the person's custom path rules: the feature and its person,
 * each file with the custom path that covers it and its changed lines, and Confirm lines while it waits. The feature
 * does not land until the lines are confirmed.
 */
function ProtectedChangeCard({ change, sending, navigate, onConfirm }: ProtectedChangeProps) {
  const titleId = useId();
  const waiting = change.state === "pending";
  const covering = [...new Set(change.files.map((file) => file.protectedPath))];
  return (
    <article className="approval-card card-raised" data-unread={change.read ? undefined : true} aria-labelledby={titleId}>
      <header className="approval-card-head">
        <h3 className="approval-card-title" id={titleId}>
          <FeatureLink feature={change.feature} anchor="changes" navigate={navigate} />
        </h3>
        <span className="approval-person">
          <PersonAvatar id={change.person} size="card" />
          {change.person}
        </span>
      </header>
      <p className="approval-line">
        {waiting
          ? `${counted(change.files.length, "file")} under custom path rules at checkpoint ${shortSha(change.checkpoint)}`
          : `${change.confirmedBy ?? change.owner} confirmed the lines at checkpoint ${shortSha(change.checkpoint)}`}
      </p>
      <ul className="chip-list" aria-label="Custom path rules">
        {covering.map((path) => (
          <li key={path} className="code-chip">
            {path}
          </li>
        ))}
      </ul>
      {change.files.every((file) => file.lines === null) ? null : (
        <DiffFiles files={change.files.flatMap((file) => (file.lines === null ? [] : [{ path: file.path, status: file.status, lines: file.lines }]))} />
      )}
      <div className="approval-actions">
        {waiting ? (
          // While the confirmation sends the button keeps focus and refuses presses through aria-disabled.
          <button type="button" className="button primary progressive" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || onConfirm()}>
            {sending ? "Confirming" : "Confirm lines"}
          </button>
        ) : (
          <span className="tag plan-part-state">Confirmed</span>
        )}
      </div>
    </article>
  );
}

interface ExceptionProps {
  readonly item: ReviewExceptionRequest;
  /** Whether a plan card above already shows the review, which the card then links to. */
  readonly shownAbove: boolean;
  readonly navigate: (path: string) => void;
}

/** A review of the person's scope that raised an exception; its review shows once on the page. */
function ExceptionCard({ item, shownAbove, navigate }: ExceptionProps) {
  return (
    <article className="approval-card card-raised" data-unread={item.read ? undefined : true}>
      <header className="approval-card-head">
        <h3 className="approval-card-title">
          <FeatureLink feature={item.feature} anchor={reviewAnchor(item.reviewId)} navigate={navigate} />
        </h3>
      </header>
      {shownAbove ? (
        <>
          <ul className="review-exceptions" aria-label="Exceptions">
            {item.exceptions.map((exception, index) => (
              <li key={index}>{reviewExceptionText(exception)}</li>
            ))}
          </ul>
          <a className="review-link" href={`#${reviewAnchor(item.reviewId)}`}>
            Review of {item.scope}
          </a>
        </>
      ) : (
        <ReviewCard review={item.review} />
      )}
    </article>
  );
}
