# Connecting agent sessions to Penguin

> **Design change.** This page describes the current build. In
> [design.md](design.md#mcp-for-agent-sessions), a session works on one feature. The build serves
> `whats_near`, `impact`, `check`, `apply_fix` ([Agent tools for a feature](#agent-tools-for-a-feature))
> and `submit_review`. It gains `propose_plan` ([design.md](design.md#tools-for-agents)).

An owner's Claude Code or Codex session reads the issues assigned to one of the owner's identities and
writes comments, linked commits and state changes back to them. The session reaches Penguin's MCP
endpoint, `<worker-url>/mcp`, with the owner's MCP token. The token decides whose identities the
session may use. This page covers issuing a token, connecting each agent product, registering a
session and running the agent-session exit check by hand and as a script.

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

Only the identity that proposed the plan gets the token, only for the part's current approved
revision. `penguin-bridge fix-write` makes and pushes the commit from the `fix_token` answer on stdin
([bridge-and-runner.md](bridge-and-runner.md#fix-writes)). A part that went back because its fork head
moved arrives under `planDecisions` as `change_requested`; its `changeRequest.forkHead` names the head
the revision applies to.

A feature opened after a merge plan was announced gets the plan in `open_feature`'s `announcedPlans`
when its area meets the plan's. A running feature whose checkpoint grows its area into an announced
plan's gets a part in that plan; `report_checkpoint` lists it under `plansJoined`.

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
| `nextStep` | What to do next, in one paragraph |

An incompatible entry makes the next step start with "Expand first" and list the entries. For a
rename, a move or a keyword rename, call `apply_fix` with `kind: "codemod"` and `expand: true`:
Penguin's codemod writes the alias or forwarding function that keeps the old name working. For a
changed type, a breaking signature or a removed symbol, write the parallel function beside the old
one under a new name. Report that expand as a checkpoint and call `land_feature` with `expand: true`.
Name the parallel functions in its `retiring`. Once the expand reaches main, the next step lists the
names now retiring and asks for the migration plan. A behaviour change keeps the merge plan:
the next step asks for `propose_plan`. `report_checkpoint` on a feature fork answers the facts run it
sorts under `contractSort`.

## Merge plans

A session whose feature changes something other scopes or running features depend on calls
`propose_plan` with its feature and one part per affected place. A `note` of up to 2,000 characters is
optional on each part.

| Place | Fix |
|---|---|
| `{ "scope": "<scope id>" }`, code already on main | `diff: { commit, base? }`, a commit in your feature's fork. `base` defaults to the commit's first parent |
| `{ "feature": "<feature id>" }`, a running feature | `patch: { base, diff }`, a unified diff as `git diff` prints it, against that feature's fork head. `base` is the head the answer lists under `affectedFeatures[].head` |

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
checkpoint whose own changes call a retiring symbol gets a next step naming the replacement. A
complete
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
`plan_not_approved`, `protected_path_unconfirmed` (the feature's own change writes a path another
person protects, and that person has not confirmed the lines on the dashboard; the message names
each person with the protected paths), `fix_not_written`, `fix_not_in_block`, `fix_not_in_place`,
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

## Manual exit check with live sessions

These steps run the agent-session exit check with a live Claude Code session and a live Codex session. They
need Priya and Jun signed in to the dashboard in two browsers, plus an integration runner.

1. The deployer issues MCP tokens for Jun and for Sam, then a runner registration code with
   `POST /bridges/codes` and the body `{"owner":"runner","role":"runner"}`.
2. The runner's operator registers the runner bridge with
   `penguin-bridge register --server https://<worker-url> --owner runner --code <code>`
   and starts `penguin-bridge runner`, which pushes pending operations every 10 seconds.
3. Jun signs in to the dashboard. On the Identities page, Jun creates `@jun/reports` with
   "Auto-accept assignments" checked.
4. Jun connects a Claude Code session with Jun's token (Claude Code section) and registers it as
   `@jun/reports` with vendor `claude-code`. Jun connects a Codex session with Jun's token (Codex
   section) and registers it as `@jun/reports` with vendor `codex`. On Priya's team map, the
   `reports` box in Jun's square changes from "No session" to "Working" without a reload. The
   identity's agent card lists both sessions.
5. Security: a Codex session started with Sam's token in `PENGUIN_TOKEN` asks to register as
   `@jun/reports`. The tool answers `forbidden`. The agent card of `@jun/reports` lists no new session.
6. Priya opens an issue and assigns `@jun/reports`. On the team map, Priya selects New issue, enters
   the title "Retention dashboard counts merged users twice", checks `@jun/reports` under Assignees and
   selects Create. The dashboard opens the new issue's page with `@jun/reports` under Assignees.
   On Priya's team map, the `reports` box in Jun's square shows the issue's number without a reload.
   Jun's inbox lists the issue under
   Assignments without a reload. The issue page's Assignees panel also assigns an identity to an
   existing issue with Assign and removes an assignee with Unassign.
7. Jun asks either session to call `get_work`. The issue is in the result.
8. Jun asks the session to comment on the issue with `post_update` and to link a commit, such as
   `owner-jun@0df91904e50f51cdb08e5fda28ab62d9121746c0` with kind `fix`. The issue page shows the
   comment and the commit without a reload.
9. On its next pass the runner prints `N pending: N pushed in commit <sha>`. The four operation files
   appear under `issues/<number>/ops/` in the issues repo. Once the push event reaches Penguin,
   `get_issue` reports `waitingForGitLog: false` for each. The issue page header shows no
   "waiting for the Git log" line ([issues.md](issues.md#pending-push)).

## Scripted exit check

`tests/e2e/exit-check.test.ts` runs the same steps with JSON-RPC calls to `/mcp` in place of a live
agent. In place of the New issue form, it sends the create and assign operations the form sends to
`/api/operations`. It signs in as Priya and Jun, listens on both people's `/api/live` sockets, registers the runner
bridge with an in-memory key store and runs `penguin-bridge runner --once` passes until the operations
appear on a fresh fetch of the issues repo. It closes the issue at the end and revokes the MCP tokens
and the runner bridge it made. `npm test` skips it unless `PENGUIN_E2E_URL` is set.

| Variable | Meaning | Default |
|---|---|---|
| `PENGUIN_E2E_URL` | The Worker's origin | none; the test is skipped |
| `PENGUIN_E2E_DEPLOYER_TOKEN_FILE` | A file holding the deployer token | `~/.config/penguin/deployer-token` |
| `PENGUIN_E2E_SIGN_IN` | `github-double` for a loopback Worker, `cookies` for a deployed one | chosen from the URL |
| `PENGUIN_E2E_PRIYA_COOKIE_FILE`, `PENGUIN_E2E_JUN_COOKIE_FILE` | Files holding each person's `__Host-penguin_session` cookie value, copied from a signed-in browser | none |
| `PENGUIN_E2E_PRIYA_LOGIN`, `PENGUIN_E2E_JUN_LOGIN` | GitHub logins the test double signs in as | `priya-gh`, `jun-gh` |
| `PENGUIN_E2E_RUNNER_OWNER` | The owner id the runner bridge registers as | `runner` |
| `PENGUIN_E2E_TIMEOUT_MS` | The wait for a live message or a push | `60000` |

The test prints its timings as test diagnostics, each in milliseconds from the assign operation: to
the live messages, to `get_work` returning the issue, to the assign operation appearing in the issues
repo and to all four operations appearing there.

### Against a local Worker

The local Worker runs the real Worker and agents in `wrangler dev`, with the Artifacts binding pointed
at the real namespace. A repo prefix keeps the run's repos apart from production's. The secrets go in
an env file with mode 0600: `PENGUIN_DEPLOYER_TOKEN` (any random value), `PENGUIN_OP_SIGNING_KEY` (an
Ed25519 private JWK), `PENGUIN_REPO_PREFIX`, `PENGUIN_GITHUB_BASE_URL=http://127.0.0.1:8788`,
`GITHUB_OAUTH_CLIENT_ID=double-client`, `GITHUB_OAUTH_CLIENT_SECRET=double-secret` and
`PENGUIN_DASHBOARD_OWNERS=priya-gh:priya,jun-gh:jun,sam-gh:sam`.

```sh
node apps/worker/test/github-double.ts --port 8788
npx wrangler dev -c apps/worker/wrangler.jsonc --ip 127.0.0.1 --port 8787 --env-file <env file>
PENGUIN_E2E_URL=http://127.0.0.1:8787 PENGUIN_E2E_DEPLOYER_TOKEN_FILE=<file with the same deployer token> \
  node --test tests/e2e/exit-check.test.ts
```

The run's `/setup` call creates `<prefix>base` and `<prefix>issues`. Delete them afterwards with
`npx wrangler artifacts repos delete <name> --namespace penguin -y`. The local Worker receives no
Artifacts push events, so its operations stay marked as waiting for the Git log after the runner
pushes them.

### Against the deployed Worker

The deployed Worker needs Priya and Jun to sign in through GitHub. Each person signs in to the
dashboard in a browser, copies the `__Host-penguin_session` cookie value from the browser's developer
tools into a file with mode 0600 and passes the two files:

```sh
PENGUIN_E2E_URL=https://<worker-url> \
PENGUIN_E2E_PRIYA_COOKIE_FILE=<file> PENGUIN_E2E_JUN_COOKIE_FILE=<file> \
  node --test tests/e2e/exit-check.test.ts
```

The run writes to the production project: it creates `@jun/reports` when the identity is missing,
leaves one closed issue in the issues log and registers then revokes two MCP tokens and one runner
bridge.
