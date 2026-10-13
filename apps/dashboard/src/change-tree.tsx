// The feature's code changes as a tree (#124): the contract change first, then each place the plan
// fixes, then its files, then each file's hunks. Every node is a fold; only what needs the viewer opens
// on its own. A place's lines show only to the people the server sends them to (mayReadPartLines,
// #108); anyone else sees the place, its state and its facts. Every value renders as React text.
//
// A colleague's change page (#125) orders the tree for its viewer: the main change, then the viewer's
// own places grouped by scope, each file naming the changed symbols its lines use, then the other
// places folded away. A file the page answer cut reads its whole diff from the plan route on expand.

import { decisionRouteText, type ContractWorkView, type DecisionRoute, type FeaturePage, type FeaturePlanView, type FixView, type PartFileView, type PlanHunk, type PlanPartView } from "@penguin/protocol";
import { useState } from "react";

import { PersonAvatar } from "./avatar.tsx";
import { fetchFeaturePlan } from "./api.ts";
import { yourChanges, yourReaders } from "./banner-view.ts";
import { Icon } from "./icon.tsx";
import { ScopePill } from "./pills.tsx";
import { hunkHeader, hunkRows } from "./diff-view.ts";
import { counted, partNumber, partRouteText, roundText, shortSha } from "./feature-view.ts";
import { Fold } from "./fold.tsx";
import { linkHandler } from "./links.ts";
import { CONTRACT_FOLD } from "./page-view.ts";
import { partAnchor, placeName } from "./pipeline-view.ts";
import { BreakList } from "./review-card.tsx";
import { featurePath, personPath } from "./routes.ts";

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
  readonly featureId: string;
  readonly person: string;
  /** The signed-in person; on a colleague's feature the tree puts their own places first. */
  readonly viewer: string;
  /** The running features that read what the feature changes, and each scope's owner for its pill. */
  readonly dependents: FeaturePage["dependents"];
  readonly owners: ReadonlyMap<string, string>;
  readonly navigate: (path: string) => void;
  /** Who wrote each part's fix and how, from its `fix_write` record: an agent through MCP or Penguin's check runner. */
  readonly writes?: ReadonlyMap<string, DecisionRoute>;
}

