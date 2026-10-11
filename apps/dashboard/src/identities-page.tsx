// The identities page (PRD section 8): every identity in a list, the chosen one's charter, sessions
// and issue history, and forms to create, edit and duplicate identities. Edit and duplicate controls
// show only on the signed-in person's own identities. The page reads the identities again on every
// live change, so an identity created in another browser shows without reload. Every value renders
// as React text, so markup in a name, job or rule shows as text and runs nothing.

import type { IdentitiesPage, IdentityEntry, IdentityScope } from "@penguin/protocol";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import { fetchIdentities, SignedOut, writeIdentity } from "./api.ts";
import { IdentityAvatar } from "./avatar.tsx";
import {
  AVATAR_TYPES,
  avatarProblem,
  blankForm,
  canEdit,
  formFor,
  formProblem,
  formRequest,
  HANDLE_NAME_PATTERN,
  handleNameMaxLength,
  scopeChoices,
  scopeLabel,
  toBase64,
  withOwners,
  type IdentityForm,
} from "./identities-view.ts";
import { STATE_LABEL } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import type { Live } from "./use-live.ts";

type Load = { readonly kind: "loading" } | { readonly kind: "ready"; readonly page: IdentitiesPage } | { readonly kind: "failed" };

interface Props {
  readonly viewer: string;
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

/** Matches app.css, where the identity list and the chosen identity share one column. */
const ONE_COLUMN = "(max-width: 959.98px)";

/** The chosen identity is kept in the address, so a reload or a shared link opens it. */
function chosenFromAddress(): string | null {
  return new URLSearchParams(window.location.search).get("identity");
}

function setAddress(id: string | null): void {
  window.history.replaceState(null, "", id === null ? "/identities" : `/identities?identity=${encodeURIComponent(id)}`);
}

export function IdentitiesPageView({ viewer, live, navigate, onSignedOut }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [chosen, setChosen] = useState<string | null>(chosenFromAddress);
  const [form, setForm] = useState<IdentityForm | null>(null);
  const connected = live.status === "live";

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

  const choose = useCallback((id: string | null) => {
    setChosen(id);
    setForm(null);
    setAddress(id);
    // In one column the chosen identity sits above the list, out of view of the row just pressed.
    if (window.matchMedia(ONE_COLUMN).matches) window.scrollTo({ top: 0 });
  }, []);

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
  if (load.kind === "loading") return <div className="identities" aria-busy="true" />;

  const { page } = load;
  const shown = page.identities.find((identity) => identity.id === chosen) ?? page.identities[0];
  return (
    <div className="identities">
      <header className="identities-header">
        <h1>Identities</h1>
        {form?.kind === "create" ? null : (
          <button type="button" className="button primary" onClick={() => setForm(blankForm(viewer))}>
            Create
          </button>
        )}
      </header>
      <div className="identities-layout">
        <section className="panel identity-list" aria-labelledby="identity-list-heading">
          <h2 id="identity-list-heading">
            All identities <span className="muted">{page.identities.length}</span>
          </h2>
          {page.identities.length === 0 ? (
            <p className="muted">No identities yet</p>
          ) : (
            <ul className="identity-rows">
              {page.identities.map((identity) => (
                <li key={identity.id}>
                  <button
                    type="button"
                    className="identity-row"
                    aria-current={form === null && identity.id === shown?.id ? "true" : undefined}
                    onClick={() => choose(identity.id)}
                  >
                    <IdentityAvatar handle={identity.handle} image={identity.avatar} size="row" />
                    <span className="identity-row-text">
                      <span className="row-title">{identity.handle}</span>
                      <span className="muted identity-row-name">{identity.name}</span>
                    </span>
                    {identity.team ? <span className="tag">Team</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {form !== null ? (
          <IdentityFormView
            key={`${form.kind}-${form.sourceId ?? "new"}`}
            initialForm={form}
            page={page}
            viewer={viewer}
            onCancel={() => setForm(null)}
            onSaved={(id) => choose(id)}
            onSignedOut={onSignedOut}
          />
        ) : shown === undefined ? null : (
          <IdentityDetail
            identity={shown}
            scopes={page.scopes}
            viewer={viewer}
            navigate={navigate}
            onEdit={() => setForm(formFor(shown, "edit", viewer, takenHandles(page)))}
            onDuplicate={() => setForm(formFor(shown, "duplicate", viewer, takenHandles(page)))}
          />
        )}
      </div>
    </div>
  );
}

function takenHandles(page: IdentitiesPage): ReadonlySet<string> {
  return new Set(page.identities.map((identity) => identity.handle));
}

interface DetailProps {
  readonly identity: IdentityEntry;
  readonly scopes: readonly IdentityScope[];
  readonly viewer: string;
  readonly navigate: (path: string) => void;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
}

const SEEN_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function seenLabel(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : SEEN_FORMAT.format(time);
}

function IdentityDetail({ identity, scopes, viewer, navigate, onEdit, onDuplicate }: DetailProps) {
  return (
    <section className="panel identity-detail" aria-labelledby="identity-heading">
      <header className="identity-head">
        <IdentityAvatar handle={identity.handle} image={identity.avatar} size="header" />
        <div className="identity-title">
          <h2 id="identity-heading">{identity.handle}</h2>
          <p className="muted">{identity.name}</p>
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
      <dl className="identity-facts">
        <div>
          <dt>{identity.team ? "Owners" : "Owner"}</dt>
          <dd>
            {identity.owners.join(" · ")}
            {identity.team ? <span className="tag">Team</span> : null}
          </dd>
        </div>
        <div>
          <dt>Job</dt>
          <dd className="body-text">{identity.job}</dd>
        </div>
        <div>
          <dt>Assignments</dt>
          <dd>{identity.autoAccept ? <span className="tag">Auto-accept</span> : <span className="tag">Owner accepts</span>}</dd>
        </div>
        {identity.duplicatedFrom === null ? null : (
          <div>
            <dt>Duplicated from</dt>
            <dd className="row-title">{identity.duplicatedFrom}</dd>
          </div>
        )}
      </dl>

      <section className="identity-section" aria-labelledby="identity-charter">
        <h3 id="identity-charter">Charter</h3>
        <dl className="identity-facts">
          <div>
            <dt>Scopes</dt>
            <dd>
              {identity.charterScopes.length === 0 ? <span className="muted">None</span> : null}
              {identity.charterScopes.map((scope) => (
                <span key={scope} className="tag" title={scope}>
                  {scopeLabel(scopes, scope)}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>Paths</dt>
            <dd className="identity-paths">
              {identity.charterPaths.length === 0 ? <span className="muted">None</span> : null}
              {identity.charterPaths.map((path) => (
                <code key={path} className="identity-path">
                  {path}
                </code>
              ))}
            </dd>
          </div>
          <div>
            <dt>Rules</dt>
            <dd>
              {identity.charterRules.length === 0 ? (
                <span className="muted">None</span>
              ) : (
                <ol className="identity-rules">
                  {identity.charterRules.map((rule, index) => (
                    <li key={index} className="body-text">
                      {rule}
                    </li>
                  ))}
                </ol>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="identity-section" aria-labelledby="identity-sessions">
        <h3 id="identity-sessions">
          Sessions <span className="muted">{identity.sessions.length}</span>
        </h3>
        {identity.sessions.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <ul className="rows">
            {identity.sessions.map((session) => (
              <li key={session.id} className="row">
                <span className={`tag ${session.status === "running" ? "session-running" : "session-offline"}`}>
                  {session.status === "running" ? "Running" : "Offline"}
                </span>
                <span className="tag">{session.vendor}</span>
                <code className="muted">{session.branch}</code>
                <time className="muted identity-time" dateTime={session.lastSeen}>
                  {seenLabel(session.lastSeen)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="identity-section" aria-labelledby="identity-history">
        <h3 id="identity-history">
          Issue history <span className="muted">{identity.history.length}</span>
        </h3>
        {identity.history.length === 0 ? (
          <p className="muted">None</p>
        ) : (
          <ul className="rows">
            {identity.history.map((entry) => {
              const path = `/issues/${entry.issueId}`;
              return (
                <li key={entry.issueId} className="row identity-issue">
                  <a className="identity-issue-title" href={path} onClick={linkHandler(navigate, path)}>
                    <span className="issue-number">#{entry.issueId}</span> {entry.title}
                  </a>
                  <span className={`tag state-${entry.state}`}>{STATE_LABEL[entry.state] ?? entry.state}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
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

const REJECTION_TEXT: Readonly<Record<string, string>> = {
  handle_taken: "Please choose another handle",
  forbidden: "Only the identity's owners can change it",
  not_found: "Please reload the page",
};

interface FormProps {
  readonly initialForm: IdentityForm;
  readonly page: IdentitiesPage;
  readonly viewer: string;
  readonly onCancel: () => void;
  readonly onSaved: (id: string) => void;
  readonly onSignedOut: () => void;
}

function IdentityFormView({ initialForm, page, viewer, onCancel, onSaved, onSignedOut }: FormProps) {
  const [form, setForm] = useState(initialForm);
  const [problem, setProblem] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const { limits } = page;
  const kind = form.kind;
  const choices = useMemo(() => scopeChoices(page.scopes, form.owners), [page.scopes, form.owners]);
  const otherOwners = page.owners.filter((owner) => owner !== viewer);
  const update = (changes: Partial<IdentityForm>) => setForm((previous) => ({ ...previous, ...changes }));

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

  return (
    <section className="panel identity-detail" aria-labelledby="identity-form-heading">
      <h2 id="identity-form-heading">{FORM_HEADING[kind]}</h2>
      <form className="identity-form" onSubmit={submit} noValidate>
        {kind === "edit" ? (
          <div className="field">
            <span className="field-label">Handle</span>
            <span className="row-title">{form.sourceHandle}</span>
          </div>
        ) : (
          <label className="field">
            <span className="field-label">Handle</span>
            <span className="handle-input">
              <span className="handle-prefix" aria-hidden="true">{`@${viewer}/`}</span>
              <input
                name="handle"
                required
                value={form.handleName}
                maxLength={handleNameMaxLength(viewer)}
                pattern={HANDLE_NAME_PATTERN}
                autoCapitalize="none"
                spellCheck={false}
                aria-label={`Handle after @${viewer}/`}
                onChange={(event) => update({ handleName: event.currentTarget.value })}
              />
            </span>
          </label>
        )}
        <label className="field">
          <span className="field-label">Name</span>
          <input
            name="name"
            required
            value={form.name}
            maxLength={limits.nameLength}
            onChange={(event) => update({ name: event.currentTarget.value })}
          />
        </label>
        {kind === "duplicate" ? (
          <p className="muted">The charter carries over</p>
        ) : (
          <>
            <div className="field">
              <span className="field-label" id="avatar-label">
                Avatar
              </span>
              <div className="avatar-field">
                <IdentityAvatar handle={`@${viewer}/${form.handleName}`} image={form.avatar?.url ?? null} size="header" />
                <label className="button">
                  Choose image
                  <input
                    type="file"
                    className="visually-hidden"
                    accept={AVATAR_TYPES.join(",")}
                    aria-describedby="avatar-hint"
                    onChange={chooseAvatar}
                  />
                </label>
                {form.avatar === null ? null : (
                  <button type="button" className="button" onClick={() => update({ avatar: null })}>
                    Remove
                  </button>
                )}
              </div>
              <span className="muted field-hint" id="avatar-hint">
                {`Image up to ${Math.floor(limits.avatarBytes / 1024)} KB`}
              </span>
            </div>
            <label className="field">
              <span className="field-label">Job</span>
              <textarea
                name="job"
                required
                rows={3}
                value={form.job}
                maxLength={limits.jobLength}
                onChange={(event) => update({ job: event.currentTarget.value })}
              />
            </label>
            {kind === "create" ? (
              <fieldset className="field">
                <legend className="field-label">Owners</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.team}
                    onChange={(event) => {
                      const team = event.currentTarget.checked;
                      setForm((previous) => ({ ...withOwners(previous, [viewer], page.scopes), team }));
                    }}
                  />
                  Team identity
                </label>
                {form.team ? (
                  otherOwners.length === 0 ? (
                    <span className="muted">No other owners</span>
                  ) : (
                    <div className="checks">
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
                  )
                ) : null}
              </fieldset>
            ) : null}
            <fieldset className="field">
              <legend className="field-label">Scopes</legend>
              {choices.length === 0 ? (
                <span className="muted">Please add a scope of yours to penguin/scopes.json</span>
              ) : (
                <div className="checks">
                  {choices.map((scope) => (
                    <label key={scope.id} className="check">
                      <input
                        type="checkbox"
                        checked={form.charterScopes.includes(scope.id)}
                        onChange={(event) => {
                          const on = event.currentTarget.checked;
                          setForm((previous) => ({
                            ...previous,
                            charterScopes: on
                              ? [...previous.charterScopes, scope.id]
                              : previous.charterScopes.filter((id) => id !== scope.id),
                          }));
                        }}
                      />
                      {scope.name}
                      {form.team ? <span className="muted">{scope.ownerId}</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <label className="field">
              <span className="field-label">Paths</span>
              <textarea
                name="paths"
                rows={3}
                value={form.paths}
                spellCheck={false}
                aria-describedby="paths-hint"
                className="mono"
                onChange={(event) => update({ paths: event.currentTarget.value })}
              />
              <span className="muted field-hint" id="paths-hint">
                One path per line
              </span>
            </label>
            <label className="field">
              <span className="field-label">Rules</span>
              <textarea
                name="rules"
                rows={4}
                value={form.rules}
                aria-describedby="rules-hint"
                onChange={(event) => update({ rules: event.currentTarget.value })}
              />
              <span className="muted field-hint" id="rules-hint">
                One rule per line
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.autoAccept}
                onChange={(event) => update({ autoAccept: event.currentTarget.checked })}
              />
              Accept assignments automatically
            </label>
          </>
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
            {SUBMIT_LABEL[kind]}
          </button>
        </div>
      </form>
    </section>
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
