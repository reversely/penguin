// The identities page (PRD section 8; identity plan sections 4 and 5): every identity as a row in
// the sidebar. The chosen one's agent card fills the centre with a header, its actions and three
// tabs. Overview holds Penguin's facts about the agent: the issue it holds and what that waits on,
// its last reported checkpoint, its recent operations and its registered sessions. Charter holds its
// job and charter, and Issue history its issues. Create, edit and duplicate open a form of settings rows in
// the centre. Edit and duplicate controls show only on the signed-in person's own identities. On a
// phone the list fills the screen and the chosen identity opens as its own screen with a back link.
// The page reads the identities again on every live change, so an identity created in another
// browser shows without reload. Every value renders as React text, so markup in a name, job or rule
// shows as text and runs nothing.

import type { Board, IdentitiesPage, IdentityEntry, IdentityScope, IssuePageTimelineEntry } from "@penguin/protocol";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { fetchBoard, fetchIdentities, SignedOut, writeIdentity } from "./api.ts";
import { IdentityAvatar, PersonAvatar } from "./avatar.tsx";
import { useMediaQuery } from "./details-pane.tsx";
import { Icon } from "./icon.tsx";
import {
  AVATAR_TYPES,
  avatarProblem,
  blankForm,
  canEdit,
  fieldProblem,
  formFor,
  formProblem,
  formRequest,
  HANDLE_NAME_PATTERN,
  handleIsFree,
  handleNameMaxLength,
  IDENTITY_TABS,
  isOnline,
  scopeChoices,
  scopeLabel,
  scopeTestCommand,
  tabAfterKey,
  toBase64,
  withOwners,
  type CheckedField,
  type IdentityForm,
  type IdentityTab,
} from "./identities-view.ts";
import { useRead } from "./inbox-page.tsx";
import { describeEntry, shortSha, STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { identityPath, personPath } from "./routes.ts";
import { agentWork, sessionIssue } from "./team-view.ts";
import type { Live } from "./use-live.ts";

type Load = { readonly kind: "loading" } | { readonly kind: "ready"; readonly page: IdentitiesPage } | { readonly kind: "failed" };

interface Props {
  readonly viewer: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

/** Matches app.css, where the sidebar becomes the phone header and the list moves into the centre. */
const PHONE = "(max-width: 759.98px)";

/** The chosen identity is kept in the address, so a reload or a shared link opens it. */
function chosenFromAddress(): string | null {
  return new URLSearchParams(window.location.search).get("identity");
}

/** The history state of an entry this page pushed, so its back link can return through history. */
const PUSHED = "penguin-identities";

/** The shell's sidebar list slot, which the shell renders before the page's effects run. */
function useSidebarSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setSlot(document.querySelector<HTMLElement>(".sidebar-list")), []);
  return slot;
}

