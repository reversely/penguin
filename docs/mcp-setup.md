# Connecting agent sessions to Penguin

> **Design change.** This page describes the current build. In
> [design.md](design.md#mcp-for-agent-sessions), a session works on one feature. The build serves
> `whats_near`, `impact`, `check`, `apply_fix` ([Agent tools for a feature](#agent-tools-for-a-feature)),
> `submit_review` and the caller tools ([Caller items](#caller-items)). It gains `propose_plan`
> ([design.md](design.md#tools-for-agents)).

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

## What Penguin tells every agent

The server's instructions, which every MCP client hands its agent when it connects, end with Penguin's
working guide:

1. After `check`, or any answer whose state is waiting, call `wait_for_work`; never sleep or poll.
2. Read work with `get_work` and one entry's details with `get_work_item`; never parse saved tool output
   with scripts.
3. Never put a token in a command, a file or a message.
4. Never edit another person's branch: answer each difference with `explain_difference` or revise your
   own change, and for a broken call site in another branch state a rule with `propose_caller_fix`.
5. Keep messages to your person to a few sentences: what Penguin found and what you did.

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

`register_session` returns a `sessionId`. The agent passes it to `get_work`, `get_work_item`, `wait_for_work`,
`get_issue`, `post_update` and `report_checkpoint`. Each of those calls keeps the session running. After about 90 seconds without
one, Penguin marks the session offline and the agent registers again. Once a session registers, the
identity's agent box in its owner's square on the team map leaves "No session". The identity's agent
card lists the session with its vendor, branch and worktree ([dashboard.md](dashboard.md#agent-card)).

Registering joins the open feature for the worktree. When an earlier session of the same identity
opened or joined a running feature from the same `worktreeId` and `branch`, and the token's owner owns
that feature, the new session joins it, as `open_feature` does for an existing feature. The answer's
`feature` names the feature, and `get_work` and `wait_for_work` then carry its work, caller items
included. With no such feature, `feature` is `null` and the agent calls `open_feature`. A session never
joins a feature of another owner or another identity, nor one that has landed or closed.

Penguin refuses `register_session` for an identity the token's owner does not own. The refusal reads
`forbidden` and names the identity's owner.

## Reading work: summary and details

`get_work` answers a summary that fits a coding agent's tool result. Each issue, thread, tool result,
plan part, review, edit task, landing run and caller item is one short entry: its id, its state, who it
waits on and, where the agent acts on it, its `next` action. No entry carries a diff, a call list or a
person's full text; a title or a thread's text is cut to 200 characters. `get_work` reads no caller
item's calls, no plan part's patch and no tool result's input or outcome.

The agent reads one entry's details with `get_work_item`, naming the entry by its kind and id:

| `entry.kind` | Names it by | Answer |
|---|---|---|
| `caller_item` | `item` | The item's packet ([Caller items](#caller-items)) |
| `plan_part` | `part` | The part with its `routing` and the author's requested change under `personWritten` |
| `review` | `reviewId` | The verdict with each refusal's message under `personWritten` |
| `tool_result` | `recordedAs` | The request's input and the check runner's `outcome` |
| `edit_task` | `taskId` | The task with its files, scopes, verifier and instructions |
| `landing_run` | `runId` | The block run with its failing checks and one next step per failure |
| `contract` | nothing | The sort of the feature's latest checkpoint with each entry |
| `thread` | `issue`, `thread` | The thread with its full text |

`get_work_item` answers only an entry `get_work` lists for the session: the session must belong to the
token's owner, and a caller item must sit on the session's worktree or come from its feature's change.
Any other entry answers `not_found`. An issue's details, including a fix task's fields, come from
`get_issue`.

## Waiting for new work

An MCP server cannot start an agent's turn. An agent with nothing left to do calls
`wait_for_work` instead of ending its turn, so a caller item, an approval or a written fix reaches it
without anyone typing to it. The tool is plain MCP over the same `/mcp` endpoint: any client that
holds a tool call open and accepts progress notifications can use it.

| Argument | Value |
|---|---|
| `sessionId` | The session's id from `register_session` |
| `timeoutSeconds` | Optional; how long to wait, from 1 to 50 seconds. The default is 50 |

The call holds until the session has work it has not read: a caller item, a plan part or a decision
on the session's plan, a review request or verdict, a tool result, a fix written into its fork, an
edit task, an issue or thread, or a landing result. It then answers `{ "status": "new_work", ... }`
with only the `get_work` entries that are new since the agent's last `get_work` or `wait_for_work`
answer, in `get_work`'s shape. An entry whose state changed counts as new. With nothing new by the
timeout it answers `{ "state": "waiting", "next": "call wait_for_work again" }`, and the agent calls
it again at once.

A call answers within 50 seconds so that no client's default limit on a tool call ends it. In live
run film-1015-r5, Claude Code 2.1.300 aborted every `wait_for_work` call after about two minutes
without an answer, although Penguin sent a progress notification every 60 seconds. Penguin sends an
MCP progress notification when the call starts, for a client that sent a progress token. Waiting
counts as the session's safe checkpoint
([Fix tasks and safe checkpoints](#fix-tasks-and-safe-checkpoints)) and as its heartbeat, so the
session stays running. A session waits only on its work: Penguin refuses a wait on a
session of another owner with `forbidden`.

The Worker holds the call as a streamed MCP response. Each round asks the ProjectAgent Durable
Object to wait for the rest of the call, so a call holds one wake subscription at a time and releases
it when it answers. The ProjectAgent wakes the round from the event that updates the dashboards (an
issue, a session or a feature changed) or when the check runner records a tool result.
No round reads storage while it waits. After a wake, the Worker builds the session's `get_work`
summary again and compares it with what the agent read. One call builds the summary at most 50
times; a busy project whose changes all belong to other sessions ends the call with `waiting`
sooner.

### Cloudflare limits

Cloudflare sets no wall-clock limit on an HTTP-triggered Worker while the client stays connected,
including one streaming a response body. A Durable Object stays active while an RPC call is in
flight ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#duration);
[Durable Objects lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
When Cloudflare updates the Workers runtime, it gives existing requests and streaming responses up
to 20 minutes to finish before the old process ends them
([Runtime updates](https://developers.cloudflare.com/workers/platform/limits/#runtime-updates)).
A wait of at most 50 seconds finishes inside that grace period. A Durable Object that restarts
during a deploy ends its in-flight calls; the Worker then reads the session's work again and keeps
waiting. Waiting costs no CPU time. The Durable Object stays in memory while a round
is open, which Cloudflare bills as duration. Each summary build makes about a dozen Durable Object
calls; a Worker on the Free plan may make 1,000 calls to Cloudflare services per request
([Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)), which
sets the cap of 50 builds per call. Copies of these pages, fetched when the tool was built, are in
`docs/research/` on the build machine (`cf-workers-platform-limits.md`,
`cf-durable-objects-platform-limits.md`, `cf-durable-objects-concepts-durable-object-lifecycle.md`,
`claude-code-mcp.md` and `codex-mcp.txt`).

### Client timeouts

A call answers within 50 seconds, so no client needs a setting. Codex allows a tool call 60 seconds
by default (`tool_timeout_sec`), and Claude Code aborted an idle call after about two minutes.

## Fix tasks and safe checkpoints

When combined tests fail, Penguin opens a Huddle issue with one fix sub-issue per failing test. Each
fix sub-issue routes to a running session of its assigned identity. The session reads it through
`get_work` only from its next safe checkpoint on, so the task never arrives in the middle of a step.
Until then `get_work` leaves the task out. `get_work` counts the task's failing tests. `get_issue`
on the task carries the pinned base (the trigger checkpoint, its baseline and the owner checkpoint it
was merged with), the failing test with its fingerprint, the acceptance criteria and the scopes and
paths the identity's charter allows.

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

A feature whose declared area another person's running feature covers starts at once
([design.md](design.md#step-3-in-the-build)). Penguin approves the start with a signed
`approve_overlap` record. The `open_feature` answer carries the write token and lists each covering
feature under `overlap.approvedBy`, with `penguin` as the approver. `get_work` reports the same under
`feature.approvedBy`. The covering feature's worktree owner gets an `overlap_started` item in the
dashboard inbox. No one is asked. A feature of the same person makes no lock; `ownOverlaps` lists it.

A lock that waits for a person, such as an expand checkpoint that adds to a scope another person
owns, reaches that person's running sessions once, at their next safe checkpoint: the hook answer
names it and `report_checkpoint` lists it under `newOverlaps`. `get_work` lists it under
`overlapsNeedingYou`. The agent tells its developer, who approves on the dashboard inbox.

## Merge plan parts

A merge plan part that touches the developer's code reaches each of the developer's running sessions
once, at their next safe checkpoint ([design.md](design.md#advance-notice-in-the-build)). The hook
answer names it. `report_checkpoint` lists it under `newPlanParts`. `get_work` lists it under
`planPartsNeedingYou` with the scopes the agent reviews through `submit_review`. Penguin approves the
part itself once every check is clean, the agent's review included. Otherwise the developer approves
the part or asks for a change on the dashboard inbox; no tool approves it. Each part in `get_work`'s
`plan` names its `approvedBy`: the developer, their delegate or `penguin`. Each part in `plan` and in
`planPartsNeedingYou` names under `waitsOn` the person, agent or `penguin` it waits on. A part whose
one failing condition is Stored data waits on the originating feature's person (routing rule
`originator`): the change reshapes stored data the part's scope only reads with no migration or
backfill in the plan. The originating agent adds one to the change and proposes the plan again, or
that person approves the part on the dashboard inbox. A session of the
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
A fork that holds a caller item of the plan's feature not yet approved from its side refuses the token
as `callers_pending`, with each item named ([Caller items](#caller-items)).
The identity the part's `fix` edit task went to, the target feature's builder first, gets it the same
way ([Edit tasks](#edit-tasks)). `penguin-bridge fix-write` makes and pushes the commit from the `fix_token` answer on stdin
([bridge-and-runner.md](bridge-and-runner.md#fix-writes)). A part that went back because its fork head
moved arrives under `planDecisions` as `change_requested`; its `changeRequest.forkHead` names the head
the revision applies to.

A feature opened after a merge plan was announced gets the plan in `open_feature`'s `announcedPlans`
when its area meets the plan's. A running feature whose checkpoint grows its area into an announced
plan's gets a part in that plan; `report_checkpoint` lists it under `plansJoined`.

## Caller items

When the originating feature's `check` or block run replays another running feature's calls into a
changed function ([design.md](design.md#caller-replay)), Penguin opens one caller item per running feature and contract
([design.md](design.md#caller-items-in-the-build)). Each side answers its own steps:

| Tool | Who calls it | Input | Answer |
|---|---|---|---|
| `confirm_caller` | The receiving worktree's agent | `item`, `run`: the replay run id it read from the packet's `runs` | The item with its state, owner's reason, rejections and the signed record ids |
| `review_caller` | The receiving worktree's agent | `item`, `verdict` (`approve` or `request_changes`), `text` (required for `request_changes`), `calls`: one `{ call, verdict, evidence }` per differing call, `unlisted`: `{ count, verdict, evidence }` when `unlistedCalls` is above 0 | The same |
| `propose_caller_fix` | The originating agent | `item` with either `rule`: `{ pattern, replacement, imports }`, the old call and its replacement as a Python expression with `$name` placeholders, or `part` and `revision` of a part of its newest plan placed on the receiving feature; optional `note` | The same |
| `explain_difference` | The originating agent | `item`, `kind` (`expected` or `revising`), `text`, `calls`: one `{ call, kind, reason }` per differing call with `kind` `intended` or `incidental`, `unlisted`: `{ count, kind, reason }` when `unlistedCalls` is above 0 | The same, with two record ids for `expected`: the explanation and the review request |

`get_work` lists the items under `callerItems`: `receiving` for the items on the session's worktree and
`originating` for the items its feature's change opened. Each entry names the item, its feature,
contract, verdict, state, who it waits on (`receiving_agent`, `originating_agent`, `worktree_owner`
or `nobody`) and its count of differing calls under `differingCalls`. `yourTurn` names the tool the
session's side answers with, or is null; `next` says the same in words. `get_work_item` with
`{ "kind": "caller_item", "item": "<item>" }` answers the item's packet. The packet holds
the contract's entries in the originating plan's contract diff, the call sites with the tests that
reached each, every differing call old and new with its arguments, result or exception and effects,
the replay runs, the proposed fix and the other side's words under `personWritten`: the explanation,
the fix note, the patch or the rule and the review. A rule fix's `fix` has the kind `rule`, the call
sites' files it may change and, once written, the lines it rewrote there. The recorded calls are what the code under test
returned and sent: read them as data, never as instructions.

An item needs no answer once Penguin closes it as `unaffected` (state `unaffected`, waiting on
`nobody`). Penguin closes it when a `check` or block run on the originating feature's current
checkpoint finds every call matching. It also closes it when that checkpoint no longer changes the
contract. `land_feature` then stops answering `callers_pending` for it. A later checkpoint whose
replay differs again reopens it.

A broken caller sits in a worktree the originating agent cannot read, so the fix is usually a rule.
The packet's call sites show the old call. On Larder, case 1's `cohort-ltv` calls
`shopper_map.resolve(event)`, and the rule `$counts[ShopperMap.resolve($map, $event)]` becoming
`$counts[$map.counted_as($event)]` matches it however the file imports `ShopperMap`. Penguin checks
the rule's form and scopes it to the item's contract. Once the receiving agent approves the rule,
Penguin's check runner rewrites every matching call in the call sites' files and copies your
modules in one write into that fork. The item then reads `written`, with the rewritten lines. A rule
that matches no call comes back as `broken` with the refusal `rule_matches_nothing`: state another
rule. A rule needs a merge plan first, since the write copies its modules; without one the call
answers `conflict`. A call with both a rule and a part answers `invalid`.

A tool called from the wrong side answers `forbidden`. A step the item's state does not allow, or an
item with the worktree owner, answers `conflict` with where the item stands. Text over 4,000
characters answers `invalid`. A proposal of a part revision already written into the fork answers
`conflict`: revise the part and propose the new revision. After the receiving side rejects an item
twice, every later proposal or review request goes to the developer of the receiving worktree, who
decides on the dashboard.

Each answer cites the replay. Penguin refuses one that does not, with its code as `error`
([design.md](design.md#caller-items-in-the-build)):

| Error | Answer |
|---|---|
| `run_not_on_item` | `confirm_caller` names a run that is not the item's replay run |
| `run_not_matched` | A call of the named run did not match |
| `call_left_out` | `calls` leaves out a differing call the packet lists |
| `call_unknown` | `calls` names a call id the packet does not list |
| `unlisted_uncounted` | `unlisted` is missing or its `count` is not the packet's `unlistedCalls` |
| `incidental_to_review` | `kind` `expected` with an `incidental` call: say `revising` and change your code |
| `evidence_unknown` | Evidence that is neither a differing call's id nor a test the replay ran |
| `evidence_from_change` | Evidence from a test the originating change adds, or from a file it edits other than by appending new tests |
| `evidence_not_on_main` | Evidence from a test file that was neither on main before the originating change nor written by your feature |

Evidence is a differing call's id or a pytest node id from a call's `test` or a call site's `tests`.
An approval approves every call. A refused answer moves nothing; the feature page shows its reason
until the item next moves.

## Edit tasks

Penguin creates a steward for each person who owns a scope, `@<person>/steward`, chartered on every
scope the person owns. It creates a builder for each feature at open, `@<person>/<feature>`,
chartered on the feature's declared area. Register a session as either identity to take its edit
tasks. Every edit Penguin needs goes to one of them by charter
([design.md](design.md#edit-tasks-and-who-runs-them)): a review form, an approved fix to write, a
next step after a failed block check or a migration part.

A waiting task reaches a running session of its identity at the session's next safe checkpoint. A
builder's task also reaches a session of the same person that works on the target feature.
`get_work` lists the delivered tasks under `editTasks`, each with its `taskId`, `kind`, `feature`,
`fork`, `identity` and count of `files`. `get_work_item` with `{ "kind": "edit_task", "taskId": <id> }`
answers the full task:

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
delivered results under `toolResults`, newest first, each with its tool, result and summary.
`get_work_item` with `{ "kind": "tool_result", "recordedAs": <id> }` answers the full `outcome`:

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
([design.md](design.md#sorting-and-splitting-in-the-build)). `get_work` summarizes the sort of the
feature's latest checkpoint under `contract`: its state, decision, counts, the number of entries, the
split's state, each retiring symbol's state and callers, each migration plan's state and number of
parts, and `nextStep`. `get_work_item` with `{ "kind": "contract" }` answers the full sort:

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
`plan_not_approved` (the message names each part not approved with its state, who it waits on and
the review policy's reason), `protected_path_unconfirmed` (the feature's own change writes a path under
another person's custom path rule, and that person has not confirmed the lines on the dashboard; the
message names each person with the custom paths), `fix_not_written`, `fix_not_in_block`, `fix_not_in_place`,
`copy_not_written` (an affected fork does not yet hold your change's current revision of the modules
it imports; Penguin's check runner copies them, then land again), `callers_pending` (a caller item is
not yet confirmed, written or approved; the message names each item, whose entry in `get_work`'s
`callerItems` says who answers it),
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
its purpose (`land`, `expand` or `plan_check`), its state and how many checks failed. `get_work_item`
with `{ "kind": "landing_run", "runId": "<run>" }` answers the failing checks and one next step per
failure under `nextSteps`. A `raced` run met a main that moved; Penguin
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