export function ChangeTree({ plan, contract, fixes, featureId, person, viewer, dependents, owners, navigate, writes = new Map() }: TreeProps) {
  const hasContract = plan?.contractDiff != null || (contract?.entries.length ?? 0) > 0 || (contract?.split?.retiring.length ?? 0) > 0;
  const node = (part: PlanPartView) =>
    plan === null ? null : <PartNode part={part} plan={plan} fix={fixes.find((fix) => fix.partId === part.partId)} write={writes.get(part.partId)} featureId={featureId} person={person} navigate={navigate} />;
  if (viewer !== person) {
    const yours = yourChanges({ plan }, viewer);
    const readers = yourReaders({ dependents }, viewer);
    const others = (plan?.parts ?? []).filter((part) => part.owner !== viewer);
    return (
      <div className="change-tree">
        <section className="feature-section" aria-labelledby="main-change">
          <h2 id="main-change" className="team-section-heading">
            Main change
          </h2>
          {hasContract ? <ContractNode plan={plan} contract={contract} /> : <p className="muted">Waiting for the agent's merge plan</p>}
        </section>
        <section className="feature-section" aria-labelledby="your-changes">
          <h2 id="your-changes" className="team-section-heading">
            Your changes
          </h2>
          {readers.length === 0 ? null : (
            <ul className="your-readers" aria-label="Your features that read it">
              {readers.map((reader) => (
                <li key={`${reader.feature} ${reader.consumerScope}`}>
                  <a className="feature-link" href={featurePath(reader.feature)} onClick={linkHandler(navigate, featurePath(reader.feature))}>
                    {reader.feature}
                  </a>
                  <span className="reads">
                    <ScopePill name={reader.consumerScope} owner={owners.get(reader.consumerScope) ?? null} />
                    <span className="reads-arrow">
                      <Icon name="back" />
                    </span>
                    <span className="visually-hidden">reads</span>
                    <ScopePill name={reader.providerScope} owner={owners.get(reader.providerScope) ?? null} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {yours.length === 0 ? (
            readers.length === 0 ? <p className="muted">None in your scopes</p> : null
          ) : (
            yours.map((group) => (
              <div key={group.scope} className="tree-scope">
                <h3 className="tree-scope-name">{group.scope}</h3>
                <ol className="tree">
                  {group.parts.map(({ part }) => (
                    <li key={part.partId}>{node(part)}</li>
                  ))}
                </ol>
              </div>
            ))
          )}
        </section>
        {others.length === 0 ? null : (
          <Fold id="change-others" className="tree-node" summary={<span className="tree-title">Other places {others.length}</span>}>
            <ol className="tree">
              {others.map((part) => (
                <li key={part.partId}>{node(part)}</li>
              ))}
            </ol>
          </Fold>
        )}
      </div>
    );
  }
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
            <li key={part.partId}>{node(part)}</li>
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
            {retiring.map((each) => {
              // The defining scope's own uses leave with the symbol in the contract step; they are no migration part.
              const own = contract?.contractStep.find((step) => step.contract === each.contract);
              return (
                <li key={each.contract}>
                  <span className="tag tag-data">retiring</span> <code>{each.contract}</code> <span className="muted">to</span> <code>{each.replacement}</code>
                  {own === undefined || own.ownUses === 0 ? null : (
                    <span className="muted">
                      {" "}
                      {counted(own.ownUses, "own use")} in {own.ownFiles.join(", ")}, removed with it
                    </span>
                  )}
                </li>
              );
            })}
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
  /** The route of the part's fix write, from its signed record. */
  readonly write?: DecisionRoute | undefined;
  readonly plan: FeaturePlanView;
  readonly fix: FixView | undefined;
  readonly featureId: string;
  readonly person: string;
  readonly navigate: (path: string) => void;
}

const WRITE_TEXT: Readonly<Record<string, string>> = {
  queued: "Write queued",
  waiting: "Write waits for its turn on the fork",
  granted: "Write token granted",
  written: "Written",
  withdrawn: "Write withdrawn",
};

/** Who wrote a fix: the agent and its MCP tool, or Penguin's check runner, before the record arrives by its writer. */
function writtenBy(writer: string, route: DecisionRoute | undefined): string {
  if (route !== undefined) return route.route === "penguin" ? "by Penguin (check runner)" : `by ${decisionRouteText(route)}`;
  return writer === "runner" ? "by Penguin (check runner)" : "by the originating agent (MCP report_fix_write)";
}

function PartNode({ part, plan, fix, write, featureId, person, navigate }: PartProps) {
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
          <span className={`${partTagClass(part)} route-tag`}>{partRouteText(part, person)}</span>
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
              <span className={fix.write.state === "written" ? "verdict-holds" : "muted"}>{WRITE_TEXT[fix.write.waitsFor == null ? fix.write.state : "waiting"] ?? fix.write.state}</span>
              <span className="muted">{writtenBy(fix.write.writer, write)}</span>
              {fix.write.waitsFor == null ? null : <span className="muted">{fix.write.waitsFor}</span>}
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
                <FileNode
                  id={fileAnchor(part.partId, index)}
                  file={file}
                  symbols={[...new Set(part.callers.filter((use) => use.path === file.path).map((use) => use.symbol))]}
                  load={() => wholeFile(featureId, part.partId, file.path)}
                />
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
/** A file's whole diff from the plan route, which sends a part's lines to the same people the page does. */
async function wholeFile(featureId: string, partId: string, path: string): Promise<readonly PlanHunk[] | null> {
  const plan = await fetchFeaturePlan(featureId);
  return plan?.parts.find((part) => part.partId === partId)?.diff.files?.find((file) => file.path === path)?.hunks ?? null;
}

interface FileProps {
  readonly id: string;
  readonly file: PartFileView;
  /** The changed contract symbols the file's lines use. */
  readonly symbols: readonly string[];
  /** Reads the file's whole diff, for a file the page answer cut; resolves null when it is gone. */
  readonly load: () => Promise<readonly PlanHunk[] | null>;
}

/** One file: its path, status and line counts, then its hunks with both sides' line numbers. */
export function FileNode({ id, file, symbols, load }: FileProps) {
  return (
    <Fold
      id={id}
      className="tree-node tree-file"
      summary={
        <span className="tree-head">
          <code className="tree-path">{file.path}</code>
          <span className="muted">{file.status}</span>
          <span className="diff-count diff-count-add">+{file.added}</span>
          <span className="diff-count diff-count-remove">-{file.removed}</span>
        </span>
      }
    >
      {symbols.length === 0 ? null : (
        <ul className="chip-list file-symbols" aria-label="Symbols">
          {symbols.map((symbol) => (
            <li key={symbol} className="code-chip">
              {symbol}
            </li>
          ))}
        </ul>
      )}
      {file.omitted !== null ? <p className="muted">{file.omitted === "binary" ? "Binary file" : "File over the size limit"}</p> : <Hunks file={file} load={load} />}
    </Fold>
  );
}

type Rest = { readonly kind: "cut" } | { readonly kind: "loading" } | { readonly kind: "failed" } | { readonly kind: "loaded"; readonly hunks: readonly PlanHunk[] };

/** A file's hunks in one block that scrolls inside itself; lines the answer cut load on request. */
export function Hunks({ file, load }: { readonly file: Pick<PartFileView, "hunks" | "omittedLines">; readonly load: FileProps["load"] }) {
  const [rest, setRest] = useState<Rest>({ kind: "cut" });
  const hunks = rest.kind === "loaded" ? rest.hunks : file.hunks;
  const more = () => {
    setRest({ kind: "loading" });
    load().then(
      (loaded) => setRest(loaded === null ? { kind: "failed" } : { kind: "loaded", hunks: loaded }),
      () => setRest({ kind: "failed" }),
    );
  };
  return (
    <div className="diff-scroll">
      <table className="diff-table">
        {hunks.map((hunk, index) => (
          <tbody key={index}>
            <tr className="diff-hunk">
              <td colSpan={3}>{hunkHeader(hunk)}</td>
            </tr>
            {hunkRows(hunk).map((row, line) => (
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
        ))}
      </table>
      {file.omittedLines === 0 || rest.kind === "loaded" ? null : rest.kind === "failed" ? (
        <p className="notice" role="alert">
          Please reload the page to see the rest
        </p>
      ) : (
        // While the lines load the button keeps focus and refuses presses through aria-disabled.
        <button type="button" className="button quiet show-more" aria-disabled={rest.kind === "loading"} onClick={() => rest.kind === "loading" || more()}>
          {rest.kind === "loading" ? "Loading" : counted(file.omittedLines, "more line")}
        </button>
      )}
    </div>
  );
}
