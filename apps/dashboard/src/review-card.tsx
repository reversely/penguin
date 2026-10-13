// The facts behind a plan part or a review exception (PRD sections 6 and 10): the review form row by
// row beside each invariant's statement, Penguin's refusals, the side-by-side run with its tool and the
// inputs whose outcome differs between main and the fork, the tests that break, and the fix's changed
// lines. The approvals inbox and the feature page share these, so one review reads the same on each.
// A set with thousands of differing inputs shows a summary: the count, how they spread over the length
// of the list they share and a few examples, with the full table (GET /api/reviews/<id>/differences)
// one press away, a page at a time. Every value renders as React text.

import { VALIDATION_KIND_LABEL, type BreakView, type PlanPartFile, type ReviewDifferences, type ReviewDifferenceSet, type ReviewView, type SideBySideBreakdown, type SideBySideSetView } from "@penguin/protocol";
import { useEffect, useId, useRef, useState } from "react";

import { Agent } from "./agent-directory.tsx";
import { fetchReviewDifferences } from "./api.ts";
import { Disclosure } from "./disclosure.tsx";
import { counted, formatCount, reviewAnchor, reviewExceptionText, shortSha } from "./feature-view.ts";
import { Icon } from "./icon.tsx";

const VERDICT_CLASS: Readonly<Record<string, string>> = {
  holds: "verdict verdict-holds",
  breaks: "verdict verdict-breaks",
  unknown: "verdict verdict-unknown",
};

/**
 * One review: who reviewed which scope, the runner's verdict, the form's rows and the side-by-side run.
 * From a wide card the form and the run sit side by side, so a plan's card fits one screen.
 */
