// The feature's code changes as a tree (#124): the contract change first, then each place the plan
// fixes, then its files, then each file's hunks. Every node is a fold; only what needs the viewer opens
// on its own. A place's lines show only to the people the server sends them to (mayReadPartLines,
// #108); anyone else sees the place, its state and its facts. Every value renders as React text.

import type { ContractWorkView, FeaturePlanView, FixView, PartFileView, PlanHunk, PlanPartView } from "@penguin/protocol";
import { useState } from "react";

import { PersonAvatar } from "./avatar.tsx";
import { hunkHeader, hunkRows, lineCounts } from "./diff-view.ts";
import { counted, partNumber, partStateText, roundText, shortSha } from "./feature-view.ts";
import { Fold } from "./fold.tsx";
import { linkHandler } from "./links.ts";
import { CONTRACT_FOLD } from "./page-view.ts";
import { partAnchor, placeName } from "./pipeline-view.ts";
import { BreakList } from "./review-card.tsx";
import { featurePath, personPath } from "./routes.ts";

/** Lines of one file shown before a "more lines" button. */
export const FILE_LINE_CAP = 80;
/** Rows of a contract list shown before a "more" button. */
const LIST_CAP = 8;



/** The element id of a file's node under its part. */
export function fileAnchor(partId: string, index: number): string {
  return `${partAnchor(partId)}-file-${index + 1}`;
}

interface TreeProps {
  readonly plan: FeaturePlanView | null;
  readonly contract: ContractWorkView | null;
  /** Each part's write into another fork. */
  readonly fixes: readonly FixView[];
  readonly person: string;
  readonly navigate: (path: string) => void;
}