export function IdentitiesPageView({ viewer, live, navigate, onSignedOut }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [chosen, setChosen] = useState<string | null>(chosenFromAddress);
  const [form, setForm] = useState<IdentityForm | null>(null);
  const phone = useMediaQuery(PHONE);
  const slot = useSidebarSlot();
  const connected = live.status === "live";
  // The board says which issue each agent holds and what it waits on; a session going online or
  // offline reads it again.
  const board = useRead(fetchBoard, `${live.revision}:${live.identitiesRevision}:${connected}`, onSignedOut);

  useEffect(() => {
    let current = true;
    fetchIdentities().then(
      (page) => {
        if (current) setLoad({ kind: "ready", page });
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        // A failed refresh keeps the identities already shown.
        else if (current) setLoad((previous) => (previous.kind === "ready" ? previous : { kind: "failed" }));
      },
    );
    return () => {
      current = false;
    };
    // `connected` reads the page again after a reconnect, which may have missed a change.
  }, [live.revision, live.identitiesRevision, connected, onSignedOut]);

  // The browser's back button returns from a phone's detail screen to the list.
  useEffect(() => {
    const onPop = () => {
      setChosen(chosenFromAddress());
      setForm(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Whether the open form holds changes, so leaving it asks first.
  const draft = useRef(false);
  const leaveForm = (): boolean => form === null || !draft.current || window.confirm("Discard the changes in this form?");

  /** Shows an identity. On a phone a detail is its own screen, so it gets its own history entry. */
  const choose = (id: string | null, { push = false, ask = true } = {}) => {
    if (ask && !leaveForm()) return;
    draft.current = false;
    setChosen(id);
    setForm(null);
    if (push) window.history.pushState(PUSHED, "", identityPath(id));
    else window.history.replaceState(null, "", identityPath(id));
    // The chosen identity replaces the centre, so it opens at its top.
    window.scrollTo({ top: 0 });
  };
  const back = () => {
    if (window.history.state === PUSHED) window.history.back();
    else choose(null);
  };
  const openForm = (next: IdentityForm) => {
    if (!leaveForm()) return;
    draft.current = false;
    setForm(next);
  };

  if (load.kind === "failed") {
    return (
      <div className="identities">
        <h1>Identities</h1>
        <p className="notice" role="alert">
          Please reload the page
        </p>
      </div>
    );
  }
  // The card waits for the board too, so its facts never push the tabs down after they paint.
  if (load.kind === "loading" || board.kind === "loading") return <div className="identities" aria-busy="true" />;

  const { page } = load;
  const picked = page.identities.find((identity) => identity.id === chosen);
  // On a wide screen the list stays beside the detail, so the first identity shows until one is chosen.
  const shown = picked ?? (phone ? undefined : page.identities[0]);
  const create = () => openForm(blankForm(viewer));
  const selectedId = form === null || form.kind !== "create" ? (form?.sourceId ?? shown?.id) : undefined;
  const list = <IdentityList identities={page.identities} selectedId={selectedId} onChoose={(id) => choose(id, { push: phone })} />;

  let centre: ReactNode;
  if (form !== null) {
    centre = (
      <IdentityFormView
        key={`${form.kind}-${form.sourceId ?? "new"}`}
        initialForm={form}
        page={page}
        viewer={viewer}
        onDraft={(changed) => {
          draft.current = changed;
        }}
        onCancel={() => {
          draft.current = false;
          setForm(null);
        }}
        onSaved={(id) => choose(id, { ask: false })}
        onSignedOut={onSignedOut}
      />
    );
  } else if (shown !== undefined) {
    centre = (
      <IdentityDetail
        key={shown.id}
        identity={shown}
        board={board.kind === "ready" ? board.value : undefined}
        scopes={page.scopes}
        viewer={viewer}
        navigate={navigate}
        onBack={phone ? back : undefined}
        onEdit={() => openForm(formFor(shown, "edit", viewer, takenHandles(page)))}
        onDuplicate={() => openForm(formFor(shown, "duplicate", viewer, takenHandles(page)))}
      />
    );
  } else {
    centre = (
      <>
        <header className="identities-header">
          <h1>Identities</h1>
          <button type="button" className="button primary" onClick={create}>
            Create
          </button>
        </header>
        {page.identities.length === 0 ? <p className="muted">Please create the first identity</p> : phone ? list : null}
      </>
    );
  }

  return (
    <div className="identities">
      {centre}
      {!phone && slot !== null
        ? createPortal(
            <section className="identity-list" aria-labelledby="identity-list-heading">
              <div className="identity-list-head">
                <h2 id="identity-list-heading">
                  All identities <span className="tab-count">{page.identities.length}</span>
                </h2>
                {/* Disabled rather than removed while the create form is open, so the list keeps its place. */}
                <button type="button" className="button" disabled={form?.kind === "create"} onClick={create}>
                  Create
                </button>
              </div>
              {list}
            </section>,
            slot,
          )
        : null}
    </div>
  );
}

function takenHandles(page: IdentitiesPage): ReadonlySet<string> {
  return new Set(page.identities.map((identity) => identity.handle));
}

interface ListProps {
  readonly identities: readonly IdentityEntry[];
  readonly selectedId: string | undefined;
  readonly onChoose: (id: string) => void;
}

/** Every identity as a row: its avatar with a dot while a session runs, its handle and its name. */
export function IdentityList({ identities, selectedId, onChoose }: ListProps) {
  return (
    <ul className="identity-rows">
      {identities.map((identity) => {
        const path = identityPath(identity.id);
        const online = isOnline(identity);
        return (
          <li key={identity.id}>
            <a
              className="identity-row"
              href={path}
              aria-current={identity.id === selectedId ? "page" : undefined}
              onClick={linkHandler(() => onChoose(identity.id), path)}
            >
              <span className="identity-row-avatar">
                <IdentityAvatar handle={identity.handle} image={identity.avatar} size="row" />
                {online ? <span className="online-dot" /> : null}
              </span>
              <span className="identity-row-text">
                <span className="identity-row-handle">{identity.handle}</span>
                <span className="identity-row-name">{identity.name}</span>
              </span>
              {online ? <span className="visually-hidden">Running</span> : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

interface DetailProps {
  readonly identity: IdentityEntry;
  /** The board, for the work the agent holds; undefined when it could not be read. */
  readonly board: Board | undefined;
  readonly scopes: readonly IdentityScope[];
  readonly viewer: string;
  readonly navigate: (path: string) => void;
  /** Set on a phone, where the detail is its own screen and a back link returns to the list. */
  readonly onBack: (() => void) | undefined;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
}

const SEEN_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function seenLabel(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : SEEN_FORMAT.format(time);
}

const TAB_LABEL: Readonly<Record<IdentityTab, string>> = {
  overview: "Overview",
  charter: "Charter",
  history: "Issue history",
};

/** The agent card: its header with the owners' actions, then its Overview, Charter and Issue history tabs. */
export function IdentityDetail({ identity, board, scopes, viewer, navigate, onBack, onEdit, onDuplicate }: DetailProps) {
  const [tab, setTab] = useState<IdentityTab>("overview");
  const tabRefs = useRef(new Map<IdentityTab, HTMLButtonElement>());
  const counts: Readonly<Record<IdentityTab, number | undefined>> = {
    overview: undefined,
    charter: undefined,
    history: identity.history.length,
  };
  // Arrow keys move between the tabs; only the selected tab sits in the tab order (WAI-ARIA tabs).
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabAfterKey(tab, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <article className="identity-detail" aria-labelledby="identity-heading">
      {onBack === undefined ? null : (
        <a className="back-link" href="/identities" onClick={linkHandler(onBack, "/identities")}>
          <Icon name="back" />
          All identities
        </a>
      )}
      <header className="identity-head">
        <IdentityAvatar handle={identity.handle} image={identity.avatar} size="header" />
        <div className="identity-title">
          <h1 id="identity-heading">{identity.handle}</h1>
          <p className="identity-name">{identity.name}</p>
          <p className="identity-meta">
            {identity.team ? "Owners" : "Owner"}
            {identity.owners.map((owner) => (
              <a key={owner} className="identity-owner" href={personPath(owner)} onClick={linkHandler(navigate, personPath(owner))}>
                <PersonAvatar id={owner} size="card" />
                {owner}
              </a>
            ))}
            {identity.team ? <span className="tag">Team</span> : null}
          </p>
        </div>
        {canEdit(identity, viewer) ? (
          <div className="identity-actions">
            <button type="button" className="button" onClick={onEdit}>
              Edit
            </button>
            <button type="button" className="button" onClick={onDuplicate}>
              Duplicate
            </button>
          </div>
        ) : null}
      </header>

      <div className="identity-tabs" role="tablist" aria-label={identity.handle}>
        {IDENTITY_TABS.map((name) => (
          <button
            key={name}
            ref={(node) => {
              if (node === null) tabRefs.current.delete(name);
              else tabRefs.current.set(name, node);
            }}
            type="button"
            role="tab"
            id={`identity-tab-${name}`}
            className="identity-tab"
            aria-selected={tab === name}
            aria-controls={tab === name ? `identity-panel-${name}` : undefined}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={onTabKey}
          >
            {TAB_LABEL[name]}
            {counts[name] === undefined ? null : <span className="tab-count">{counts[name]}</span>}
          </button>
        ))}
      </div>

      <div className="identity-panel" role="tabpanel" id={`identity-panel-${tab}`} aria-labelledby={`identity-tab-${tab}`} tabIndex={0}>
        {tab === "overview" ? <OverviewTab identity={identity} board={board} navigate={navigate} /> : null}
        {tab === "charter" ? <CharterTab identity={identity} scopes={scopes} /> : null}
        {tab === "history" ? <HistoryTab identity={identity} navigate={navigate} /> : null}
      </div>
    </article>
  );
}

function CharterTab({ identity, scopes }: { identity: IdentityEntry; scopes: readonly IdentityScope[] }) {
  return (
    <>
      <section className="identity-card" aria-labelledby="identity-job">
        <h2 id="identity-job">Job</h2>
        <p className="body-text">{identity.job}</p>
      </section>
      <section className="identity-card" aria-labelledby="identity-charter">
        <h2 id="identity-charter">Charter</h2>
        <dl className="charter">
          {identity.charterScopes.length === 0 ? (
            <CharterRow term="Works in">
              <span className="muted">None</span>
            </CharterRow>
          ) : (
            identity.charterScopes.map((scope, index) => (
              <CharterRow key={scope} term={index === 0 ? "Works in" : "and in"}>
                <span className="chip" title={scope}>
                  {scopeLabel(scopes, scope)}
                </span>
                <TestCommand command={scopeTestCommand(scopes, scope)} />
              </CharterRow>
            ))
          )}
          <CharterRow term="On paths">
            {identity.charterPaths.length === 0 ? <span className="muted">None</span> : null}
            {identity.charterPaths.map((path) => (
              <code key={path} className="code-chip">
                {path}
              </code>
            ))}
          </CharterRow>
          <CharterRow term="Follows">
            {identity.charterRules.length === 0 ? (
              <span className="muted">None</span>
            ) : (
              <ol className="charter-rules">
                {identity.charterRules.map((rule, index) => (
                  <li key={index} className="body-text">
                    {rule}
                  </li>
                ))}
              </ol>
            )}
          </CharterRow>
        </dl>
        <p className="identity-card-note">Only scopes of this identity's owners</p>
      </section>
      <dl className="identity-card settings">
        <div className="setting">
          <dt className="setting-label">Assignments</dt>
          <dd className="setting-value">{identity.autoAccept ? "Auto-accept" : "Owner accepts"}</dd>
        </div>
        {identity.duplicatedFrom === null ? null : (
          <div className="setting">
            <dt className="setting-label">Duplicated from</dt>
            <dd className="setting-value">{identity.duplicatedFrom}</dd>
          </div>
        )}
      </dl>
    </>
  );
}

/** One sentence row of a charter: its connecting words, then the tokens they govern. */
function CharterRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="charter-row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A scope's test command as a read-only chip; owners edit it in penguin/scopes.json. */
function TestCommand({ command }: { command: string | undefined }) {
  if (command === undefined) return null;
  return (
    <>
      <span className="charter-word">tested by</span>
      <code className="code-chip">{command}</code>
    </>
  );
}

interface OverviewProps {
  readonly identity: IdentityEntry;
  readonly board: Board | undefined;
  readonly navigate: (path: string) => void;
}

/** A link to an issue by its number, with its title when the board knows it. */
function IssueLink({ id, title, navigate }: { id: string; title?: string; navigate: (path: string) => void }) {
  const path = `/issues/${id}`;
  return (
    <a className={title === undefined ? "identity-issue-link" : "identity-issue-link identity-issue-titled"} href={path} onClick={linkHandler(navigate, path)}>
      <span className="issue-number">#{id}</span>
      {title === undefined ? null : ` ${title}`}
    </a>
  );
}

/**
 * Penguin's facts about the agent: the issue it holds, what that issue waits on, its last reported
 * checkpoint, the operations it wrote and its registered sessions. Penguin holds no session's
 * conversation, so the card shows none.
 */
function OverviewTab({ identity, board, navigate }: OverviewProps) {
  const work = board === undefined ? undefined : agentWork(board, identity.handle);
  const titles = new Map(board?.issues.map((issue) => [issue.issue.id, issue.issue.title]) ?? []);
  const checkpoint = identity.lastCheckpoint;
  return (
    <>
      {board === undefined ? (
        <p className="notice" role="alert">
          Please reload the page to see the issue it holds
        </p>
      ) : null}
      <dl className="identity-card settings" aria-label="Work">
        {work === undefined ? null : (
          <>
            <Fact label="Issue">
              {work.issue === null ? <span className="muted">None</span> : <IssueLink id={work.issue.issue.id} title={work.issue.issue.title} navigate={navigate} />}
            </Fact>
            <Fact label="Waits on">{work.waitsOn ?? <span className="muted">None</span>}</Fact>
          </>
        )}
        {work === undefined || work.others.length === 0 ? null : (
          <Fact label="Also holds">
            <span className="identity-issue-links">
              {work.others.map((issue) => (
                <IssueLink key={issue.issue.id} id={issue.issue.id} navigate={navigate} />
              ))}
            </span>
          </Fact>
        )}
        <Fact label="Last checkpoint">
          {checkpoint === null ? (
            <span className="muted">None</span>
          ) : (
            <span className="identity-checkpoint">
              <code title={checkpoint.sha}>{shortSha(checkpoint.sha)}</code>
              <time className="muted" dateTime={checkpoint.reportedAt}>
                {seenLabel(checkpoint.reportedAt)}
              </time>
            </span>
          )}
        </Fact>
      </dl>
      <section className="identity-section" aria-labelledby="identity-operations">
        <h2 id="identity-operations">
          Recent operations <span className="tab-count">{identity.recentOperations.length}</span>
        </h2>
        {identity.recentOperations.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <ul className="identity-card identity-operations">
            {identity.recentOperations.map((operation) => (
              <li key={operation.opId} className="identity-operation">
                <span className="identity-operation-text">{describeEntry(timelineEntry(operation)).summary}</span>
                <IssueLink id={operation.issueId} navigate={navigate} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="identity-section" aria-labelledby="identity-sessions">
        <h2 id="identity-sessions">
          Sessions <span className="tab-count">{identity.sessions.length}</span>
        </h2>
        {identity.sessions.length === 0 ? <p className="muted">None</p> : null}
        {identity.sessions.map((session) => {
          const current = sessionIssue(board, identity.handle, session);
          return (
            <div key={session.id} className="identity-card">
              <h3 className="identity-session-head">
                {session.vendor}
                <span className={`session-state session-${session.status}`}>
                  <span className="session-dot" aria-hidden="true" />
                  {session.status === "running" ? "Running" : "Offline"}
                </span>
              </h3>
              <dl className="settings">
                <Fact label="Branch">
                  <code className="identity-branch">{session.branch}</code>
                </Fact>
                <Fact label="Worktree">
                  <code className="identity-branch">{session.worktreeId}</code>
                </Fact>
                <Fact label="Last heartbeat">
                  <time dateTime={session.lastSeen}>{seenLabel(session.lastSeen)}</time>
                </Fact>
                <Fact label="Current issue">
                  {current === null ? <span className="muted">None</span> : <IssueLink id={current} title={titles.get(current)} navigate={navigate} />}
                </Fact>
              </dl>
            </div>
          );
        })}
      </section>
    </>
  );
}

/** One fact as a settings row: its bare label at the left and its value at the right. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="setting">
      <dt className="setting-label">{label}</dt>
      <dd className="setting-value">{children}</dd>
    </div>
  );
}

/** An operation as the timeline's describer reads it; only its type and payload are read. */
function timelineEntry(operation: IdentityEntry["recentOperations"][number]): IssuePageTimelineEntry {
  return {
    seq: operation.seq,
    opId: operation.opId,
    author: null,
    type: operation.type,
    payload: operation.payload,
    status: "applied",
    rejectReason: null,
    message: null,
    gitCommit: null,
    waitingForGitLog: false,
    waitedMs: null,
  };
}

function HistoryTab({ identity, navigate }: { identity: IdentityEntry; navigate: (path: string) => void }) {
  if (identity.history.length === 0) return <p className="muted identity-empty">None</p>;
  return (
    <ul className="identity-card identity-list-rows">
      {identity.history.map((entry) => {
        const path = `/issues/${entry.issueId}`;
        return (
          <li key={entry.issueId} className="identity-list-row identity-issue">
            <a className="identity-issue-title" href={path} onClick={linkHandler(navigate, path)}>
              <span className="issue-number">#{entry.issueId}</span> {entry.title}
            </a>
            <span className={`tag state-${entry.state}`}>{STATE_LABEL[entry.state] ?? entry.state}</span>
          </li>
        );
      })}
    </ul>
  );
}

const FORM_HEADING: Readonly<Record<IdentityForm["kind"], string>> = {
  create: "New identity",
  edit: "Edit identity",
  duplicate: "Duplicate identity",
};

const SUBMIT_LABEL: Readonly<Record<IdentityForm["kind"], string>> = {
  create: "Create",
  edit: "Save",
  duplicate: "Duplicate",
};

const SENDING_LABEL: Readonly<Record<IdentityForm["kind"], string>> = {
  create: "Creating",
  edit: "Saving",
  duplicate: "Duplicating",
};

const REJECTION_TEXT: Readonly<Record<string, string>> = {
  handle_taken: "Please choose another handle",
  forbidden: "Only the identity's owners can change it",
  not_found: "Please reload the page",
};

const CHECKED_FIELDS: readonly CheckedField[] = ["handle", "name", "job"];

interface FormProps {
  readonly initialForm: IdentityForm;
  readonly page: IdentitiesPage;
  readonly viewer: string;
  /** Told whether the form now differs from how it opened. */
  readonly onDraft: (changed: boolean) => void;
  readonly onCancel: () => void;
  readonly onSaved: (id: string) => void;
  readonly onSignedOut: () => void;
}

/** Cmd or Ctrl with Enter sends the form from a text area, where Enter alone starts a new line. */
function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

/** Create, edit or duplicate as settings rows: a label and a one-clause hint at the left, the control at the right. */
export function IdentityFormView({ initialForm, page, viewer, onDraft, onCancel, onSaved, onSignedOut }: FormProps) {
  const [form, setForm] = useState(initialForm);
  useEffect(() => onDraft(form !== initialForm), [form, initialForm, onDraft]);
  const [problem, setProblem] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  // A field shows its problem once the person leaves it, then again on every change until it is fixed.
  const [checked, setChecked] = useState<ReadonlySet<CheckedField>>(new Set());
  const { limits } = page;
  const kind = form.kind;
  const choices = useMemo(() => scopeChoices(page.scopes, form.owners), [page.scopes, form.owners]);
  const taken = useMemo(() => takenHandles(page), [page]);
  const otherOwners = page.owners.filter((owner) => owner !== viewer);
  const update = (changes: Partial<IdentityForm>) => setForm((previous) => ({ ...previous, ...changes }));
  const check = (field: CheckedField) => setChecked((previous) => (previous.has(field) ? previous : new Set([...previous, field])));
  const handleTaken = kind !== "edit" && taken.has(`@${viewer}/${form.handleName}`);
  const problemOf = (field: CheckedField): string | undefined => {
    if (!checked.has(field)) return undefined;
    return fieldProblem(form, field) ?? (field === "handle" && handleTaken ? REJECTION_TEXT["handle_taken"] : undefined);
  };

  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    const fileProblem = avatarProblem(file, limits);
    if (fileProblem !== undefined) {
      setProblem(fileProblem);
      return;
    }
    file.arrayBuffer().then(
      (buffer) => {
        const data = toBase64(new Uint8Array(buffer));
        setProblem(undefined);
        update({ avatar: { url: `data:${file.type};base64,${data}`, mediaType: file.type, data } });
      },
      () => setProblem("Please choose the image again"),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invalid = CHECKED_FIELDS.find((field) => fieldProblem(form, field) !== undefined || (field === "handle" && handleTaken));
    if (invalid !== undefined) {
      setChecked(new Set(CHECKED_FIELDS));
      setProblem(undefined);
      event.currentTarget.querySelector<HTMLElement>(`[name="${invalid}"]`)?.focus();
      return;
    }
    const found = formProblem(form, limits);
    if (found !== undefined) {
      setProblem(found);
      return;
    }
    const request = formRequest(form, viewer);
    setSending(true);
    setProblem(undefined);
    writeIdentity(request.path, request.body).then(
      (outcome) => {
        setSending(false);
        if (outcome.status === "ok") onSaved(outcome.id);
        else setProblem(REJECTION_TEXT[outcome.reason] ?? capitalized(outcome.message));
      },
      (error: unknown) => {
        setSending(false);
        if (error instanceof SignedOut) onSignedOut();
        else setProblem("Please try again");
      },
    );
  };

  const handleProblem = problemOf("handle");
  return (
    <article className="identity-detail" aria-labelledby="identity-form-heading">
      <header className="identity-head">
        <div className="identity-title">
          <h1 id="identity-form-heading">{FORM_HEADING[kind]}</h1>
          {form.sourceHandle === null ? null : <p className="identity-name">{form.sourceHandle}</p>}
        </div>
      </header>
      <form className="identity-form" onSubmit={submit} noValidate>
        <div className="identity-card settings">
          {kind === "edit" ? null : (
            <SettingRow id="identity-handle" label="Handle" hint="Lowercase letters and digits joined by hyphens" problem={handleProblem}>
              <span className="handle-input">
                <span className="handle-prefix" aria-hidden="true">{`@${viewer}/`}</span>
                <input
                  id="identity-handle"
                  name="handle"
                  required
                  value={form.handleName}
                  maxLength={handleNameMaxLength(viewer)}
                  pattern={HANDLE_NAME_PATTERN}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={handleProblem === undefined ? undefined : true}
                  aria-describedby={describedBy("identity-handle", handleProblem)}
                  onBlur={() => check("handle")}
                  onChange={(event) => update({ handleName: event.currentTarget.value })}
                />
                {handleIsFree(form, viewer, taken) ? (
                  <span className="handle-free">
                    <Icon name="check" label="Handle is free" />
                  </span>
                ) : null}
              </span>
            </SettingRow>
          )}
          <SettingRow id="identity-name" label="Name" hint="Shown under the handle" problem={problemOf("name")}>
            <input
              id="identity-name"
              name="name"
              required
              value={form.name}
              maxLength={limits.nameLength}
              aria-invalid={problemOf("name") === undefined ? undefined : true}
              aria-describedby={describedBy("identity-name", problemOf("name"))}
              onBlur={() => check("name")}
              onChange={(event) => update({ name: event.currentTarget.value })}
            />
          </SettingRow>
          {kind === "duplicate" ? null : (
            <>
              <div className="setting" role="group" aria-labelledby="identity-avatar-label" aria-describedby="identity-avatar-hint">
                <div className="setting-text">
                  <span className="setting-label" id="identity-avatar-label">
                    Avatar
                  </span>
                  <p className="setting-hint" id="identity-avatar-hint">
                    {`Image up to ${Math.floor(limits.avatarBytes / 1024)} KB`}
                  </p>
                </div>
                <div className="setting-control avatar-field">
                  <IdentityAvatar handle={`@${viewer}/${form.handleName}`} image={form.avatar?.url ?? null} size="row" />
                  <label className="button">
                    Choose image
                    <input type="file" className="visually-hidden" accept={AVATAR_TYPES.join(",")} onChange={chooseAvatar} />
                  </label>
                  {form.avatar === null ? null : (
                    <button type="button" className="button" onClick={() => update({ avatar: null })}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {kind === "create" ? (
                <CheckRow
                  id="identity-team"
                  label="Team identity"
                  hint="Shared with other owners who may each edit it"
                  checked={form.team}
                  onChange={(team) => setForm((previous) => ({ ...withOwners(previous, [viewer], page.scopes), team }))}
                />
              ) : null}
              {kind === "create" && form.team ? (
                <div className="setting" role="group" aria-labelledby="identity-owners-label" aria-describedby="identity-owners-hint">
                  <div className="setting-text">
                    <span className="setting-label" id="identity-owners-label">
                      Owners
                    </span>
                    <p className="setting-hint" id="identity-owners-hint">{`Up to ${limits.teamOwners} owners with you`}</p>
                  </div>
                  <div className="setting-control checks">
                    {otherOwners.length === 0 ? <span className="muted">No other owners</span> : null}
                    {otherOwners.map((owner) => (
                      <label key={owner} className="check">
                        <input
                          type="checkbox"
                          checked={form.owners.includes(owner)}
                          onChange={(event) => {
                            const on = event.currentTarget.checked;
                            setForm((previous) => {
                              const owners = on ? [...previous.owners, owner] : previous.owners.filter((o) => o !== owner);
                              return withOwners(previous, owners.slice(0, limits.teamOwners), page.scopes);
                            });
                          }}
                        />
                        {owner}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              <CheckRow
                id="identity-auto-accept"
                label="Auto-accept assignments"
                hint="Takes each assignment without an owner accepting it"
                checked={form.autoAccept}
                onChange={(autoAccept) => update({ autoAccept })}
              />
              <SettingRow id="identity-job" label="Job" hint="What this identity works on" problem={problemOf("job")} stacked>
                <textarea
                  id="identity-job"
                  name="job"
                  required
                  rows={3}
                  value={form.job}
                  maxLength={limits.jobLength}
                  aria-invalid={problemOf("job") === undefined ? undefined : true}
                  aria-describedby={describedBy("identity-job", problemOf("job"))}
                  onBlur={() => check("job")}
                  onKeyDown={submitOnModEnter}
                  onChange={(event) => update({ job: event.currentTarget.value })}
                />
              </SettingRow>
            </>
          )}
        </div>

        {kind === "duplicate" ? (
          <p className="muted">The charter carries over</p>
        ) : (
          <section className="identity-card" aria-labelledby="identity-charter-form">
            <h2 id="identity-charter-form">Charter</h2>
            <fieldset className="charter-field">
              <legend className="charter-word">Works in</legend>
              {choices.length === 0 ? (
                <span className="muted">Please add a scope of yours to penguin/scopes.json</span>
              ) : (
                <ul className="charter-choices">
                  {choices.map((scope) => (
                    <li key={scope.id}>
                      <label className="chip chip-check">
                        <input
                          type="checkbox"
                          checked={form.charterScopes.includes(scope.id)}
                          onChange={(event) => {
                            const on = event.currentTarget.checked;
                            setForm((previous) => ({
                              ...previous,
                              charterScopes: on ? [...previous.charterScopes, scope.id] : previous.charterScopes.filter((id) => id !== scope.id),
                            }));
                          }}
                        />
                        {scope.name}
                        {form.team ? <span className="chip-owner">{scope.ownerId}</span> : null}
                      </label>
                      <TestCommand command={scope.testCommand} />
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <div className="charter-field">
              <label className="charter-word" htmlFor="identity-paths">
                On paths
              </label>
              <textarea
                id="identity-paths"
                name="paths"
                rows={3}
                value={form.paths}
                spellCheck={false}
                aria-describedby="identity-paths-hint"
                className="mono"
                onKeyDown={submitOnModEnter}
                onChange={(event) => update({ paths: event.currentTarget.value })}
              />
              <p className="setting-hint" id="identity-paths-hint">
                One path per line
              </p>
            </div>
            <div className="charter-field">
              <label className="charter-word" htmlFor="identity-rules">
                Follows
              </label>
              <textarea
                id="identity-rules"
                name="rules"
                rows={4}
                value={form.rules}
                aria-describedby="identity-rules-hint"
                onKeyDown={submitOnModEnter}
                onChange={(event) => update({ rules: event.currentTarget.value })}
              />
              <p className="setting-hint" id="identity-rules-hint">
                One rule per line
              </p>
            </div>
            <p className="identity-card-note">Only scopes of this identity's owners</p>
          </section>
        )}
        {problem === undefined ? null : (
          <p className="notice" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={sending}>
            {sending ? SENDING_LABEL[kind] : SUBMIT_LABEL[kind]}
          </button>
        </div>
      </form>
    </article>
  );
}

function describedBy(id: string, problem: string | undefined): string {
  return problem === undefined ? `${id}-hint` : `${id}-hint ${id}-problem`;
}

interface SettingRowProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly problem?: string | undefined;
  /** Puts the control under the text, for a text area that needs the row's full width. */
  readonly stacked?: boolean;
  readonly children: ReactNode;
}

/** A settings row: the label wired to its control, a one-clause hint, the field's problem and the control. */
function SettingRow({ id, label, hint, problem, stacked = false, children }: SettingRowProps) {
  return (
    <div className={stacked ? "setting setting-stacked" : "setting"}>
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>
          {label}
        </label>
        <p className="setting-hint" id={`${id}-hint`}>
          {hint}
        </p>
        {problem === undefined ? null : (
          <p className="field-problem" id={`${id}-problem`}>
            {problem}
          </p>
        )}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

interface CheckRowProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** A settings row whose control is a checkbox; the whole row is its label, so it has no dead zone. */
function CheckRow({ id, label, hint, checked, onChange }: CheckRowProps) {
  return (
    <label className="setting setting-check" htmlFor={id}>
      <span className="setting-text">
        <span className="setting-label" id={`${id}-label`}>
          {label}
        </span>
        <span className="setting-hint" id={`${id}-hint`}>
          {hint}
        </span>
      </span>
      <span className="setting-control">
        {/* Named by the label alone; the row-wide label would otherwise read the hint twice. */}
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </span>
    </label>
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
