// The approvals inbox (PRD section 10): what waits on the signed-in person, each item with the facts
// behind it. Overlapping starts show where the two areas meet. Plan parts show why the part needs the
// person, the tests that break in their scope, their agent's review form with the side-by-side run and
// the fix's changed lines, with Approve and Request change. Protected-path confirmations, parts past
// the round limit, review exceptions and plans returned over the break limit follow without controls.
// The server names the approver and the decider from the session; an agent never approves. The lists
// are read again on each inbox-changed message and after a reconnect. Every value renders as text.

import type { OverlapRequest, PlanInbox, PlanPartRequest } from "@penguin/protocol";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { approveOverlap, decidePlanPart, fetchOverlapRequests, fetchPlanInbox, SignedOut } from "./api.ts";
import { counted, PART_STATE_LABEL, partNumber, placeText, reasonText, roundText } from "./feature-view.ts";
import { PersonAvatar } from "./avatar.tsx";
import { linkHandler } from "./links.ts";
import { BreakList, DiffFiles, ReviewCard } from "./review-card.tsx";
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

const EMPTY: Approvals = { overlaps: [], plan: { parts: [], reviewExceptions: [], returnedPlans: [] } };

/** How many items the approvals inbox shows the person. */
export function approvalCount({ overlaps, plan }: Approvals): number {
  return overlaps.length + plan.parts.length + plan.reviewExceptions.length + plan.returnedPlans.length;
}

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
  }, [live.inboxRevision, live.revision, connected, reload]);
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
}

