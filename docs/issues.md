# Issues

> **Design change.** This page describes the current build. In the design, typed
> records take over from issue operations: feature declarations, merge plans, approvals, check results
> and promotions. Each record is a signed file in the `record` repo. The signing and validation
> described here stay.

Every coordination action in Penguin is an issue operation: a person opening an issue, an agent
commenting, Penguin attaching a failing test. Owners, agent sessions and Penguin itself write to the
same issues, so each reader sees the same history. This page covers how operations are stored,
signed, judged and applied. [architecture.md](architecture.md) places the issues repo among the
other pieces.

## Operation files

Each project has one Artifacts repo named `issues`. Each operation is one JSON file at
`issues/<issue>/ops/<op_id>.json` on the `main` branch. Each change is a new file, so two pushes
never edit the same file. The repo's history is the audit trail.

```json
{
  "schema_version": 1,
  "op_id": "jun-b3f2-0007",
  "issue": 33,
  "type": "review",
  "author": { "person": "jun" },
  "base_version": 12,
  "payload": {
    "verdict": "request_changes",
    "commit": "owner-priya@9b2f10",
    "reason": "A limit of five still joins the tablet's users."
  },
  "signature": "<86 base64url characters>"
}
```

`packages/protocol/src/operation-schema.ts` holds the JSON Schema (draft 2020-12). A reader refuses a
file over 65,536 bytes before parsing it. Unknown fields fail the schema.

| Field | Meaning |
|---|---|
| `op_id` | `<author segment>-<writer>-<seq>`, unique across the project |
| `issue` | The issue number, or the temporary ID of an issue created offline (see Offline issues) |
| `author` | `{"person": "<id>"}`, `{"identity": "@<owner>/<name>"}` or `{"penguin": true}` |
| `base_version` | The issue version the author saw: the number of operations applied to the issue. A create carries 0 |
| `signature` | Ed25519, base64url without padding, over the canonical JSON (RFC 8785 ordering) of every other field |

### Op ids

The author segment is the person id, the identity handle `@owner/name` written `owner.name`, or
`penguin`. The writer tag is `web` for every operation the Worker signs (MCP, the dashboard and
Penguin) or a bridge's tag: the first four hexadecimal digits of the SHA-256 of its bridge id. A
bridge not yet registered derives its tag from its public key. Each writer counts its own sequence per
author, zero-padded to four digits, so an offline bridge and the Worker never pick the same op_id
(`packages/protocol/src/operation.ts`).

### Operation types

| Type | Payload | Effect |
|---|---|---|
| `create` | `title`, optional `body` | Opens the issue in state `open` |
| `edit` | `title`, `body` or both | Replaces them |
| `comment` | `body` | Adds a comment, identified later by this op_id |
| `edit_comment` | `comment`, `body` | Adds a revision to a comment; the history stays |
| `add_label`, `remove_label` | `label` | `scope:<id>` labels tie the issue to a scope |
| `assign`, `unassign` | `assignee`: a person or an identity | Routes the issue to that identity's sessions |
| `mention` | `mentioned`, optional `comment` | Puts the issue in the mentioned person's inbox |
| `link_commit` | `commit` as `<repo>@<sha>`, optional `kind` (`trigger`, `fix`, `related`, `approved`), optional `supersedes` | Links a commit; only Penguin may supersede checks or link `approved` |
| `attach_check` | `command_id`, `commit`, `result` (`pass`, `fail`, `error`), optional `test`, `log_ref`, `fingerprint` | Records a test result as evidence |
| `open_sub_issue` | `sub_issue` | Makes an existing issue a sub-issue |
| `review` | `verdict` (`approve`, `request_changes`), `commit`, `reason` (required for `request_changes`) | Records a review of one commit |
| `open_thread` | `body`, optional `anchor`, optional `needs` (person ids) | Opens a thread that waits on the named people |
| `reply_thread` | `thread`, `body` | Replies in an open thread |
| `resolve_thread` | `thread`, optional `reason` | Resolves an open thread |
| `change_state` | `state`, `reason`, optional `resolution` (`approved`, `cancelled`) | Moves the issue between `open`, `detected`, `fixing`, `verifying`, `in_review` and `closed` |
| `send_upstream` | `reason` | An identity says its fix lies outside its charter; Penguin reassigns it |

