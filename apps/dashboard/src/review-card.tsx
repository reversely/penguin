// The facts behind a plan part or a review exception (PRD sections 6 and 10): the review form row by
// row beside each invariant's statement, Penguin's refusals, the side-by-side run with its tool and the
// inputs whose outcome differs between main and the fork, the tests that break, and the fix's changed
// lines. The approvals inbox and the feature page share these, so one review reads the same on each.
// Every value renders as React text.

import type { BreakView, PlanPartFile, ReviewView, SideBySideSetView } from "@penguin/protocol";

import { Agent } from "./agent-directory.tsx";
import { Disclosure } from "./disclosure.tsx";
import { counted, reviewExceptionText, shortSha } from "./feature-view.ts";

const VERDICT_CLASS: Readonly<Record<string, string>> = {
  holds: "verdict verdict-holds",
  breaks: "verdict verdict-breaks",
  unknown: "verdict verdict-unknown",
};

/** One review: who reviewed which scope, the runner's verdict, the form's rows and the side-by-side run. */
export function ReviewCard({ review }: { readonly review: ReviewView }) {
  return (
    <section className="review card-raised" aria-label={`Review of ${review.scope}`}>
      <header className="review-head">
        <h4 className="review-title">Review of {review.scope}</h4>
        <span className={`tag review-state review-state-${review.state}`}>{review.state}</span>
      </header>
      <div className="review-meta">
        <Agent handle={review.reviewer} variant="compact" />
        <span className="muted">
          form checked on <code>{shortSha(review.checkpoint)}</code>
        </span>
      </div>
      <ul className="review-rows" aria-label="Review form">
        {review.rows.map((row) => (
          <li key={row.invariant} className="review-row">
            <span className="review-row-head">
              <span className={VERDICT_CLASS[row.verdict] ?? "verdict"}>{row.verdict}</span>
              <span className="review-invariant">{row.statement === "" ? row.invariant : row.statement}</span>
              {row.protected ? <span className="tag tag-data">protected</span> : null}
            </span>
            <span className="review-evidence">
              {row.evidence.map((evidence) => (
                <code key={evidence} className="code-chip">
                  {evidence}
                </code>
              ))}
            </span>
            {row.storedData === "" ? null : <span className="muted review-stored">{row.storedData}</span>}
          </li>
        ))}
      </ul>
      {review.storedDataMarker === null ? null : (
        <p className="muted review-stored">
          {review.storedDataMarker.kind} marker <code>{review.storedDataMarker.evidence}</code>
        </p>
      )}
      {review.refusals.length === 0 ? null : (
        <ul className="review-refusals" aria-label="Refused">
          {review.refusals.map((refusal, index) => (
            <li key={index}>
              <code>{refusal.code}</code> {refusal.message}
            </li>
          ))}
        </ul>
      )}
      {review.exceptions.length === 0 ? null : (
        <ul className="review-exceptions" aria-label="Exceptions">
          {review.exceptions.map((exception, index) => (
            <li key={index}>{reviewExceptionText(exception)}</li>
          ))}
        </ul>
      )}
      {review.sideBySide === null ? (
        <p className="muted">Side-by-side run waiting for the check runner</p>
      ) : (
        <div className="side-by-side">
          <p className="tool-line">
            <code className="tool-name">{review.sideBySide.tool}</code>
            <code className="muted">{review.sideBySide.commandId}</code>
            <span>
              {review.sideBySide.totals.differing} of {counted(review.sideBySide.totals.inputs, "input")} differ between main{" "}
              <code>{shortSha(review.sideBySide.base)}</code> and the fork <code>{shortSha(review.sideBySide.fork)}</code>
            </span>
          </p>
          {review.sideBySide.sets.map((set, index) => (
            <SideBySideSet key={index} set={set} />
          ))}
        </div>
      )}
    </section>
  );
}

function SideBySideSet({ set }: { readonly set: SideBySideSetView }) {
  return (
    <div className="sbs-set">
      <p className="sbs-set-head">
        <code>{set.contract}</code>
        <span className="muted">
          on {set.file ?? "the form's risky inputs"}: {set.differing.length + set.omitted} of {set.inputs} differ
          {set.invalid > 0 ? `, ${set.invalid} not run` : ""}
        </span>
      </p>
      {set.differing.length === 0 ? null : (
        <ul className="sbs-differences">
          {set.differing.map((difference) => (
            <li key={difference.name} className="sbs-difference">
              <span className="sbs-name">{difference.name}</span>
              <span className="sbs-side">
                <span className="sbs-label">main</span>
                <code>{difference.main}</code>
              </span>
              <span className="sbs-side">
                <span className="sbs-label">fork</span>
                <code>{difference.fork}</code>
              </span>
            </li>
          ))}
          {set.omitted > 0 ? <li className="muted">{counted(set.omitted, "more input")}</li> : null}
        </ul>
      )}
    </div>
  );
}

/** The tests that break in a place once the change merges, each with what it protects and where it stopped. */
export function BreakList({ breaks }: { readonly breaks: readonly BreakView[] }) {
  if (breaks.length === 0) return null;
  return (
    <ul className="break-list" aria-label="Breaks">
      {breaks.map((each) => (
        <li key={`${each.target} ${each.nodeId}`} className="break">
          <span className="break-statement">{each.statement}</span>
          <code className="break-node">
            {each.nodeId} on {each.target}
          </code>
          {each.assertion === null ? null : <code className="break-line">{each.assertion}</code>}
          {each.error === null ? null : <code className="break-line break-error">{each.error}</code>}
        </li>
      ))}
    </ul>
  );
}

/** A fix's changed lines, one file per block, each line marked added, removed or context. */
export function DiffFiles({ files }: { readonly files: readonly PlanPartFile[] }) {
  return (
    <div className="diff-files">
      {files.map((file) => (
        <Disclosure
          key={file.path}
          className="diff-file"
          initiallyOpen={files.length <= 2}
          summary={
            <>
              <code>{file.path}</code> <span className="muted">{file.status}</span>
            </>
          }
        >
          <pre className="diff">
            {file.lines.map((line, index) => (
              <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "diff-context"}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </Disclosure>
      ))}
    </div>
  );
}
