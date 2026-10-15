// One caller item (#188) as a card: the receiving worktree and the contract the change reaches there,
// its state and who it waits on, each call site with its verdict, the differing calls behind a line
// counting them, each with the originating agent's classification and the receiving agent's verdict
// and evidence, what the agents and people wrote, quoted. Below the quotes, a short reason tag names
// each answer Penguin refused since the item last moved (#189). The feature page lists the cards for
// the callers a change reaches and for those in its own worktree; the worktree owner's approvals
// inbox lists the cards sent to them, with Approve and Request changes on each they decide. Every
// value renders as React text.

import { CALLER_PARTY_LABEL, CALLER_REFUSAL_LABEL, CALLER_STATE_LABEL, type CallerItemView, type CallerSideView } from "@penguin/protocol";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { PersonAvatar } from "./avatar.tsx";
import { Disclosure } from "./disclosure.tsx";
import { CALLER_OWNER_TAG, callerSideText, counted } from "./feature-view.ts";
import { linkHandler } from "./links.ts";
import { featurePath } from "./routes.ts";

const VERDICT_CLASS: Readonly<Record<CallerItemView["verdict"], string>> = {
  unaffected: "tag tag-verified",
  broken: "tag tag-failure",
  differs: "tag tag-attention",
  unknown_reach: "tag tag-attention",
};

const VERDICT_LABEL: Readonly<Record<CallerItemView["verdict"], string>> = {
  unaffected: "unaffected",
  broken: "broken",
  differs: "differs",
  unknown_reach: "no test reaches it",
};

const SETTLED = new Set<CallerItemView["state"]>(["confirmed", "written", "approved", "unaffected", "withdrawn"]);

interface Props {
  readonly item: CallerItemView;
  /** Which feature the card's title names: the receiving worktree on a change's page and in the inbox, the change on its worktree's page. */
  readonly title: "feature" | "origin";
  readonly navigate: (path: string) => void;
  /** Present when the viewer decides the item as its worktree owner. */
  readonly decide?: { readonly sending: boolean; readonly onDecide: (verdict: "approve" | "request_changes", text: string) => void } | undefined;
  /** Shown in place of controls when the viewer is only told of the item. */
  readonly told?: boolean;
}