export function ReviewCard({ review }: { readonly review: ReviewView }) {
  return (
    <section className="review card-raised" id={reviewAnchor(review.reviewId)} aria-label={`Review of ${review.scope}`} tabIndex={-1}>
      <div className="review-form">
        <header className="review-head">
          <h4 className="review-title">Review of {review.scope}</h4>
          <span className="tag tag-data kind-tag">{VALIDATION_KIND_LABEL.logic}</span>
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
            <span className="tag tag-data kind-tag">{VALIDATION_KIND_LABEL.stored_data}</span>{" "}
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
      </div>
      {review.sideBySide === null ? (
        <p className="muted">Side-by-side run waiting for the check runner</p>
      ) : (
        <div className="side-by-side">
          <p className="tool-line">
            <span className="tag tag-data kind-tag">{VALIDATION_KIND_LABEL.data_matching}</span>
            <code className="tool-name">{review.sideBySide.tool}</code>
            <code className="muted">{review.sideBySide.commandId}</code>
            <span>
              {formatCount(review.sideBySide.totals.differing)} of {counted(review.sideBySide.totals.inputs, "input")} differ between main{" "}
              <code>{shortSha(review.sideBySide.base)}</code> and the fork <code>{shortSha(review.sideBySide.fork)}</code>
            </span>
          </p>
          {review.sideBySide.sets.map((set, index) => (
            <SideBySideSet key={index} set={set} reviewId={review.reviewId} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Differing inputs a set's summary shows before its full table opens. */
export const SUMMARY_EXAMPLES = 3;
/** Rows per page of a set's full table, so the page never renders thousands of rows at once. */
export const TABLE_PAGE = 100;

interface SetProps {
  readonly set: SideBySideSetView;
  readonly reviewId: number;
  /** The set's place in the run, which names it in the full table's answer. */
  readonly index: number;
}

/**
 * One contract's run over one examples file: the count, how the differing inputs spread over their
 * shared list's length, a few examples, and the full table one press away. A short set shows every
 * differing input at once.
 */
function SideBySideSet({ set, reviewId, index }: SetProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // Closing a long table pulls the button up past the screen; it is brought back into view.
  const toggle = () => {
    setOpen(!open);
    if (open) requestAnimationFrame(() => toggleRef.current?.scrollIntoView({ block: "nearest" }));
  };
  const tableId = useId();
  const total = set.differing.length + set.omitted;
  const long = total > SUMMARY_EXAMPLES;
  return (
    <div className="sbs-set">
      <p className="sbs-set-head">
        <code>{set.contract}</code>
        <span className="muted">
          on {set.file ?? "the form's risky inputs"}
        </span>
        <span className="muted">
          {formatCount(total)} of {formatCount(set.inputs)} differ
        </span>
        <span className="muted">{set.invalid > 0 ? `${formatCount(set.invalid)} not run` : null}
        </span>
      </p>
      {set.breakdown === null || !long ? null : <Breakdown breakdown={set.breakdown} />}
      {open ? (
        <div id={tableId}>
          <DifferenceTable reviewId={reviewId} index={index} />
        </div>
      ) : set.differing.length === 0 ? null : (
        <ul className="sbs-differences" aria-label="Examples">
          {(long ? set.differing.slice(0, SUMMARY_EXAMPLES) : set.differing).map((difference) => (
            <DifferenceRow key={difference.name} name={difference.name} main={difference.main} fork={difference.fork} />
          ))}
        </ul>
      )}
      {long ? (
        <button ref={toggleRef} type="button" className="button quiet sbs-toggle" aria-expanded={open} aria-controls={open ? tableId : undefined} onClick={toggle}>
          <span className="disclosure-mark" data-open={open ? true : undefined}>
            <Icon name="chevron" />
          </span>
          {open ? "Fewer inputs" : `All ${counted(total, "differing input")}`}
        </button>
      ) : null}
    </div>
  );
}

/** How many differing inputs hold a list of each length, as a two-row table: the length, then the count. */
function Breakdown({ breakdown }: { readonly breakdown: SideBySideBreakdown }) {
  return (
    <div className="sbs-breakdown">
      <table>
        <caption className="visually-hidden">Differing inputs by number of {breakdown.list}</caption>
        <tbody>
          <tr>
            <th scope="row">{breakdown.list}</th>
            {breakdown.counts.map((count) => (
              <td key={count.length}>{formatCount(count.length)}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">differ</th>
            {breakdown.counts.map((count) => (
              <td key={count.length}>{formatCount(count.inputs)}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  readonly name: string;
  readonly main: string;
  readonly fork: string;
  /** The input's list length with the list's key, in the full table of a set with a breakdown. */
  readonly length?: string;
}

function DifferenceRow({ name, main, fork, length }: RowProps) {
  return (
    <li className="sbs-difference">
      <span className="sbs-name">
        {name}
        {length === undefined ? null : <span className="sbs-length">{length}</span>}
      </span>
      <span className="sbs-side">
        <span className="sbs-label">main</span>
        <code>{main}</code>
      </span>
      <span className="sbs-side">
        <span className="sbs-label">fork</span>
        <code>{fork}</code>
      </span>
    </li>
  );
}

/** Each review's full table, read once per page load: a recorded run never changes. */
const tables = new Map<number, Promise<ReviewDifferences>>();

function readTable(reviewId: number): Promise<ReviewDifferences> {
  let table = tables.get(reviewId);
  if (table === undefined) {
    table = fetchReviewDifferences(reviewId);
    // A failed read is tried again the next time the table opens.
    table.catch(() => tables.delete(reviewId));
    tables.set(reviewId, table);
  }
  return table;
}

type TableRead = { readonly kind: "loading" } | { readonly kind: "ready"; readonly set: ReviewDifferenceSet | undefined } | { readonly kind: "failed" };

/** A set's every differing input, a page of TABLE_PAGE rows at a time. */
function DifferenceTable({ reviewId, index }: { readonly reviewId: number; readonly index: number }) {
  const [read, setRead] = useState<TableRead>({ kind: "loading" });
  const [page, setPage] = useState(0);
  useEffect(() => {
    let current = true;
    readTable(reviewId).then(
      (table) => current && setRead({ kind: "ready", set: table.sets[index] }),
      () => current && setRead({ kind: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [reviewId, index]);
  if (read.kind === "loading") return <div className="sbs-table" aria-busy="true" />;
  if (read.kind === "failed" || read.set === undefined) {
    return (
      <p className="notice" role="alert">
        Please open the table again
      </p>
    );
  }
  const { differing, list, omitted } = read.set;
  const pages = Math.max(1, Math.ceil(differing.length / TABLE_PAGE));
  const first = page * TABLE_PAGE;
  const rows = differing.slice(first, first + TABLE_PAGE);
  return (
    <div className="sbs-table">
      <ul className="sbs-differences" aria-label="Differing inputs">
        {rows.map((row) => (
          <DifferenceRow key={row.name} name={row.name} main={row.main} fork={row.fork} length={list === null || row.length === null ? undefined : `${list} ${formatCount(row.length)}`} />
        ))}
        {omitted > 0 && page === pages - 1 ? <li className="muted">{counted(omitted, "more input")}</li> : null}
      </ul>
      {pages === 1 ? null : (
        <div className="sbs-pager">
          <button type="button" className="button quiet" aria-disabled={page === 0} onClick={() => page > 0 && setPage(page - 1)}>
            Previous
          </button>
          <span className="muted" aria-live="polite">
            {formatCount(first + 1)} to {formatCount(first + rows.length)} of {formatCount(differing.length)}
          </span>
          <button type="button" className="button quiet" aria-disabled={page === pages - 1} onClick={() => page < pages - 1 && setPage(page + 1)}>
            Next
          </button>
        </div>
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
