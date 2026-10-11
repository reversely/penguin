// The overlapping starts on the inbox page (PRD 0.4 section 4.1 step 3): each feature whose start
// waits for the signed-in person's approval beside one of their running features, where the two
// areas meet, and an Approve start control. The server names the approver from the session. The list
// is read again on each inbox-changed message and after a reconnect. Minimal markup in the current
// inbox styles; the F1 dashboard work restyles it. Every value renders as React text.

import type { OverlapRequest } from "@penguin/protocol";
import { useEffect, useState } from "react";

import { approveOverlap, fetchOverlapRequests, SignedOut } from "./api.ts";
import type { Live } from "./use-live.ts";

interface Props {
  readonly live: Live;
  readonly onSignedOut: () => void;
}

/** Where two areas meet, as bare labels. */
export function overlapLabel(overlap: OverlapRequest["overlap"]): string {
  const parts = [...overlap.scopes, ...overlap.contracts, ...overlap.paths];
  return overlap.omittedPaths > 0 ? `${parts.join(", ")} +${overlap.omittedPaths}` : parts.join(", ");
}

export function OverlapRequests({ live, onSignedOut }: Props) {
  const [requests, setRequests] = useState<readonly OverlapRequest[]>([]);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const connected = live.status === "live";

  useEffect(() => {
    let current = true;
    fetchOverlapRequests().then(
      (value) => {
        if (current) setRequests(value);
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
      },
    );
    return () => {
      current = false;
    };
  }, [live.inboxRevision, connected, reloads, onSignedOut]);

  if (requests.length === 0) return null;

  const approve = (request: OverlapRequest) => {
    const key = `${request.feature}/${request.blockedFeature}`;
    setBusy(key);
    setFailed(false);
    approveOverlap(request).then(
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
    <section className="inbox-group" aria-labelledby="inbox-overlaps">
      <h2 id="inbox-overlaps" className="inbox-group-heading">
        Overlapping starts <span className="muted">{requests.length}</span>
      </h2>
      {failed ? (
        <p className="notice" role="alert">
          Please try approving it again
        </p>
      ) : null}
      <ol className="inbox-rows">
        {requests.map((request) => {
          const key = `${request.feature}/${request.blockedFeature}`;
          return (
            <li key={key} className="inbox-row">
              <span className="inbox-row-text">
                <span className="inbox-row-title">
                  {request.blockedFeature} by {request.blockedPerson}
                </span>
                <span className="inbox-row-meta">
                  <span className="inbox-row-preview">
                    beside {request.feature}: {overlapLabel(request.overlap)}
                  </span>
                </span>
              </span>
              <button type="button" className="button primary" disabled={busy === key} onClick={() => approve(request)}>
                Approve start
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