A check's `fingerprint` is the SHA-256 of the tested commit, its lockfiles and the command id, so the
result applies only to the inputs it ran against.

## Signing and writers

| Writer | Signs with | May write as |
|---|---|---|
| An owner's bridge | The bridge's Ed25519 key, kept in the OS keychain | The owner, or one of the owner's identities |
| The Worker for MCP | The service key `PENGUIN_OP_SIGNING_KEY` | The session's identity, as the MCP token's owner |
| The Worker for the dashboard | The service key | The signed-in person |
| Penguin | The service key | `{"penguin": true}` only |

The Worker sets the author from the caller it authenticated. A dashboard or MCP operation that names
any other author is refused before it is signed (`draftFields` in
`services/project-agent/src/issue-index.ts`). The service key never leaves the Worker; the private
half is imported as non-extractable (`services/project-agent/src/service-key.ts`).

## Validation and rejection

`services/issues/src/validate.ts` judges whether an operation counts. It runs its checks in this
order and the first failure gives the reason:

| Reason | Cause |
|---|---|
| `malformed` | Not UTF-8 JSON, over the size cap or outside the schema |
| `wrong_path` | The file is not at `issues/<issue>/ops/<op_id>.json` for the operation it holds |
| (duplicate) | The op_id is already applied; nothing new is recorded |
| `bad_signature` | The signature is missing or verifies under no registered key |
| `author_not_bound` | A registered key signed it, but that key may not write as this author, or the op_id carries the other kind of writer's tag |
| `superseded_version` | `base_version` is older than the issue's current version |
| `unknown_version` | `base_version` is newer than the issue's current version |
| `outside_charter` | An identity's operation names a scope outside the identity's charter |
| `not_a_fix` | A `send_upstream` names an issue that is not a Huddle's fix sub-issue |
| `inside_charter` | A `send_upstream` whose fix lies inside the sender's charter |

Only bridges registered and not revoked verify. The ProjectAgent reads the keys fresh for each apply,
so a revoked bridge's later operations fail `bad_signature`.

The charter check reads only scope labels today: `add_label` and `remove_label` of a `scope:<id>`
label. No operation type carries file paths yet, so charter paths are stored but never checked
(`operationTargets` in `packages/policies/src/charter.ts`).

`services/issues/src/reduce.ts` then applies the operation to the issue. It rejects what needs the
issue's contents to judge:

| Reason | Cause |
|---|---|
| `no_issue` | The issue does not exist and the operation is not a create |
| `issue_exists` | A create names an issue that exists |
| `create_id_mismatch` | A create names a string id other than its own op_id |
| `unknown_comment`, `unknown_thread` | The comment or thread is not on this issue |
| `thread_resolved` | A reply or resolve names a resolved thread |
| `not_thread_participant` | A resolve from someone who is not one of the thread's people |
| `sub_issue_self`, `sub_issue_unknown`, `sub_issue_has_parent`, `sub_issue_cycle` | The sub-issue link is invalid |
| `unknown_check` | A link supersedes a check that is not on this issue |
| `supersede_forbidden` | Someone other than Penguin supersedes checks |
| `approved_link_forbidden` | Someone other than Penguin links an `approved` commit |
| `not_assignee` | A `send_upstream` from an identity not assigned to the issue |
| `close_blocked` | A Huddle issue closes as approved while something still blocks it |
| `not_starting_owner` | Someone other than the owner who started a Huddle's work cancels it |

