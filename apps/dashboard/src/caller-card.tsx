// One caller item (#188) as a card: the receiving worktree and the contract the change reaches there,
// its state and who it waits on, what Penguin replayed (the receiving feature's tests on main and with
// the originating feature, #214), each call site with its verdict, then the first differing call open
// with its two sides and the rest behind a line counting them, each with the originating agent's
// classification and the receiving agent's verdict and evidence, what the agents and people wrote, quoted. Below the quotes, a short reason tag names
// each answer Penguin refused since the item last moved (#189). The feature page lists the cards for
// the callers a change reaches and for those in its own worktree; the worktree owner's approvals
// inbox lists the cards sent to them, with Approve and Request changes on each they decide. Every
// value renders as React text.

import { CALLER_PARTY_LABEL, CALLER_REFUSAL_LABEL, CALLER_STATE_LABEL, callerApprovalLabel, type CallerItemView, type CallerSideView } from "@penguin/protocol";
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
  const [first, ...rest] = item.differing;
  // Penguin replayed tests unless no test reached any call site.
  const replayed = item.callers.some((caller) => caller.verdict !== "unknown_reach");
  const changed = item.callers.reduce((sum, caller) => sum + caller.differingCount, 0);
  // A fix Penguin approved under caller sudo names its approver: the receiving agent once it approves (#222).
  const approval = callerApprovalLabel(item);
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
        {approval === null ? null : <li className="tag tag-verified caller-approval">{approval}</li>}
        {item.rejections === 0 ? null : <li className="tag tag-data">{counted(item.rejections, "rejection")}</li>}
        {told ? <li className="tag tag-data">No decision needed</li> : null}
      </ul>
      {replayed ? (
        <p className="approval-line caller-replay">
          <span>{`Penguin ran ${item.feature}'s tests on main and with ${item.origin}`}</span>
          <span className={changed === 0 ? "tag tag-verified" : "tag tag-attention"}>{counted(changed, "call")} changed</span>
        </p>
      ) : null}
      <ul className="code-list caller-sites" aria-label="Call sites">
        {item.callers.map((caller) => (
          <li key={`${caller.path}:${caller.line}`}>
            <code className="code-chip">
              {caller.path}:{caller.line}
            </code>
            <span className={VERDICT_CLASS[caller.verdict]}>{VERDICT_LABEL[caller.verdict]}</span>
            <span className="muted">
              {caller.matched} of {counted(caller.calls, "call")} same as on main
            </span>
          </li>
        ))}
      </ul>
      {first === undefined ? null : <ReplayedCall call={first} origin={item.origin} />}
      {rest.length === 0 ? null : (
        <Disclosure className="part-details" summary={counted(rest.length, "more changed call")}>
          <ol className="caller-calls">
            {rest.map((call) => (
              <li key={call.callId}>
                <ReplayedCall call={call} origin={item.origin} />
              </li>
            ))}
          </ol>
        </Disclosure>
      )}
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
          {item.fix.rule === null ? null : (
            <p>
              <code className="code-chip">{item.fix.rule.pattern}</code> becomes <code className="code-chip">{item.fix.rule.replacement}</code>
            </p>
          )}
          <footer className="muted">{item.fix.rule === null ? `Fix in part ${item.fix.partId} revision ${item.fix.revision}` : `Rule ${item.fix.revision}, applied by Penguin's check runner`}</footer>
        </blockquote>
      )}
      {item.fix === null || item.fix.rewritten.length === 0 ? null : (
        <ul className="code-list caller-sites" aria-label="Rewritten sites">
          {item.fix.rewritten.map((site) => (
            <li key={site.path}>
              <code className="code-chip">
                {site.path}:{site.lines.join(", ")}
              </code>
              <span className="muted">Rewritten by the rule</span>
            </li>
          ))}
        </ul>
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
      {decide === undefined ? null : <DecideForm titleId={titleId} sending={decide.sending} onDecide={decide.onDecide} />}
    </article>
  );
}

type DifferingCall = CallerItemView["differing"][number];

/** What differs, as the replay names it, mapped to the field each side shows it in. */
const RESULT_DIFFERS = new Set(["result", "exception", "missing", "extra"]);

/** One differing call: its test and function, then the call on main and with the change side by side, the differing field marked on both. */
function ReplayedCall({ call, origin }: { readonly call: DifferingCall; readonly origin: string }) {
  const marks = { result: call.differs.some((each) => RESULT_DIFFERS.has(each)), effects: call.differs.includes("effects") };
  return (
    <div className="caller-call">
      <code className="code-chip">{call.test}</code>
      <ul className="chip-list" aria-label="Call">
        <li className="tag tag-data">{call.symbol}</li>
      </ul>
      <div className="caller-sides">
        <CallSide label="On main" side={call.old} marks={marks} />
        <CallSide label={`With ${origin}`} side={call.new} marks={marks} />
      </div>
      {call.kind === null && call.verdict === null ? null : (
        <dl className="facts">
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
      )}
    </div>
  );
}

function CallSide({ label, side, marks }: { readonly label: string; readonly side: CallerSideView; readonly marks: { readonly result: boolean; readonly effects: boolean } }) {
  const more = side.effectCount - side.effects.length;
  return (
    <section className="caller-side" aria-label={label}>
      <p className="sbs-label">{label}</p>
      <dl className="facts">
        <div className="fact">
          <dt>Result</dt>
          <dd>
            {side.value === null ? <span className="tag tag-data">{callerSideText(side)}</span> : <code className="code-chip">{side.value}</code>}
            {marks.result ? <span className="tag tag-attention">differs</span> : null}
          </dd>
        </div>
        {side.effectCount === 0 && !marks.effects ? null : (
          <div className="fact">
            <dt>Effects</dt>
            <dd>
              {side.effectCount === 0 ? <span className="muted approval-kind">none</span> : null}
              {side.effects.map((effect, index) => (
                <code key={index} className="code-chip">
                  {effect}
                </code>
              ))}
              {more > 0 ? <span className="muted approval-kind">{counted(more, "more effect")}</span> : null}
              {marks.effects ? <span className="tag tag-attention">differs</span> : null}
            </dd>
          </div>
        )}
      </dl>
    </section>
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
