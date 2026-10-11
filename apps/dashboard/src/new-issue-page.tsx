// The New issue form: a title, a body and the identities to assign, chosen from the identity list.
// Create sends a create operation and then one assign per identity through POST /api/operations
// (new-issue-view.ts), then opens the new issue's page. The board and the assignees' inboxes hear of
// it over the live connection.

import { useState, type FormEvent } from "react";

import { fetchBoard, SignedOut, submitOperation } from "./api.ts";
import { reasonLabel } from "./issue-view.ts";
import { linkHandler } from "./links.ts";
import { BODY_MAX_LENGTH, newIssueProblem, openIssue, TITLE_MAX_LENGTH } from "./new-issue-view.ts";
import { useIdentityHandles } from "./use-identity-handles.ts";
import type { Live } from "./use-live.ts";

/** The header's link to the New issue form, on the board and the inbox. */
export function NewIssueLink({ navigate }: { navigate: (path: string) => void }) {
  return (
    <a className="button primary page-header-action" href="/issues/new" onClick={linkHandler(navigate, "/issues/new")}>
      New issue
    </a>
  );
}

interface Props {
  readonly live: Live;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

export function NewIssuePage({ live, navigate, onSignedOut }: Props) {
  const identities = useIdentityHandles(live, onSignedOut);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignees, setAssignees] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const toggle = (handle: string, on: boolean) =>
    setAssignees((previous) => (on ? [...previous, handle] : previous.filter((chosen) => chosen !== handle)));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending) return;
    const found = newIssueProblem({ title });
    if (found !== undefined) {
      setProblem(found);
      return;
    }
    setSending(true);
    setProblem(undefined);
    openIssue(
      { title, body, assignees },
      {
        issueIds: async () => (await fetchBoard()).issues.map((entry) => entry.issue.id),
        submit: submitOperation,
      },
    ).then(
      (opened) => {
        setSending(false);
        // An assign that failed leaves the issue without that assignee; its page shows who is assigned.
        if (opened.status === "opened") navigate(`/issues/${opened.issueId}`);
        else setProblem(`Rejected for ${reasonLabel(opened.reason)}`);
      },
      (error: unknown) => {
        setSending(false);
        if (error instanceof SignedOut) onSignedOut();
        else setProblem("Please try again");
      },
    );
  };

  return (
    <div className="new-issue">
      <h1>New issue</h1>
      <div className="panel">
        <form className="issue-form" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field-label">Title</span>
            <input name="title" required value={title} maxLength={TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <textarea name="body" rows={8} value={body} maxLength={BODY_MAX_LENGTH} onChange={(event) => setBody(event.currentTarget.value)} />
          </label>
          <fieldset className="field">
            <legend className="field-label">Assignees</legend>
            {identities.kind === "loading" ? (
              <span className="muted" aria-busy="true" />
            ) : identities.kind === "failed" ? (
              <span className="muted">Please reload the page to assign</span>
            ) : identities.handles.length === 0 ? (
              <span className="muted">No identities yet</span>
            ) : (
              <div className="checks">
                {identities.handles.map((handle) => (
                  <label key={handle} className="check">
                    <input
                      type="checkbox"
                      checked={assignees.includes(handle)}
                      onChange={(event) => toggle(handle, event.currentTarget.checked)}
                    />
                    {handle}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {problem === undefined ? null : (
            <p className="notice" role="alert">
              {problem}
            </p>
          )}
          <div className="form-actions">
            <a className="button" href="/board" onClick={linkHandler(navigate, "/board")}>
              Cancel
            </a>
            <button type="submit" className="button primary" disabled={sending}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