A review from someone without review rights is applied: it stays on the issue with
`counts: false` and the reason it does not count. [huddle-flow.md](huddle-flow.md#8-reviews-and-review-rights)
says whose reviews count.

### Where a rejection shows

| Source | Rejected operation |
|---|---|
| A file pushed to `issues` | Recorded on the issue's timeline with its reason and kept in the log. An authenticated rejection is keyed by its op_id. A file whose signer could not be tied to its author is keyed by `sha256:<hex>` of its bytes, so a forged file cannot claim a real op_id |
| An MCP or dashboard submission | Returned to the caller and recorded nowhere, so the caller can retry. Two groups are recorded on the timeline and pushed like any operation. The first is `close_blocked` and `not_starting_owner`, from the dashboard or a session's `change_state`. The second is `not_assignee`, `not_a_fix` and `inside_charter`, from a session's `send_upstream` |

The dashboard's issue page shows each recorded rejection struck through with its reason.

## Coordination order

The ProjectAgent applies the files of the `issues` repo in one order, which a rebuild follows too
(`packages/protocol/src/order.ts`):

1. Commits in first-parent order of `main`, oldest first. A commit contributes the files it adds
   relative to its first parent.
2. Within one commit, ascending `base_version`, then ascending path.
3. Within one commit, a file whose `base_version` cannot be read comes last.

Rule 2 lets one runner commit carry a chain of operations on one issue, such as Penguin's create at
version 0 followed by a comment at version 1.

### Push ingest

The Queue delivers a `cf.artifacts.repo.pushed` event for each push to `issues`. The Worker accepts
only the `issues` repo's `refs/heads/main` and passes the event's `after` SHA to the ProjectAgent
(`apps/worker/src/push-events.ts`). The ProjectAgent walks the first-parent chain from `after` back to
the newest commit it already ingested, diffs each commit's `issues/` tree against its parent and
applies the added files in coordination order (`services/project-agent/src/push-ingest.ts`). Walking
back to the last ingested commit, instead of to the event's `before`, keeps the order right when the
Queue delivers two events out of order. The same walk picks up the commits of a missed event at the
next push.
A failed ingest is retried by the Queue; the ingested-commit ledger and the op_id check absorb the
repeat.

## The index

The index is the ProjectAgent's SQLite copy of every issue's current state. The dashboard, MCP and
routing read it. The issue's version counts its applied operations; a rejected operation does not
advance it.

`POST /index/rebuild`, with the deployer token, rebuilds the index from the `issues` repo into shadow
tables and compares them row by row with the live tables. It first catches the live index up to the
repo's head. `services/project-agent/src/rebuild.ts` lists where the two can differ by design:

- operations still pending, which the live index holds and the repo does not;
- a pending operation applied live ahead of a bridge operation that Git orders first;
- operations the rebuild judges under today's keys, scope map and delegates.

## Offline issues and aliases

A bridge creates an issue without asking Penguin for a number. Its create names its own op_id as the
issue, such as `jun-b3f2-0001`, which is the issue's temporary ID. Later operations on the issue from
the same bridge name the same temporary ID and sit in the folder `issues/jun-b3f2-0001/ops/`.

When the ProjectAgent applies the create, it gives the issue the next number and keeps the temporary
ID as an alias. Every later reference to the alias resolves to the number: an operation's `issue`, a
sub-issue link, a dashboard URL `/issues/jun-b3f2-0001` and an MCP `issue` argument. Operations the
Worker writes for an issue created offline go in the alias folder too, so the folder holds every file
of that issue. `penguin-bridge issue create` prints the temporary ID and says to keep using it.

## Pending push

An operation from MCP, the dashboard or Penguin is in the index the moment the ProjectAgent applies
it. It reaches the `issues` repo only when the integration runner pushes it:

1. The ProjectAgent writes a `PendingOp` row with the signed file in the same transaction that
   applies the operation.
2. The runner calls `GET /operations/pending` on every pass, every 10,000 ms by default
   (`RUNNER_INTERVAL_MS` in `packages/protocol/src/runner.ts`). It writes each file at the path the
   operation itself names, refusing any listed path that differs, then makes one commit and pushes once.
3. The push event reaches the ProjectAgent. A pushed file whose bytes match the pending operation at
   its own path records the commit on the operation and deletes its `PendingOp` row. A file that only
   names a pending op_id clears nothing.

While an operation waits, `get_issue` reports `waitingForGitLog: true` for it. The issue page header
shows one line, such as "2 updates waiting for the Git log", only for operations that have waited
longer than one runner interval. With no runner online,
operations stay applied and keep waiting.

Operations a bridge writes take the other path: the bridge pushes them itself. The ProjectAgent
applies them when the push event arrives. [bridge-and-runner.md](bridge-and-runner.md#issue-command-line)
covers the command line.
