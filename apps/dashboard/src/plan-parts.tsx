// The merge plan parts on the inbox page (PRD 0.4 sections 4.3 and 7): each part that touches the
// signed-in person's code, with its changed lines and why it needs them in person, an Approve control
// and a Request change form; the parts that write a path they protect; the parts of their own plans
// past the round limit; and the reviews of their scopes that raised an exception. The server names the
// decider from the session; an agent never approves. The list is read again on each inbox-changed
// message and after a reconnect. Minimal markup in the current inbox styles; #97 restyles it. Every
// value renders as React text.

import type { PartRoutingReason, PlanInbox, PlanPartRequest, ReviewExceptionRequest } from "@penguin/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";

import { decidePlanPart, fetchPlanInbox, SignedOut } from "./api.ts";
import type { Live } from "./use-live.ts";

interface Props {
  readonly live: Live;
  readonly onSignedOut: () => void;
}

/** Why a part needs its author in person, as one short line. */
export function reasonLabel(reason: PartRoutingReason): string {
  switch (reason.kind) {
    case "broken_invariant":
      return `The review reports ${reason.invariant} broken in ${reason.scope}`;
    case "protected_difference":
      return `${reason.differing} inputs of ${reason.contract} differ on protected ${reason.invariant}`;
    case "protected_path":
      return `Writes ${reason.file}, under ${reason.path}, which ${reason.owner} protects`;
  }
}

/** A review exception as one short line. */
export function exceptionLabel(exception: ReviewExceptionRequest["exceptions"][number]): string {
  return exception.kind === "broken_invariant"
    ? `${exception.invariant} reported broken`
    : `${exception.differing} inputs of ${exception.contract} differ on protected ${exception.invariant}`;
}

const ASK_TITLE: Readonly<Record<PlanPartRequest["ask"], string>> = {
  approve: "Approve or request a change",
  protected_path: "Confirm the lines under your protected path",
  round_limit: "Past the round limit: the agents stopped",
};

interface ListProps {
  readonly inbox: PlanInbox;
  /** The part whose decision is sending, by part id. */
  readonly busy: string | undefined;
  readonly onApprove: (part: PlanPartRequest) => void;
  readonly onRequestChange: (part: PlanPartRequest, text: string) => void;
}

/** One part: its place, revision, changed lines, routing reasons and the controls its ask allows. */
function PartRow({ part, busy, onApprove, onRequestChange }: { readonly part: PlanPartRequest } & Omit<ListProps, "inbox">) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const fieldId = useId();
  const place = part.place.kind === "scope" ? `scope ${part.place.scope}` : `feature ${part.place.feature}`;
  const sending = busy === part.partId;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== "") onRequestChange(part, text);
  };
  return (
    <li className="inbox-row plan-part">
      <span className="inbox-row-text">
        <span className="inbox-row-title">
          {ASK_TITLE[part.ask]}: {part.partId} revision {part.revision}
        </span>
        <span className="inbox-row-meta">
          <span className="inbox-row-preview">
            {part.feature} by {part.person} changes {place}, {part.kind}, {part.state.replaceAll("_", " ")}, round {part.changeRequests} of{" "}
            {part.roundLimit}
          </span>
        </span>
        {part.routing.reasons.map((reason, index) => (
          <span key={index} className="inbox-row-preview">
            {reasonLabel(reason)}
          </span>
        ))}
        {part.changeRequest === null ? null : (
          <span className="inbox-row-preview">
            {part.changeRequest.by} asked on revision {part.changeRequest.revision}: {part.changeRequest.text}
          </span>
        )}
        {part.files.map((file) => (
          <details key={file.path}>
            <summary>
              {file.path} ({file.status})
            </summary>
            <pre>{file.lines.join("\n")}</pre>
          </details>
        ))}
      </span>
      {part.ask === "approve" ? (
        <span className="plan-part-controls">
          <button type="button" className="button primary" disabled={sending} onClick={() => onApprove(part)}>
            Approve revision {part.revision}
          </button>
          {part.state !== "pending" ? null : asking ? (
            <form className="approval-reason" onSubmit={send}>
              <label htmlFor={fieldId}>Change to ask for</label>
              <textarea id={fieldId} rows={3} maxLength={2000} value={text} readOnly={sending} onChange={(event) => setText(event.target.value)} />
              <button type="submit" className="button" disabled={sending || text.trim() === ""}>
                Send request
              </button>
            </form>
          ) : (
            <button type="button" className="button quiet" onClick={() => setAsking(true)}>
              Request change
            </button>
          )}
        </span>
      ) : null}
    </li>
  );
}

/** The plan parts and review exceptions, with their controls; renders nothing when empty. */
export function PlanPartList({ inbox, busy, onApprove, onRequestChange }: ListProps) {
  if (inbox.parts.length === 0 && inbox.reviewExceptions.length === 0) return null;
  return (
    <>
      {inbox.parts.length === 0 ? null : (
        <section className="inbox-group" aria-labelledby="inbox-plan-parts">
          <h2 id="inbox-plan-parts" className="inbox-group-heading">
            Merge plan parts <span className="muted">{inbox.parts.length}</span>
          </h2>
          <ol className="inbox-rows">
            {inbox.parts.map((part) => (
              <PartRow key={`${part.ask}/${part.partId}`} part={part} busy={busy} onApprove={onApprove} onRequestChange={onRequestChange} />
            ))}
          </ol>
        </section>
      )}
      {inbox.reviewExceptions.length === 0 ? null : (
        <section className="inbox-group" aria-labelledby="inbox-review-exceptions">
          <h2 id="inbox-review-exceptions" className="inbox-group-heading">
            Review exceptions <span className="muted">{inbox.reviewExceptions.length}</span>
          </h2>
          <ol className="inbox-rows">
            {inbox.reviewExceptions.map((item) => (
              <li key={item.reviewId} className="inbox-row">
                <span className="inbox-row-text">
                  <span className="inbox-row-title">
                    Review {item.reviewId} of {item.scope} on {item.feature}, {item.state}
                  </span>
                  {item.exceptions.map((exception, index) => (
                    <span key={index} className="inbox-row-preview">
                      {exceptionLabel(exception)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

const EMPTY: PlanInbox = { parts: [], reviewExceptions: [] };

export function PlanParts({ live, onSignedOut }: Props) {
  const [inbox, setInbox] = useState<PlanInbox>(EMPTY);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const connected = live.status === "live";

  useEffect(() => {
    let current = true;
    fetchPlanInbox().then(
      (value) => {
        if (current) setInbox(value);
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
      },
    );
    return () => {
      current = false;
    };
  }, [live.inboxRevision, connected, reloads, onSignedOut]);

  const decide = (part: PlanPartRequest, text?: string) => {
    setBusy(part.partId);
    setFailed(false);
    const decision = { feature: part.feature, part: part.partId, revision: part.revision };
    decidePlanPart(text === undefined ? { kind: "approve", ...decision } : { kind: "request_change", ...decision, text }).then(
      () => {
        setBusy(undefined);
        setReloads((count) => count + 1);
      },
      (error: unknown) => {
        setBusy(undefined);
        if (error instanceof SignedOut) onSignedOut();
        else setFailed(true);
      },
    );
  };

  return (
    <>
      {failed ? (
        <p className="notice" role="alert">
          Please try that decision again
        </p>
      ) : null}
      <PlanPartList inbox={inbox} busy={busy} onApprove={(part) => decide(part)} onRequestChange={(part, text) => decide(part, text)} />
    </>
  );
}