export function ChangeTree({ plan, contract, fixes, person, navigate }: TreeProps) {
  const hasContract = plan?.contractDiff != null || (contract?.entries.length ?? 0) > 0 || (contract?.split?.retiring.length ?? 0) > 0;
  return (
    <div className="change-tree">
      {!hasContract && plan === null ? (
        <p className="muted">Waiting for the agent's merge plan</p>
      ) : (
        <ol className="tree">
          {hasContract ? (
            <li>
              <ContractNode plan={plan} contract={contract} />
            </li>
          ) : null}
          {plan?.parts.map((part) => (
            <li key={part.partId}>
              <PartNode part={part} plan={plan} fix={fixes.find((fix) => fix.partId === part.partId)} person={person} navigate={navigate} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The contract change: each signature before and after, the sorted entries, what retires and the callers on main. */
function ContractNode({ plan, contract }: { readonly plan: FeaturePlanView | null; readonly contract: ContractWorkView | null }) {
  const diff = plan?.contractDiff ?? null;
  const breaking = diff?.signatures.filter((signature) => signature.breaking).length ?? 0;
  const entries = contract?.entries.filter((entry) => entry.sort === "incompatible" || entry.sort === "behaviour") ?? [];
  const retiring = contract?.split?.retiring ?? [];
  const changes = diff?.changes.length ?? contract?.entries.length ?? 0;
  return (
    <Fold
      id={CONTRACT_FOLD}
      className="tree-node tree-contract"
      summary={
        <span className="tree-head">
          <span className="tree-title">Contract</span>
          <span className="tag tag-data">{counted(changes, "change")}</span>
          {breaking > 0 ? <span className="tag tag-attention">{counted(breaking, "breaking signature")}</span> : null}
          {contract?.decision === "split" ? <span className="tag tag-data">split</span> : null}
        </span>
      }
    >
      <div className="tree-body">
        {diff === null || diff.signatures.length === 0 ? null : (
          <ul className="signature-list" aria-label="Signatures">
            {diff.signatures.map((signature) => (
              <li key={signature.symbol}>
                <code className="signature-symbol">{signature.symbol}</code>
                <pre className="diff">
                  <span className="diff-remove">-{signature.before}</span>
                  <span className="diff-add">+{signature.after}</span>
                </pre>
              </li>
            ))}
          </ul>
        )}
        {diff === null || diff.dataShapes.length === 0 ? null : (
          <ul className="signature-list" aria-label="Stored data shapes">
            {diff.dataShapes.map((shape) => (
              <li key={shape.symbol}>
                <code className="signature-symbol">{shape.symbol}</code>
                <pre className="diff">
                  <span className="diff-remove">-{shape.before.join(", ")}</span>
                  <span className="diff-add">+{shape.after.join(", ")}</span>
                </pre>
              </li>
            ))}
          </ul>
        )}
        {retiring.length === 0 ? null : (
          <ul className="code-list" aria-label="Retiring">
            {retiring.map((each) => (
              <li key={each.contract}>
                <span className="tag tag-data">retiring</span> <code>{each.contract}</code> <span className="muted">to</span> <code>{each.replacement}</code>
              </li>
            ))}
          </ul>
        )}
        {entries.length === 0 ? null : (
          <Capped
            label="Sorted"
            items={entries}
            render={(entry) => (
              <li key={`${entry.symbol} ${entry.sort}`}>
                <span className={entry.sort === "incompatible" ? "tag tag-attention" : "tag tag-data"}>{entry.sort}</span> <code>{entry.symbol}</code>
                {entry.to === null ? null : (
                  <>
                    <span className="muted">to</span> <code>{entry.to.symbol}</code>
                  </>
                )}
                <span className="muted">{counted(entry.callers, "caller")}</span>
              </li>
            )}
          />
        )}
        {diff === null || entries.length > 0 ? null : (
          <Capped
            label="Changed symbols"
            items={diff.changes}
            render={(change) => (
              <li key={`${change.symbol} ${change.change}`}>
                <span className="tag tag-data">{change.change}</span> <code>{change.symbol}</code>{" "}
                <span className="muted">
                  {change.path}:{change.line}
                </span>
              </li>
            )}
          />
        )}
        {plan === null || plan.mainCallers.length === 0 ? null : (
          <Fold id="change-callers" className="tree-node" summary={<span className="tree-title">{counted(plan.mainCallers.length, "caller")} on main</span>}>
            <Capped
              label="Callers on main"
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
          </Fold>
        )}
      </div>
    </Fold>
  );
}

/** The first LIST_CAP rows of a list, then a button that shows the rest. */
function Capped<T>({ label, items, render }: { readonly label: string; readonly items: readonly T[]; readonly render: (item: T) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const rest = items.length - LIST_CAP;
  return (
    <ul className="code-list" aria-label={label}>
      {(all ? items : items.slice(0, LIST_CAP)).map(render)}
      {rest > 0 && !all ? (
        <li>
          <button type="button" className="button quiet show-more" onClick={() => setAll(true)}>
            {rest} more
          </button>
        </li>
      ) : null}
    </ul>
  );
}

export function partTagClass(part: Pick<PlanPartView, "state">): string {
  return part.state === "approved" ? "tag tag-verified" : part.state === "pending" ? "tag tag-attention" : "tag";
}

/** One place the plan fixes: its owner and state, then its files, then its facts. */
interface PartProps {
  readonly part: PlanPartView;
  readonly plan: FeaturePlanView;
  readonly fix: FixView | undefined;
  readonly person: string;
  readonly navigate: (path: string) => void;
}

const WRITE_TEXT: Readonly<Record<string, string>> = {
  queued: "Write queued for the check runner",
  granted: "Write token granted",
  written: "Written",
  withdrawn: "Write withdrawn",
};

function PartNode({ part, plan, fix, person, navigate }: PartProps) {
  const anchor = partAnchor(part.partId);
  const ownerPath = personPath(part.owner);
  return (
    <Fold
      id={anchor}
      className="tree-node"
      summary={
        <span className="tree-head">
          <span className="tree-title">
            {partNumber(part.partId)} {placeName(part.place)}
          </span>
          <span className="approval-person">
            <PersonAvatar id={part.owner} size="card" />
            {part.owner}
          </span>
          <span className={partTagClass(part)}>{partStateText(part.state, part.approvedBy)}</span>
          {part.files === null ? null : <span className="muted">{counted(part.files.length, "file")}</span>}
        </span>
      }
    >
      <div className="tree-body">
        <p className="tree-meta">
          {part.place.kind === "feature" ? (
            <a className="feature-link" href={featurePath(part.place.feature)} onClick={linkHandler(navigate, featurePath(part.place.feature))}>
              {part.place.feature}
            </a>
          ) : (
            <span>scope {part.place.scope}</span>
          )}
          <a className="feature-link" href={ownerPath} onClick={linkHandler(navigate, ownerPath)}>
            {part.owner}
          </a>
          <span className="tag tag-data">{part.kind}</span>
          <span className="muted">
            revision {part.revision} {roundText(part.changeRequests, plan.roundLimit)}
          </span>
          {fix?.write == null ? null : (
            <span className="fix-write">
              <span className={fix.write.state === "written" ? "verdict-holds" : "muted"}>{WRITE_TEXT[fix.write.state] ?? fix.write.state}</span>
              <span className="muted">by {fix.write.writer === "runner" ? "the check runner" : "the originating agent"}</span>
              {fix.write.commit === null ? null : <code>{shortSha(fix.write.commit)}</code>}
            </span>
          )}
        </p>
        {part.changeRequest === null ? null : (
          <blockquote className="approval-quote">
            <p>{part.changeRequest.text}</p>
            <footer className="muted">
              {part.changeRequest.by} on revision {part.changeRequest.revision}
            </footer>
          </blockquote>
        )}
        {part.files === null ? (
          <p className="muted">
            Lines go to {part.owner} and {person}
          </p>
        ) : (
          <ol className="tree">
            {part.files.map((file, index) => (
              <li key={file.path}>
                <FileNode id={fileAnchor(part.partId, index)} file={file} />
              </li>
            ))}
          </ol>
        )}
        <Fold
          id={`${anchor}-facts`}
          className="tree-node tree-facts"
          summary={<span className="muted">{`${counted(part.breaks.length, "break")} ${counted(part.invariants.length, "invariant")} ${counted(part.callers.length, "use")}`}</span>}
        >
          <div className="tree-body">
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
          </div>
        </Fold>
      </div>
    </Fold>
  );
}

/** One file: its path, status and line counts, then its hunks with both sides' line numbers. */
export function FileNode({ id, file }: { readonly id: string; readonly file: PartFileView }) {
  const counts = lineCounts(file.hunks);
  return (
    <Fold
      id={id}
      className="tree-node tree-file"
      summary={
        <span className="tree-head">
          <code className="tree-path">{file.path}</code>
          <span className="muted">{file.status}</span>
          <span className="diff-count diff-count-add">+{counts.added}</span>
          <span className="diff-count diff-count-remove">-{counts.removed}</span>
        </span>
      }
    >
      {file.omitted !== null ? <p className="muted">{file.omitted === "binary" ? "Binary file" : "File over the size limit"}</p> : <Hunks hunks={file.hunks} />}
    </Fold>
  );
}

/** A file's hunks in one scrolling block, cut at FILE_LINE_CAP lines with a button for the rest. */
export function Hunks({ hunks, more }: { readonly hunks: readonly PlanHunk[]; readonly more?: React.ReactNode }) {
  const [all, setAll] = useState(false);
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  let budget = all ? Number.POSITIVE_INFINITY : FILE_LINE_CAP;
  return (
    <div className="diff-scroll">
      <table className="diff-table">
        {hunks.map((hunk, index) => {
          if (budget <= 0) return null;
          const rows = hunkRows(hunk).slice(0, budget);
          budget -= rows.length;
          return (
            <tbody key={index}>
              <tr className="diff-hunk">
                <td colSpan={3}>{hunkHeader(hunk)}</td>
              </tr>
              {rows.map((row, line) => (
                <tr key={line} className={`diff-row diff-${row.kind}`}>
                  <td className="diff-number">{row.old ?? ""}</td>
                  <td className="diff-number">{row.new ?? ""}</td>
                  <td className="diff-text">
                    <span className="diff-mark" aria-label={row.kind === "add" ? "added" : row.kind === "remove" ? "removed" : undefined}>
                      {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
                    </span>
                    {row.text}
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
      {!all && total > FILE_LINE_CAP ? (
        <button type="button" className="button quiet show-more" onClick={() => setAll(true)}>
          {counted(total - FILE_LINE_CAP, "more line")}
        </button>
      ) : (
        more
      )}
    </div>
  );
}