export function CallerCard({ item, title, navigate, decide, told = false }: Props) {
  const titleId = useId();
  const feature = title === "feature" ? item.feature : item.origin;
  const person = title === "feature" ? item.person : item.originPerson;
  const path = featurePath(feature);
  const calls = item.differing;
  return (
    <article className="approval-card card-raised caller-card" aria-labelledby={titleId} data-in-person={item.waitingOn === "worktree_owner" ? true : undefined}>
      <header className="approval-card-head">
        <h3 className="approval-card-title" id={titleId}>
          <a className="feature-link" href={path} onClick={linkHandler(navigate, path)}>
            {feature}
          </a>
        </h3>
        <span className="approval-person">
          <PersonAvatar id={person} size="card" />
          {person}
        </span>
      </header>
      <p className="approval-line">
        <code className="code-chip">{item.contract}</code>
      </p>
      <ul className="approval-facts" aria-label="Item">
        <li className={SETTLED.has(item.state) ? "tag tag-verified" : item.waitingOn === "worktree_owner" ? "tag tag-attention" : "tag"}>{CALLER_STATE_LABEL[item.state]}</li>
        {item.waitingOn === "nobody" ? null : <li className="tag tag-data">Waits on {CALLER_PARTY_LABEL[item.waitingOn].toLowerCase()}</li>}
        {item.ownerAsked === null || item.ownerAsked === "unknown_reach" ? null : <li className="tag tag-attention">{CALLER_OWNER_TAG[item.ownerAsked]}</li>}
        {item.rejections === 0 ? null : <li className="tag tag-data">{counted(item.rejections, "rejection")}</li>}
        {told ? <li className="tag tag-data">No decision needed</li> : null}
      </ul>
      <ul className="code-list caller-sites" aria-label="Call sites">
        {item.callers.map((caller) => (
          <li key={`${caller.path}:${caller.line}`}>
            <code className="code-chip">
              {caller.path}:{caller.line}
            </code>
            <span className={VERDICT_CLASS[caller.verdict]}>{VERDICT_LABEL[caller.verdict]}</span>
            <span className="muted">
              {caller.matched} of {counted(caller.calls, "call")} match
            </span>
          </li>
        ))}
      </ul>
      {item.explanation === null ? null : (
        <blockquote className="approval-quote">
          <p>{item.explanation.text}</p>
          <footer className="muted">
            {item.explanation.by} {item.explanation.kind === "expected" ? "explains it as expected" : "revises the change"}
          </footer>
        </blockquote>
      )}
      {item.fix === null ? null : (
        <blockquote className="approval-quote">
          {item.fix.note === "" ? null : <p>{item.fix.note}</p>}
          <footer className="muted">
            Fix in part {item.fix.partId} revision {item.fix.revision}
          </footer>
        </blockquote>
      )}
      {item.review === null ? null : (
        <blockquote className="approval-quote">
          {item.review.text === "" ? null : <p>{item.review.text}</p>}
          <footer className="muted">
            {item.review.by} {item.review.verdict === "approve" ? "approved" : "asked for changes"}
          </footer>
        </blockquote>
      )}
      {item.refusals.length === 0 ? null : (
        <ul className="code-list caller-refusals" aria-label="Refused">
          {item.refusals.map((refusal, index) => (
            <li key={index}>
              <span className="tag tag-failure">{CALLER_REFUSAL_LABEL[refusal.code]}</span>
              <span className="muted">{refusal.by}</span>
            </li>
          ))}
        </ul>
      )}
      {calls.length === 0 ? null : (
        <Disclosure className="part-details" summary={counted(calls.length, "differing call")}>
          <ol className="caller-calls">
            {calls.map((call) => (
              <li key={call.callId} className="caller-call">
                <code className="code-chip">{call.test}</code>
                <ul className="chip-list" aria-label="What differs">
                  <li className="tag tag-data">{call.symbol}</li>
                  {call.differs.map((each) => (
                    <li key={each} className="tag tag-attention">
                      {each}
                    </li>
                  ))}
                </ul>
                <dl className="facts">
                  <SideFact term="Before" side={call.old} />
                  <SideFact term="After" side={call.new} />
                  {call.kind === null ? null : (
                    <div className="fact">
                      <dt>Classified</dt>
                      <dd>
                        <span className={call.kind.kind === "intended" ? "tag tag-data" : "tag tag-attention"}>{call.kind.kind}</span>
                        <span>{call.kind.reason}</span>
                      </dd>
                    </div>
                  )}
                  {call.verdict === null ? null : (
                    <div className="fact">
                      <dt>Review</dt>
                      <dd>
                        <span className={call.verdict.verdict === "approve" ? "tag tag-verified" : "tag tag-attention"}>{call.verdict.verdict === "approve" ? "approved" : "changes requested"}</span>
                        <code className="code-chip">{call.verdict.evidence}</code>
                      </dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ol>
        </Disclosure>
      )}
      {decide === undefined ? null : <DecideForm titleId={titleId} sending={decide.sending} onDecide={decide.onDecide} />}
    </article>
  );
}

function SideFact({ term, side }: { readonly term: string; readonly side: CallerSideView }) {
  const more = side.effectCount - side.effects.length;
  return (
    <div className="fact">
      <dt>{term}</dt>
      <dd>
        <span className="tag tag-data">{callerSideText(side)}</span>
        {side.effects.map((effect, index) => (
          <code key={index} className="code-chip">
            {effect}
          </code>
        ))}
        {more > 0 ? <span className="muted approval-kind">{counted(more, "more effect")}</span> : null}
      </dd>
    </div>
  );
}

/** Approve, or Request changes with the change to ask for, as the plan parts ask for theirs. */
function DecideForm({ titleId, sending, onDecide }: { readonly titleId: string; readonly sending: boolean; readonly onDecide: (verdict: "approve" | "request_changes", text: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const fieldId = useId();
  const requestRef = useRef<HTMLButtonElement | null>(null);
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!sending && text.trim() !== "") onDecide("request_changes", text);
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
  if (!asking) {
    return (
      <div className="approval-actions">
        <button type="button" className="button primary progressive" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || onDecide("approve", "")}>
          {sending ? "Approving" : "Approve"}
        </button>
        <button ref={requestRef} type="button" className="button" aria-disabled={sending} aria-describedby={titleId} onClick={() => sending || setAsking(true)}>
          Request changes
        </button>
      </div>
    );
  }
  return (
    <form className="approval-reason" onSubmit={send} aria-labelledby={titleId}>
      <label htmlFor={fieldId}>Changes to ask for</label>
      <textarea id={fieldId} rows={3} maxLength={4000} value={text} autoFocus readOnly={sending} onKeyDown={onKeyDown} onChange={(event) => setText(event.target.value)} />
      <div className="approval-actions">
        <button type="submit" className="button primary progressive" aria-disabled={sending || text.trim() === ""}>
          {sending ? "Sending" : "Send request"}
        </button>
        <button type="button" className="button quiet" aria-disabled={sending} onClick={() => sending || cancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