/** The approvals as read, without the fetch, so they render on the server in a test. */
export function ApprovalsView({ approvals, busy, failed, unread = false, navigate, onApproveStart, onDecide }: ViewProps) {
  const { overlaps, plan } = approvals;
  const asks = (ask: PlanPartRequest["ask"]) => plan.parts.filter((part) => part.ask === ask);
  const sections = [
    { id: "parts", label: "Plan parts", parts: asks("approve") },
    { id: "protected", label: "Protected paths", parts: asks("protected_path") },
    { id: "round-limits", label: "Round limits", parts: asks("round_limit") },
  ];
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
      {sections.map((section) =>
        section.parts.length === 0 ? null : (
          <section key={section.id} className="approval-group" aria-labelledby={`approvals-${section.id}`}>
            <h2 id={`approvals-${section.id}`} className="approval-group-heading">
              {section.label} <span className="tab-count">{section.parts.length}</span>
            </h2>
            {section.parts.map((part) => (
              <PartCard key={`${part.ask}/${part.partId}`} part={part} sending={busy === part.partId} navigate={navigate} onDecide={onDecide} />
            ))}
          </section>
        ),
      )}
      {plan.reviewExceptions.length === 0 ? null : (
        <section className="approval-group" aria-labelledby="approvals-exceptions">
          <h2 id="approvals-exceptions" className="approval-group-heading">
            Review exceptions <span className="tab-count">{plan.reviewExceptions.length}</span>
          </h2>
          {plan.reviewExceptions.map((item) => (
            <article key={item.reviewId} className="approval-card card-raised" data-unread={item.read ? undefined : true}>
              <header className="approval-card-head">
                <h3 className="approval-card-title">
                  <FeatureLink feature={item.feature} navigate={navigate} />
                </h3>
              </header>
              <ReviewCard review={item.review} />
            </article>
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
                  {item.behavioural.length} behavioural over the limit of {item.breakLimit}
                </span>
              </header>
              <p className="muted">Please split the plan or restructure it</p>
              <ul className="chip-list" aria-label="Behavioural places">
                {item.behavioural.map((place) => (
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

function FeatureLink({ feature, navigate }: { readonly feature: string; readonly navigate: (path: string) => void }) {
  const path = featurePath(feature);
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

/** A start that waits beside the person's own feature, with where the two areas meet. */
function OverlapCard({ request, sending, navigate, onApprove }: OverlapProps) {
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
        Waits to start beside your <FeatureLink feature={request.feature} navigate={navigate} />
      </p>
      <ul className="chip-list" aria-label="Where the areas meet">
        {meet.map((item) => (
          <li key={item.key} className={item.code ? "code-chip" : "chip"}>
            {item.text}
          </li>
        ))}
        {request.overlap.omittedPaths > 0 ? <li className="muted">{counted(request.overlap.omittedPaths, "more path")}</li> : null}
      </ul>
      <div className="approval-actions">
        {/* While the approval sends the button keeps focus and refuses presses through aria-disabled. */}
        <button type="button" className="button primary progressive" aria-disabled={sending} onClick={() => sending || onApprove()}>
          {sending ? "Approving" : "Approve start"}
        </button>
      </div>
    </article>
  );
}

interface PartProps {
  readonly part: PlanPartRequest;
  readonly sending: boolean;
  readonly navigate: (path: string) => void;
  readonly onDecide: (part: PlanPartRequest, text?: string) => void;
}

/** One plan part: what it changes, why it needs the person, its review and its lines, and the decision. */
function PartCard({ part, sending, navigate, onDecide }: PartProps) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const fieldId = useId();
  const titleId = useId();
  const requestRef = useRef<HTMLButtonElement | null>(null);
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
  return (
    <article className="approval-card card-raised" data-unread={part.read ? undefined : true} data-in-person={part.routing.inPerson ? true : undefined}>
      <header className="approval-card-head">
        <h3 className="approval-card-title" id={titleId} tabIndex={-1}>
          <FeatureLink feature={part.feature} navigate={navigate} /> part {partNumber(part.partId)}
        </h3>
        <span className={part.state === "pending" ? "tag tag-attention" : "tag"}>{PART_STATE_LABEL[part.state]}</span>
      </header>
      <p className="approval-line">
        <span className="approval-person">
          <PersonAvatar id={part.person} size="card" />
          {part.person}
        </span>
        <span>changes {placeText(part.place)}</span>
      </p>
      <ul className="approval-facts" aria-label="Part">
        <li className="tag tag-data">{part.kind}</li>
        <li className="tag tag-data">revision {part.revision}</li>
        <li className="tag tag-data">{roundText(part.changeRequests, part.roundLimit)}</li>
      </ul>
      <p className="muted approval-kind">{part.kindReason}</p>
      {part.routing.reasons.length === 0 ? null : (
        <ul className="approval-reasons" aria-label="Needs you because">
          {part.routing.reasons.map((reason, index) => (
            <li key={index}>{reasonText(reason)}</li>
          ))}
        </ul>
      )}
      {part.changeRequest === null ? null : (
        <blockquote className="approval-quote">
          <p>{part.changeRequest.text}</p>
          <footer className="muted">
            {part.changeRequest.by} on revision {part.changeRequest.revision}
          </footer>
        </blockquote>
      )}
      <BreakList breaks={part.breaks} />
      {part.reviews.map((review) => (
        <ReviewCard key={review.reviewId} review={review} />
      ))}
      {part.files.length === 0 ? null : <DiffFiles files={part.files} />}
      {part.ask !== "approve" ? null : asking ? (
        // Asking for a change replaces the decision row: the request is then the one primary action.
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
      ) : (
        // While a decision sends the buttons keep focus and refuse presses through aria-disabled.
        <div className="approval-actions">
          <button type="button" className="button primary progressive" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || onDecide(part)}>
            {sending ? "Approving" : `Approve revision ${part.revision}`}
          </button>
          {part.state !== "pending" ? null : (
            <button ref={requestRef} type="button" className="button" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || setAsking(true)}>
              Request change
            </button>
          )}
        </div>
      )}
      <AgentNote part={part} />
    </article>
  );
}

/** Nothing for a part without a reviewing agent; the reviews above name each one. */
function AgentNote({ part }: { readonly part: PlanPartRequest }) {
  if (part.reviews.length > 0) return null;
  return <p className="muted">No review form yet</p>;
}
