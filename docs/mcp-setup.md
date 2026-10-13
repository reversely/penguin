# Connecting agent sessions to Penguin

> **Design change.** This page describes the current build. In
> [design.md](design.md#mcp-for-agent-sessions), a session works on one feature. The build serves
> `whats_near`, `impact`, `check`, `apply_fix` ([Agent tools for a feature](#agent-tools-for-a-feature))
> and `submit_review`. It gains `propose_plan` ([design.md](design.md#tools-for-agents)).

An owner's Claude Code or Codex session reads the issues assigned to one of the owner's identities and
writes comments, linked commits and state changes back to them. The session reaches Penguin's MCP
endpoint, `<worker-url>/mcp`, with the owner's MCP token. The token decides whose identities the
session may use. This page covers issuing a token, connecting each agent product, registering a
session and the errors each tool returns.

For how the three connection paths fit together (MCP tools, the hook, the inbox), read
[how-agents-connect.md](how-agents-connect.md) first.

## Prerequisites

| Item | Who provides it | Where it comes from |
|---|---|---|
| The Worker URL | The deployer | The deployed Worker, such as `https://penguin.example.workers.dev` |
| An MCP token per owner | The deployer | `POST /mcp/tokens` with the deployer token (below) |
| The identity the session works as, such as `@jun/reports` | The owner | The dashboard's Identities page, signed in as that owner |
| Dashboard sign-in for each owner | The deployer | `PENGUIN_DASHBOARD_OWNERS` in `apps/worker/wrangler.jsonc` maps each GitHub login to an owner id ([deploy.md](deploy.md#dashboard-sign-in)) |

An identity's handle starts with its owner's id, so only Jun can create `@jun/reports`. Jun needs a
GitHub login in `PENGUIN_DASHBOARD_OWNERS` to sign in and create it.

A session registered for an identity receives that identity's assigned issues through `get_work` only
when the identity has "Auto-accept assignments" checked. Otherwise each assignment waits for the
owner's acceptance. No route or dashboard control accepts one yet, so check Auto-accept on every
identity a session works as.

## Issuing an MCP token

The deployer issues one token per owner. Penguin returns the token once and keeps only its hash. Keep
the deployer token out of the command line by passing the header from a file:

```sh
umask 077
printf 'Authorization: Bearer %s\n' "$(cat ~/.config/penguin/deployer-token)" > /tmp/penguin-deployer-header
curl -sS -X POST https://<worker-url>/mcp/tokens \
  -H @/tmp/penguin-deployer-header -H 'Content-Type: application/json' \
  -d '{"owner":"jun"}' > /tmp/penguin-jun-token.json
rm /tmp/penguin-deployer-header
```

The response holds `tokenId`, `owner`, `token` and `issuedAt`. The deployer hands `token` to the owner
over a private channel and keeps `tokenId` to revoke it later with `DELETE /mcp/tokens/<tokenId>`.

## Claude Code

Claude Code connects to an HTTP MCP server with a bearer header
([Claude Code MCP](https://code.claude.com/docs/en/mcp)):

```sh
claude mcp add --transport http penguin https://<worker-url>/mcp \
  --header "Authorization: Bearer <token>"
```

The command writes the server, with the token, to `~/.claude.json` at local scope: the server loads
only in the project where the owner ran the command. `claude mcp get penguin` shows whether it
connected.

A project can instead name the server in a `.mcp.json` file at its root and read the token from the
owner's environment, so the token never sits in a file. Claude Code expands `${VAR}` in a remote
server's `url` and `headers`:

```json
{
  "mcpServers": {
    "penguin": {
      "type": "http",
      "url": "https://<worker-url>/mcp",
      "headers": { "Authorization": "Bearer ${PENGUIN_TOKEN}" }
    }
  }
}
```

Claude Code asks the owner to approve a project's `.mcp.json` server on the first run in that folder.

## Codex

Codex reads MCP servers from `[mcp_servers.<name>]` tables in `~/.codex/config.toml`, or in a trusted
project's `.codex/config.toml` ([Codex MCP](https://developers.openai.com/codex/mcp)). The
`bearer_token_env_var` key names the variable Codex reads the token from:

```toml
[mcp_servers.penguin]
url = "https://<worker-url>/mcp"
bearer_token_env_var = "PENGUIN_TOKEN"
```

`codex mcp add penguin --url https://<worker-url>/mcp --bearer-token-env-var PENGUIN_TOKEN` writes the
same table. The owner starts Codex with the token in the environment: `PENGUIN_TOKEN=<token> codex`.

For one session without changing any configuration file, the same keys go on the command line:

```sh
PENGUIN_TOKEN=<token> codex \
  -c 'mcp_servers.penguin.url="https://<worker-url>/mcp"' \
  -c 'mcp_servers.penguin.bearer_token_env_var="PENGUIN_TOKEN"'
```

In the Codex terminal UI, `/mcp` lists the connected servers and their tools.

## Registering a session

Penguin's server instructions tell the agent to call `register_session` first. The owner names the
identity in the first prompt, for example:

> Call the penguin register_session tool with identity "@jun/reports", vendor "codex", worktreeId
> "reports-retention" and branch "reports/retention". Then call get_work with the sessionId it returns.

| Argument | Value |
|---|---|
| `identity` | One of the token owner's identity handles, such as `@jun/reports` |
| `vendor` | `claude-code` or `codex` |
| `worktreeId` | The bridge's id for the worktree, or any stable name of letters, digits, `.`, `_` and `-` |
| `branch` | The branch checked out in the worktree |

`register_session` returns a `sessionId`. The agent passes it to `get_work`, `get_issue`, `post_update`
and `report_checkpoint`. Each of those calls keeps the session running. After about 90 seconds without
one, Penguin marks the session offline and the agent registers again. Once a session registers, the
identity's agent box in its owner's square on the team map leaves "No session". The identity's agent
card lists the session with its vendor, branch and worktree ([dashboard.md](dashboard.md#agent-card)).

Penguin refuses `register_session` for an identity the token's owner does not own. The refusal reads
`forbidden` and names the identity's owner.

## Fix tasks and safe checkpoints

When combined tests fail, Penguin opens a Huddle issue with one fix sub-issue per failing test. Each
fix sub-issue routes to a running session of its assigned identity. The session reads it through
`get_work` only from its next safe checkpoint on, so the task never arrives in the middle of a step.
Until then `get_work` leaves the task out. Its result for a fix task carries the pinned base (the
trigger checkpoint, its baseline and the owner checkpoint it was merged with), the failing test with
its fingerprint and the acceptance criteria.

A session reaches a safe checkpoint in any of these ways:

| Checkpoint | Who sends it |
|---|---|
| Registering | The agent, through `register_session`. A new session has no step in progress |
| Before the next tool action | The bridge's PreToolUse hook, `penguin-bridge session-checkpoint --hook` |
| A published checkpoint | The agent, through `report_checkpoint`. Its answer lists the delivered tasks under `newWork` |
| A checkpoint the bridge publishes | `penguin-bridge checkpoint`, after a successful publish |
| By hand | The owner, with `penguin-bridge session-checkpoint` in the worktree |

The bridge names a session by its worktree. Register the session with the id that
`penguin-bridge worktree-id` prints in the session's worktree. The bridge must be registered for the
same owner as the session's identity.

Claude Code and Codex both run command hooks before each tool call. The hook runs in the session's
working directory. It prints nothing unless a fix task arrived. When one did, it prints a
`hookSpecificOutput.additionalContext` answer that tells the agent to call `get_work`. It exits 0
even when Penguin is unreachable, so the tool call always goes ahead. For Claude Code, add the hook
to the project's `.claude/settings.json`
([Claude Code hooks](https://code.claude.com/docs/en/hooks)):

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "penguin-bridge session-checkpoint --hook", "timeout": 10 }] }
    ]
  }
}
```

For Codex, the same `PreToolUse` entry goes in `.codex/hooks.json` or `~/.codex/hooks.json`
([Codex hooks](https://developers.openai.com/codex/hooks)).

When no session of the assigned identity is running, the owner's inbox lists the task with a request
to start one. The Huddle issue stays in Fixing. When a session goes offline before or during a fix,
the sub-issue stays open and assigned. The next session of the identity receives it when it registers.

## Threads that need the developer

An owner's request for changes on a fix opens a thread on the fix sub-issue. The thread carries the
reviewer's reason and needs the owners of the fix's assignees other than the reviewer. Penguin adds it to each needed
person's inbox. Each running session of that person hears of it once, at its next safe checkpoint:
the hook answer says which issue has the thread; `report_checkpoint` lists it under `newThreads`.
`get_work` lists every open thread that needs the session's developer under `threadsNeedingYou`. The
agent tells its developer about each one in its own conversation and replies with `post_update`
(`reply_thread`). A person in the thread resolves it on the issue page: the reviewer, a person it
needs or a person who replied.

## Overlapping starts

A feature whose declared area another running feature covers waits to start until the covering
feature's person approves ([design.md](design.md#step-3-in-the-build)). Its `open_feature` answer
carries no token and lists the covering features in `waitingOn`. `get_work` reports the same under
`feature.waitingOn`; once the list is empty, `feature_token` gives the token. The covering person's
running sessions hear of the request once, at their next safe checkpoint: the hook answer names it
and `report_checkpoint` lists it under `newOverlaps`. `get_work` lists it under
`overlapsNeedingYou`. The agent tells its developer, who approves on the dashboard inbox. Once the
lock is approved or withdrawn, the waiting feature's sessions hear of it at their next safe
checkpoint: the hook answer names it and `report_checkpoint` lists it under `locksSettled`. A
feature of the same person makes no lock; `ownOverlaps` lists it.

## Merge plan parts

A merge plan part that touches the developer's code reaches each of the developer's running sessions
once, at their next safe checkpoint ([design.md](design.md#advance-notice-in-the-build)). The hook
answer names it. `report_checkpoint` lists it under `newPlanParts`. `get_work` lists it under
`planPartsNeedingYou` with the scopes the agent reviews through `submit_review`. Penguin approves the
part itself once every check is clean, the agent's review included. Otherwise the developer approves
the part or asks for a change on the dashboard inbox; no tool approves it. Each part in `get_work`'s
`plan` names its `approvedBy`: the developer, their delegate or `penguin`. A session of the
originating feature hears each decision under `planDecisions`. It answers a `change_requested` part
with `revise_plan_part`. A session that submitted a review hears the check runner's verdict under
`reviewResults`.

Once an author approves a behavioural part, the originating agent writes its fix into the author's
feature fork ([design.md](design.md#steps-1-and-3-in-the-build)):

| Tool | Input | Answer |
|---|---|---|
| `fix_token` | `feature`, `part`, `revision` | `token`: a `write` token on the affected fork alone, with its remote and expiry; `write`: the parent to fast-forward, the paths, the commit message and the approved patch inside `personWritten` |
| `report_fix_write` | `feature`, `part`, `revision`, `commit` | `written` with the signed record's id, or the reason Penguin refused the commit |

The identity that proposed the plan gets the token, only for the part's current approved revision.
The identity the part's `fix` edit task went to, the target feature's builder first, gets it the same
way ([Edit tasks](#edit-tasks)). `penguin-bridge fix-write` makes and pushes the commit from the `fix_token` answer on stdin
([bridge-and-runner.md](bridge-and-runner.md#fix-writes)). A part that went back because its fork head
moved arrives under `planDecisions` as `change_requested`; its `changeRequest.forkHead` names the head
the revision applies to.

A feature opened after a merge plan was announced gets the plan in `open_feature`'s `announcedPlans`
when its area meets the plan's. A running feature whose checkpoint grows its area into an announced
plan's gets a part in that plan; `report_checkpoint` lists it under `plansJoined`.

## Edit tasks

Penguin creates a steward for each person who owns a scope, `@<person>/steward`, chartered on every
scope the person owns. It creates a builder for each feature at open, `@<person>/<feature>`,
chartered on the feature's declared area. Register a session as either identity to take its edit
tasks. Every edit Penguin needs goes to one of them by charter
([design.md](design.md#edit-tasks-and-who-runs-them)): a review form, an approved fix to write, a
next step after a failed block check or a migration part.

A waiting task reaches a running session of its identity at the session's next safe checkpoint. A
builder's task also reaches a session of the same person that works on the target feature.
`get_work` lists the delivered tasks under `editTasks`:

| Field | Holds |
|---|---|
| `taskId`, `kind`, `block` | The task, its kind (`review`, `fix`, `next_step`, `migration`) and the block it shares with the other half of a split task |
| `feature`, `target`, `fork` | The feature whose work raised it and the fork it edits, `feature-<target>` |
| `identity`, `via` | The identity it went to and why: `builder` or `steward` |
| `files`, `scopes` | What the edit may change: these files, or the paths of these scopes |
| `verifier` | Penguin's checks that verify the edit |
| `personWritten.instructions` | Penguin's instructions, which quote the failing check's reason |

The agent answers a `review` with `submit_review` and a `fix` with `fix_token` and
`penguin-bridge fix-write`. It makes a `next_step` or a `migration` edit in the fork and reports the
checkpoint. Penguin closes each task from the facts: the form arriving, the write being kept or the
block check passing. `editQueue` counts the developer's `running`, `queued` and `asked` tasks against
`cap`, the most background runs the developer's bridge holds at once.

### Review tasks run headless

With no steward session running, the developer's bridge runs a review task headless
([bridge-and-runner.md](bridge-and-runner.md#review-forms)). Penguin issues the run a task token,
`pgt_...`, when the bridge claims the task. The bridge puts it in the CLI's MCP config for
`<worker-url>/mcp`. A task token differs from the owner's MCP token in four ways:

| Property | Task token |
|---|---|
| Tools | `submit_review`, `whats_near` and `impact` alone; `tools/list` shows nothing else |
| Scope | `submit_review` for the task's feature, scope and part revision; `impact` on that feature |
| Session | None: the tools take no `sessionId`. The form is stored under the reviewer `@<person>/steward` and the session id `edit-task-<task id>` |
| Lifetime | Until the claim ends (`PENGUIN_EDIT_RUN_MINUTES`), the bridge reports the task, or the part moves to another revision or out of `pending` |

`impact` answers the check runner's newest report on the feature's latest checkpoint when one
exists. Otherwise it records a request, as a session's call does. Penguin keeps only the token's
SHA-256 hash.

## Agent tools for a feature

A session that works on a feature calls four tools for facts and deterministic fixes
([design.md](design.md#tools-for-agents)). Each call is recorded with its tool, its caller's
identity, its input, its answer and its duration, so the feature page and a demo show every use.

| Tool | Input | Answer |
|---|---|---|
| `whats_near` | `paths`, `scopes` or both | Each running feature, other than the session's own, whose area touches them or that works in a scope depending on one of them, with its person, state and agent sessions |
| `impact` | `feature` | The request, recorded at the feature's latest checkpoint for the check runner |
| `check` | `feature` | The request, recorded the same way |
| `apply_fix` | `feature`, `kind`, `paths`, `edits` or `rules`; or `kind: "codemod"` with `expand: true` | The request with its fix's command ID, recorded the same way |

`impact`, `check` and `apply_fix` act only on the feature the session works on, once its fork has a
checkpoint. Their answer has `state: "waiting"` and `message: "waiting for the check runner"`, with
the request's id as `recordedAs`. The check runner then computes the impact graph, runs the checks or
applies the fix ([bridge-and-runner.md](bridge-and-runner.md#agent-tools-on-the-runner)).

The result reaches the session at its next safe checkpoint, once. The bridge hook names it by tool
and id. `report_checkpoint` lists it under `toolResults`. `get_work` lists the session's last 10
delivered results under `toolResults`, newest first. Each entry carries the full `outcome`:

| Tool | `outcome` holds |
|---|---|
| `impact` | `impact`: the impact graph and contract diff, with each other running feature's fork. While symbols are retiring, `migration`: the remaining callers on main and in each running feature's own changes, grouped by owner |
| `impact`, from a checkpoint | The retiring-calls check Penguin asked for: `decisions`, one next step per file and retiring symbol the checkpoint's own changes use, each naming the replacement |
| `check` | `checks`: every block check; `decisions`: one next step from the ladder per failing check |
| `apply_fix` | `fix`: the fix's run with the files it changed; `fixRef` and `pushed` |

`apply_fix` leaves the feature's fork as it is. The check runner holds a write token on a feature's
fork only for an approved merge plan part. The fix commit stays on the check runner. The
result carries `pushed: false` with the files the fix changed, so the agent makes the same change in
its worktree.

`apply_fix` takes one of four kinds: `format`, `lint`, `lockfile` or `codemod`. `paths` names Python
files inside the session identity's charter. A lockfile fix names no files. A codemod carries
`edits`, each `{"kind": "rename" | "move", "from": "<dotted name>", "to": "<dotted name>"}` or
`{"kind": "rename-parameter", "function": "<dotted name>", "from": "<name>", "to": "<name>"}`.
A codemod may carry `rules` instead: the ids of rewrite rules declared for retiring symbols, as a
step 3 of the retiring-calls check names them. A codemod with `expand: true` names no `paths`,
`edits` or `rules`: Penguin derives them from the feature's split ([Contract sort and split](#contract-sort-and-split)).
Penguin refuses it when the feature has no split waiting on its expand, when no entry of the split is a
rename, move or keyword rename, or when a file the codemod writes lies outside the charter.
Penguin refuses a call with an unknown kind, a file outside the charter, a path that leaves the
repository or an edit whose names are not Python names. A refused call records nothing.

## Contract sort and split

Penguin sorts the contract diff of each checkpoint a feature reports
([design.md](design.md#sorting-and-splitting-in-the-build)). `get_work` reports the sort of the
feature's latest checkpoint under `contract`:

| Field | Content |
|---|---|
| `state` | `no_checkpoint` before the first checkpoint, `waiting` until the check runner reports the checkpoint's facts run, `failed` when its impact analysis failed, `sorted` once sorted |
| `decision` | `split` when an entry is incompatible, `plan` when an entry is a behaviour change and none is incompatible, `none` otherwise |
| `counts`, `entries` | Each entry's `sort` (`additive`, `compatible`, `incompatible` or `behaviour`), its `breaks` (`rename`, `move`, `keyword-rename`, `removed`, `signature` or `type`), its `callers` outside your developer's scopes and a one-sentence `reason`. At most 100 entries, incompatible first; `omitted` counts the rest |
| `split` | The feature's split: `expand_first`, then `retiring` once the expand reached main, with each retiring name and its replacement |
| `contractStep` | Each symbol your feature retires with its callers at Penguin's count after the last promotion: on main and in each running feature's own changes. `ownUses` and `ownFiles` are the uses in the defining module and its scope's tests: no callers, removed with the symbol. `state` is `counting`, `callers_left`, `no_callers`, `approved` or `removed`. `carrier` names the feature Penguin opened from main to carry the removal once your feature no longer runs |
| `migration` | The migration plans Penguin proposed for your retiring symbols, one per owner group, each with its parts: the place, its uses, the writer (`runner` or `task`), the reason and the state ([design.md](design.md#migration-plans-in-the-build)) |
| `nextStep` | What to do next, in one paragraph |

An incompatible entry makes the next step start with "Expand first" and list the entries. For a
rename, a move or a keyword rename, call `apply_fix` with `kind: "codemod"` and `expand: true`:
Penguin's codemod writes the alias or forwarding function that keeps the old name working. For a
changed type, a breaking signature or a removed symbol, write the parallel function beside the old
one under a new name. Report that expand as a checkpoint and call `land_feature` with `expand: true`.
Name the parallel functions in its `retiring`. Once the expand reaches main, the next step lists the
names now retiring. Penguin proposes the migration plans itself after its next count of the
remaining callers, one per owner group: the check runner writes each part the declared rewrite rules
rewrite whole. Every other part reaches the place's builder or the steward of the scope's DRI as an
edit task. A behaviour change keeps the merge plan:
the next step asks for `propose_plan`. `report_checkpoint` on a feature fork answers the facts run it
sorts under `contractSort`.

Penguin counts the callers of every retiring symbol after each promotion of main. When no caller of
one of your feature's retiring symbols is left, Penguin approves removing it with no person asked.
The next step then starts with "Contract" and names the symbols. Remove them from your fork, report
the removal as a checkpoint and call `land_feature`. Once the block reaches main, each removed
symbol's state is `removed`. A caller that comes back before then withdraws the approval. When your
feature has landed by then, Penguin opens a short-lived feature from main for the DRI of each scope
that defines the symbols and gives the removal to that DRI's steward.

## Merge plans

A session whose feature changes something other scopes or running features depend on calls
`propose_plan` with its feature and one part per affected place. A `note` of up to 2,000 characters is
optional on each part.

| Place | Fix |
|---|---|
| `{ "scope": "<scope id>" }`, code already on main | `diff: { commit, base? }`, a commit in your feature's fork. `base` defaults to the commit's first parent |
| `{ "feature": "<feature id>" }`, a running feature | `patch: { base, diff }`, a unified diff as `git diff` prints it, against that feature's fork head. `base` is the head the answer lists under `affectedFeatures[].head` |
| Either place, when it needs no change | `verify: true` and no `diff` or `patch`. The part's trial runs the place's tests on the merged tree, and Penguin approves it when they pass, with no review form. When they fail, the part waits on its author like any other, who asks you for a fix |

The first call for a checkpoint answers `missing` with `waiting_for_runner`: Penguin has asked the
check runner for the impact graph and the test runs. The agent calls again once the runner has
reported. Each later `missing` answer lists every gap: an affected place without a part, a part for a
place the facts show unaffected (`not_affected`, with the reason), two parts for one place, a diff commit missing from the fork, or a
patch that names another base, writes outside the place's scopes or does not apply at the head. A
running feature is affected only by its own changes: the files it added or changed since its merge
base with main. A caller in a file it carries unchanged from main is main's, so a feature with no
caller of its own and no break needs no part. A part needs a person when one of Penguin's checks fails
([design.md](design.md#penguins-approval-in-the-build)). A plan with more such parts than the
project's break limit answers `returned`, with their places under `inPerson`. A review the author's
agent has yet to submit does not count.

A plan may also declare `rules`: up to 32 rewrite rules for its mechanical fixes. Each rule names
`id`, `contract` (`path::symbol`, one the contract diff touches), `kind` (`expression` or
`annotation`), `pattern`, `replacement` and `imports`. For example, a rule with pattern
`money.display($amount)` and replacement `$amount.display()` rewrites each call of `display`. A part
whose fix is exactly what the rules write is mechanical. A refused rule comes back in `missing` as
`rule_refused` with its `rule` id and the reason. Other rules than the last call's ask the runner
for a new facts run.

A plan may also declare `retiring`: up to 64 `{ "contract": "<path::symbol>", "replacement":
"<path::name>" }` pairs, for contracts the change leaves in place beside their replacement. Each
contract must be one `penguin/scopes.json` declares for a scope the feature's area names. A rule
may name a retiring contract the contract diff does not touch. Once the plan is stored, every
checkpoint whose own changes call a retiring symbol gets a next step naming the replacement.

When you wrote the expand first, before any incompatible change, propose a plan with no part at the
expand checkpoint and declare in `retiring` each old contract it replaces. While your feature has
no split, Penguin records the split from that declaration
([design.md](design.md#sorting-and-splitting-in-the-build), Expand written first). Each contract
must exist on main, have a caller outside your scopes, and have its replacement in the checkpoint;
one that fails comes back in `missing` as `retiring_refused` with the reason. The contracts retire
when the expand reaches main, each with the plan's rules for it.

A complete
plan answers `stored` with its id, facts and parts. Every `missing` or `returned` answer is marked as
a tool error. Text from the repository and the run, such as the commit subject, docstrings, assertion
lines, diff lines and the agent's own note, arrives only inside `personWritten`
([design.md](design.md#steps-1-to-5-in-the-build)).

## Landing a feature

A session of a feature asks Penguin to move main to the feature's latest checkpoint with
`land_feature` ([design.md](design.md#block-promotion-in-the-build)).

| Tool | Input | Answer |
|---|---|---|
| `land_feature` | `feature`; optionally `checkpoint`, which must be the feature's latest; optionally `expand: true` to promote only that checkpoint, with an optional `retiring` | `checking` with the run's id, the checkpoint, main's head it is checked against, the branch, the plan and every target fork with its head; or the reason the feature is not ready |

The answer carries no token: Penguin moves main itself. A refusal names what is missing:
`behind_main` (merge main into your fork, report the merge with `report_checkpoint` and land again),
`plan_not_approved`, `protected_path_unconfirmed` (the feature's own change writes a path under
another person's custom path rule, and that person has not confirmed the lines on the dashboard; the
message names each person with the custom paths), `fix_not_written`, `fix_not_in_block`, `fix_not_in_place`,
`copy_not_written` (an affected fork does not yet hold your change's current revision of the modules
it imports; Penguin's check runner copies them, then land again),
`not_ready` (no checkpoint, or nothing past main) or `busy` (a land or expand of the feature is
already being checked).

With `expand: true`, Penguin promotes only the latest checkpoint, the expand step of a split. The
feature keeps building on its fork ([design.md](design.md#expand-in-the-build)). The checkpoint must
hold main's head and only add. A change to a path another person protects waits on
`protected_path_unconfirmed` as a land does. The expand's own refusals are `waiting_for_runner`
(Penguin scheduled the impact run; call again once the check runner reported it), `impact_failed`,
`not_only_adds` (the message lists each entry that fails) and `waiting_on_owner` (the checkpoint adds
to a scope another person owns; that person approves once on the dashboard). A rename or move whose
old name the expand codemod kept as an alias counts as an addition. For a split feature, `retiring`
lists up to 64 `{ "contract": "<path::symbol>", "replacement": "<path::name>" }` pairs: the parallel
function for each old name the codemod does not expand. Each contract must be an old name of the
split. Once the expand reaches main, Penguin marks each old name retiring with its replacement.

`get_work` reports `landing`: the feature's state (`building`, `landing` or `landed`), its newest block
runs, its promotion and under `expansions` each expand checkpoint promoted on its own. Each run names
its purpose (`land`, `expand` or `plan_check`), its state, the failing
checks and one next step per failure under `nextSteps`. A `raced` run met a main that moved; Penguin
checks the block again, or returns the feature to `building` to take main. Check summaries and the
evidence behind each next step come from the repos and the tools' runs, so they arrive only inside
`personWritten`. `report_checkpoint` on a feature fork lists under `planChecks` each announced plan
whose block the checkpoint asked to check again.

## Sending a fix upstream

A session can find that its fix task belongs in the scope the trigger changed, outside its identity's
charter. The session then calls `post_update` with `{"type": "send_upstream", "reason": "..."}` on
the fix sub-issue. Penguin records the note on the issue's timeline. Penguin then labels the
sub-issue with the changing scope, so that scope's owner's review counts on it. It assigns the
sub-issue to an identity of the changing scope's owner whose charter holds that scope, preferring one
with a running session. Last, it unassigns the sender. The tool's answer names the new assignee under
`reassignment`. The new session receives the task at its next safe checkpoint. With no session
of that identity running, the owner's inbox asks for one.

Penguin refuses a send-upstream in three cases and records each refusal on the issue's timeline. The
tool's answer gives the recorded operation as `recordedAs`:

| Reason | Case |
|---|---|
| `not_assignee` | The sending identity is not assigned to the issue |
| `not_a_fix` | The issue is not a Huddle's fix sub-issue |
| `inside_charter` | Every scope the trigger changed lies inside the sender's charter, so the sender fixes it |
