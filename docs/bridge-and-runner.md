# Bridge and runner

`penguin-bridge` is the one piece of Penguin each owner runs on their own machine. It publishes the
owner's checkpoints to Penguin after showing the exact changes, writes signed issue operations from
the command line and tells Penguin when an agent session reaches a safe checkpoint. The same program
in runner mode is the project's integration runner: it pushes the operations Penguin applied and runs
the combined tests. The code is in `services/local-bridge/src/`.
[architecture.md](architecture.md) shows where both sit.

## Installing

The bridge needs Node.js 22.18 or later, Git 2.38 or later (for `git merge-tree --write-tree`) and,
on a runner, the test tools the project's `penguin/scopes.json` commands call. The fixtures use
Python with pytest from `uv sync`. A runner's checks also need Python 3.11 or later, ruff from
`uv sync` and the pyright package `npm install` installs. Its fixes need libcst from `uv sync` and
`uv` on `PATH`.

```sh
git clone <penguin repo> ~/penguin
cd ~/penguin && npm install
```

The hook settings and every example call the bridge as `penguin-bridge`. The package
`services/local-bridge` declares that command as its `bin`, with `src/cli.ts` as the entry point.
Node runs the TypeScript directly. Install the command on `PATH` from the clone:

```sh
cd ~/penguin && npm install -g ./services/local-bridge
penguin-bridge   # prints the usage of every command
```

npm links the global command to the folder in the clone without copying it. The command therefore
runs the clone's current code with the dependencies `npm install` put in `~/penguin/node_modules`.
Inside the clone, `npx penguin-bridge` runs the same command without a global install.

## Registering

The deployer issues a one-time registration code for the owner, valid for 900 seconds:

```sh
curl -sS -X POST https://<worker-url>/bridges/codes \
  -H @<file holding "Authorization: Bearer <deployer token>"> -H 'Content-Type: application/json' \
  -d '{"owner":"jun","role":"owner"}'
```

The owner spends it:

```sh
penguin-bridge register --server https://<worker-url> --owner jun --code <code>
```

Registration creates the owner's Ed25519 signing key if there is none, sends the public half to
Penguin and stores the bridge token Penguin returns. The command refuses a code issued for another
owner. The deployer revokes a bridge with `DELETE /bridges/<bridge id>`; a revoked bridge's tokens
stop working and its key no longer verifies operations.

### Keys and local state

| Item | Where | Notes |
|---|---|---|
| Signing key | OS keychain, service `penguin-bridge`, account `signing-key:<owner>` | Ed25519 private JWK. `penguin-bridge key --owner <id>` prints the public half |
| Bridge token | OS keychain, account `bridge-token:<owner>` | Never printed |
| Artifacts repo tokens | Process memory only | Fetched from `POST /tokens` at push time; Git receives each through `GIT_CONFIG_*` environment variables for one command, never an argument, config file or remote URL |
| Registration record | `~/.penguin/bridge.json`, mode 0600 | Server, bridge id, owner and role; nothing secret |
| Outbound spool | `~/.penguin/spool.jsonl` | Append-only queue of operations and checkpoint pushes |
| Publishing consent | `~/.penguin/consent.json`, mode 0600 | Each standing yes for checkpoint publishing; nothing secret |
| Issues clone | `~/.penguin/issues/<hash>/` | The bridge's clone of the `issues` repo |
| Runner repository | `~/.penguin/combined/` | Runner mode only |

The keychain is macOS Keychain, Windows Credential Manager or Linux Secret Service, through
`@napi-rs/keyring` (`key-store.ts`). Every command takes `--state-dir <dir>` in place of `~/.penguin`.
The bridge sends credentials only over HTTPS; plain HTTP is accepted only for a loopback host such
as `wrangler dev`.

## Checkpoint publishing

```sh
penguin-bridge checkpoint --owner jun --project <project id> --identity @jun/reports
```

The command publishes the worktree it runs in (`--worktree <path>` names another) to the owner's fork
`penguin:owner-<owner>` (`checkpoint.ts`):

1. It builds a checkpoint commit of the worktree's tracked files as they are on disk, parented on
   `HEAD`, without touching the worktree, its index or any local ref. Untracked and ignored files are
   never published. When the fork's branch holds an earlier checkpoint that `HEAD` does not contain,
   that checkpoint becomes a second parent, so every push fast-forwards.
2. It prints a preview: the checkpoint, the destination branch and every tracked file that differs
   from the newest commit the fork already has, with line counts.
3. It asks "Publish this checkpoint? [y/N]" unless a stored yes covers the worktree. Only an
   explicit yes publishes.
4. It appends the push to the spool and pushes to `refs/heads/<branch>` of the fork, without force.
   With the fork unreachable the push stays queued and a later drain sends it.
5. It reports the checkpoint on `POST /checkpoints`, which records it as the fork's latest checkpoint
   and schedules combined runs ([huddle-flow.md](huddle-flow.md#2-combined-run-scheduling)).
6. It sends a safe checkpoint for the worktree and prints any fix task delivered to a session there.

`--consent` sets how far one yes reaches. The preview prints before every push in each mode.

| Value | One yes covers |
|---|---|
| `each-publish` | This publish only |
| `worktree` (default) | Later publishes from the same worktree to the same fork |
| `project` | Later publishes from every worktree to the same fork |

The bridge stores each `worktree` or `project` yes in `~/.penguin/consent.json`
(`consent-store.ts`). A grant names the owner, the project, the fork and the worktree id. A later
`penguin-bridge checkpoint` from that worktree to that fork prints "Standing consent (worktree)
covers this publish." and pushes without asking. Another worktree or another fork asks. A publish
with `--consent each-publish` asks even when a grant is stored.

```sh
penguin-bridge consent list                       # every stored yes, with its worktree path and fork
penguin-bridge consent revoke                     # the yes for the worktree the command runs in
penguin-bridge consent revoke --worktree <path>   # the yes for another worktree
penguin-bridge consent revoke --all               # every yes, including project-wide ones
```

After a revoke the next publish from that worktree asks again. Deleting `~/.penguin/consent.json`
has the same effect as `--all`.

`--fork <bare repo path>` publishes to a local bare repository instead, for working without
Penguin. `--remote` must name the same fork; any other destination is refused before Git runs.

### Agent trailer and identity checks

With `--identity @<owner>/<name>`, a checkpoint commit the bridge builds ends with a trailer that
names the agent identity whose session made it:

```text
Penguin-Agent: @jun/reports (codex)
```

The vendor comes from `penguin/identities.json` as committed at `HEAD`. A handle missing from that
file, or with no valid vendor, publishes without the trailer and prints a warning.
`--agent-trailer off` turns the trailer off for the project. The trailer carries no email.

The identity's owner is checked on every publish that names an identity, with the trailer on or off.
The handle's owner half must be the fork's owner, or, for a team identity listed with an `owners`
array, that array must include the fork's owner. Any other identity refuses the publish before the
fork is read.

## Issue command line

Owners write issue operations from the bridge. Each is signed with the bridge key, appended to the
spool, written to the bridge's clone of `issues`, committed and pushed (`issue-cli.ts`,
`issue-writer.ts`).

```sh
penguin-bridge issue create  --owner jun --title "Retention counts merged users twice" [--body <text>]
penguin-bridge issue comment --owner jun --issue 31 --body "Looking at the cutover"
penguin-bridge issue label   --owner jun --issue 31 --label scope:analytics
penguin-bridge issue assign  --owner jun --issue 31 --to @jun/reports
penguin-bridge issue review  --owner jun --issue 33 --verdict request_changes \
  --commit owner-priya@9b2f10 --reason "A limit of five still joins the tablet's users."
penguin-bridge issue state   --owner jun --issue 31 --state closed --reason "Duplicate" [--resolution cancelled]
```

| Option | Default | Meaning |
|---|---|---|
| `--as <person or @owner/name>` | The owner in person | The author; only the owner or the owner's identities verify |
| `--base-version <n>` | The number of the issue's operation files in the clone plus those still queued | The issue version the operation is based on |
| `--repo` | `penguin:issues` | A local bare repository path instead, for working without Penguin |

The default base version counts every file in the issue's folder. A rejected operation does not
advance the issue's version, so after a rejection pass `--base-version` with the version
`get_issue` or the issue page reports.

`create` writes the issue under a temporary ID, which is its own op_id, then prints it. Penguin gives the issue
a number when it applies the create; the temporary ID stays an alias, so later commands keep naming
the issue by it ([issues.md](issues.md#offline-issues-and-aliases)).

With the issues repo unreachable, the operation stays signed and queued in the spool and the command
still exits 0. The next issue command, `penguin-bridge spool drain` or `penguin-bridge spool watch`
pushes it.

## Safe checkpoints

```sh
penguin-bridge session-checkpoint [--hook]
penguin-bridge worktree-id
```

`worktree-id` prints the id an agent session in this worktree registers with. `session-checkpoint`
tells Penguin the sessions in this worktree are between steps, so waiting fix tasks, thread
notices, merge plan parts, decisions on the session's plan and review verdicts reach them
(`session-checkpoint.ts`). The hook answer carries refusal codes and exception kinds only; the
agent reads the words behind them with `get_work`. With `--hook` it is a PreToolUse hook for Claude Code
and Codex: it prints a hook answer only when something arrived and always exits 0, so an unreachable
Penguin never stops the agent. [mcp-setup.md](mcp-setup.md#fix-tasks-and-safe-checkpoints) has the
hook settings.

## Edit tasks

```sh
penguin-bridge edits [--once] [--interval <ms>] [--vendor claude|codex] [--program <path>]
                     [--model <name>] [--timeout-minutes <n>] [--repo <path>] [--project <id>]
```

Penguin routes each edit its procedure needs to the owner's steward or to a feature's builder
([design.md](design.md#edit-tasks-and-who-runs-them)). A task no running session takes waits for the
owner's bridge. `edits` claims those tasks and runs each identity headless on the owner's machine,
with the owner's own agent account (`edit-run.ts`, `edits-cli.ts`). It runs no task when the owner
is away from the machine and the command is not running: Penguin then asks the owner to start a
session.

Each pass:

1. **Claim.** `POST /edit-tasks/claim` hands the bridge its owner's oldest waiting tasks, at most
   `PENGUIN_BACKGROUND_RUN_CAP` running at once (default 2). Each task names its fork, files, allowed
   paths, Penguin's instructions and the checks that verify it. Each comes with a write token minted
   for that task on that fork alone, for `PENGUIN_EDIT_RUN_MINUTES` (default 20). A review form gets
   a read token instead, plus a task token for Penguin's MCP server ([Review forms](#review-forms)).
   The claim also holds the owner's queue.
2. **Worktree.** The bridge fetches the fork's `main` with the task's token into `<state>/edits/repo`
   and adds a fresh detached worktree of its head under `<state>/edits/worktrees`. A review form's
   worktree is the part revision's trial tree instead ([Review forms](#review-forms)).
3. **Run.** The bridge starts one CLI process per task in that worktree, with a prompt built from the
   task. The token reaches Git only through the fetch and push environment, never the CLI's.

   | `--vendor` | Command | What restricts the agent |
   |---|---|---|
   | `claude` (default) | `claude -p <prompt> --output-format json --permission-mode dontAsk --restricted --allowedTools Read,Edit,Write,Glob,Grep` | `--restricted` removes the tools that run commands or code, ignores the user, project and local settings files and confines the file tools to the working directory. `dontAsk` denies every call the allowed tools do not cover |
   | `codex` | `codex exec --sandbox workspace-write --cd <worktree> --ephemeral --json -c approval_policy="never" <prompt>` | The workspace-write sandbox allows writes in the worktree only. No command asks for approval |

   The flags come from each CLI's own help on the owner's machine (`claude --help`, `codex exec
   --help`). `--model` passes a model name through.
4. **Time limit.** A run past `--timeout-minutes` (default 15) is stopped with `SIGTERM`, then
   `SIGKILL`. Keep the limit below `PENGUIN_EDIT_RUN_MINUTES` so the task's report reaches Penguin
   before its claim runs out.
5. **Commit.** The bridge stages what the agent changed. A run that changed nothing, or changed a file
   outside the task's allowed paths, publishes nothing. Otherwise the change becomes one commit on the
   fork's head with a `Penguin-Agent: <handle> (<vendor>)` trailer.
6. **Consent.** The bridge prints the preview: the commit and each file with its added and deleted
   lines. The owner's yes stands for later results of the same identity on the same fork
   (`edit-<handle>-<fork>` in `consent list`). Without a standing yes, the bridge asks at the terminal.
   `consent revoke --all` withdraws it.
7. **Publish.** The bridge pushes the commit with no force, so a fork whose head moved refuses it. It
   reports the task to `POST /edit-tasks/<task id>` with the commit and a one-line outcome. For a fork
   of the owner's own feature it then reports the commit at `POST /checkpoints`. Penguin's checks
   follow as for any checkpoint.
8. **Clean up.** The bridge removes the worktree and its fetch ref, whatever happened.

An approved fix needs no agent: its patch is fixed, so the bridge writes it with the fix-write code
([Fix writes](#fix-writes)) and reports that commit. Penguin opens a fix task only for a write opened
for an agent before the check runner wrote every part (#207); every later approval goes to the runner.

Penguin keeps a reported commit only when it has one parent, sits on the fork's `main` and changes
only the task's allowed paths. Otherwise the task goes back to the owner with Penguin's reason.

### Review forms

A review task asks the owner's steward for the review form of one scope on one revision of a plan
part ([mcp-setup.md](mcp-setup.md#edit-tasks)). The run changes no file. The agent sends the form
itself with `submit_review` on Penguin's MCP server (`edit-run.ts`).

1. **Claim.** The task names its part, revision and scope under `review`. It comes with a read
   token on the reviewed feature's fork and `mcp`, a task token (`pgt_...`). The task token allows
   `submit_review` for that part revision and scope, plus `whats_near` and `impact` on that feature.
   It stops working when the claim ends or the bridge reports the task. `review.trial` names what
   the part revision's trial tree is built from, read from the feature's newest plan: the target
   (main at the plan's baseline, or the affected feature's fork head), the plan's checkpoint and the
   fix (the part's patch, or its fix commit with that commit's base). It is null when the newest plan
   no longer holds the revision or the fix has no base.
2. **Trial tree.** The bridge fetches the reviewed fork's `main` with the task's read token. It
   fetches the target's repo and the fix commit's repo with read tokens from `POST /tokens`, which
   every bridge may hold on `base` and on any feature fork. It then builds the trial tree as the
   part's trial does (`trial-tree.ts`, [Part trials](#part-trials)): the patch applied to the fork
   head, the checkpoint merged in, the fix commit applied on top. That is one extra merge per review
   run. The worktree is a detached checkout of that tree, so the agent reads the code with the fix in
   place. A trial tree that does not build fails the run before the CLI starts, with the conflict
   as the outcome. Penguin then asks the owner. A task with no trial checks out the fork's `main`.
3. **Prompt.** The prompt says the checkout is the trial tree of the part revision. It names the
   target, the checkpoint and the fix: the patch with the fork head it applies to, or the fix commit
   with its repo and base. It lists the files the fix changes, at most 60, with a count of the rest.
4. **MCP config.** The bridge hands the CLI Penguin's MCP server, `<server>/mcp`, as its only server:

   | `--vendor` | Command | Where the token goes |
   |---|---|---|
   | `claude` | `claude -p <prompt> --output-format json --permission-mode dontAsk --restricted --strict-mcp-config --mcp-config <file> --allowedTools Read,Glob,Grep,mcp__penguin__submit_review,mcp__penguin__whats_near,mcp__penguin__impact` | An MCP config file with the `Authorization` header, mode 0600, in a directory of its own under `<state>/edits/worktrees` outside the task's worktree. `--restricted` confines the file tools to the worktree, so the agent cannot read the file. The bridge deletes it after the run |
   | `codex` | `codex exec --sandbox read-only --cd <worktree> --ephemeral --json --ignore-user-config -c approval_policy="never" -c mcp_servers.penguin.url=... -c mcp_servers.penguin.bearer_token_env_var="PENGUIN_TASK_TOKEN" -c mcp_servers.penguin.required=true -c mcp_servers.penguin.enabled_tools=[...] -c mcp_servers.penguin.default_tools_approval_mode="approve" -c shell_environment_policy.filters={PENGUIN_TASK_TOKEN="exclude"}` | `PENGUIN_TASK_TOKEN` in the CLI's environment, which the MCP settings name. The shell policy keeps it from every command the agent runs |

   The token never appears in the CLI's arguments or in anything the bridge prints.
   `--strict-mcp-config` and `--ignore-user-config` keep the owner's other MCP servers out of the
   run, so each review run holds one MCP connection. The flags come from `claude --help`,
   `codex exec --help` and the Codex configuration reference.
5. **Form.** Penguin checks each call against the task before it runs. The form then goes through
   the same validation, part trial and routing as a form from a running session. A refused form
   answers every reason. The agent then submits again. A form for another scope or feature, any other
   tool and any call after the task ends are refused.
6. **Report.** The bridge reports `done` with no commit. Penguin keeps the report only when the run
   submitted a form it did not refuse. Otherwise the task goes back to the owner as `run_failed`. A
   form that arrived closes the task as done even before the report.

The outcome line is built from facts: the CLI, its exit, the number of files changed, the time and
the commit. Nothing the agent printed leaves the machine. The CLI's JSON output is read locally for
its error flag only. Each CLI keeps its own session record on the owner's machine.

**Failures release the task.** The bridge reports a failed run, an error result, a timeout or a
refused consent at once. Penguin then asks the owner. When the command is interrupted, it stops every
running CLI and reports each task as stopped. A bridge that stops without reporting loses the claim
when `PENGUIN_EDIT_RUN_MINUTES` runs out. Penguin then asks the owner. A bridge that has not polled
for two minutes counts as offline: its owner's waiting tasks ask the owner. They return to the queue
when the bridge polls again.

**Status line.** Each pass ends with the owner's queue:

```text
Edit task 11 (@jun/weekly-report on feature-weekly-report): done: claude -p changed 1 file in 41 s; pushed 3f2a9c1d0b7e
Edit tasks for jun: 1 running, 2 queued, 0 asked (cap 2).
```

`--once` runs one pass and exits 1 when any task did not finish as done.

### Edit task live check

`tests/e2e/edit-task-run.test.ts` runs one task on the helpful-fix fixture against real Artifacts.
The Worker runs under local `wrangler dev` with every repo under a prefix unique to the run. Priya
and Jun open their features and push their first checkpoints. Jun's session then goes offline.
Priya's agent lands the UTC change. The runner's block run fails Jun's tests on Jun's fork, so Penguin opens
a next-step task for Jun's builder. Jun's bridge runs `penguin-bridge edits --once --vendor claude`.
The test checks the task is done and that its commit sits on Jun's fork head with changes under
`analytics/` only. It deletes every repo under the prefix at the end and prints no token.

```sh
PENGUIN_EDIT_E2E=1 node --test tests/e2e/edit-task-run.test.ts
```

It needs `wrangler` signed in to the account that holds the Artifacts namespace, `claude` signed in
on the machine and `uv sync` for the runner's tests. `PENGUIN_EDIT_E2E_MODEL` picks the model
(default `sonnet`). `PENGUIN_EDIT_E2E_OUT` names the folder for `evidence.json` and the Worker log.

### Review task live check

`tests/e2e/review-task-run.test.ts` runs PRD case 2 on the helpful-fix fixture against real
Artifacts under local `wrangler dev`, with every repo under a prefix unique to the run. It runs the
walkthrough's steps up to Priya's plan, so Google Chrome drives the dashboard steps. Priya's agent
reports `owner-priya-local-day` before it proposes the plan, as PRD case 2 orders it. No steward session
runs. Jun's and Sam's bridges each run `penguin-bridge edits --once --vendor claude`, which submits
each review form through Penguin's MCP server. The check runner then records the forms and runs the
part trials. `evidence.json` records each part's decision, who approved it, whether any author was
asked and the repos deleted at the end. Nothing prints a token.

```sh
PENGUIN_REVIEW_E2E=1 node --test tests/e2e/review-task-run.test.ts
```

It needs what the edit task live check needs, plus Playwright's Chromium
(`npx playwright install chromium`). `PENGUIN_REVIEW_E2E_MODEL` picks the model (default `haiku`).
`PENGUIN_REVIEW_E2E_OUT` names the output folder.

## Runner mode

One designated machine runs the bridge as the project's integration runner. The deployer issues a
code with `{"owner":"runner","role":"runner"}`. The operator registers with it:

```sh
penguin-bridge register --server https://<worker-url> --owner runner --code <code>
penguin-bridge runner --combined
```

`runner` refuses to start on a bridge registered as `owner`. Each pass, every 10,000 ms by default
(`--interval <ms>`), it:

1. Lists `GET /operations/pending` and writes each operation file at the path the operation names,
   refusing any listing whose path differs. It makes one commit and pushes once
   ([issues.md](issues.md#pending-push)).
2. With `--combined` or `--repo <path>`, also runs Penguin's test jobs in the repository at `<path>`,
   default `~/.penguin/combined`, created empty when missing:
   - claims and runs combined runs with the [block checks](#block-checks) on every merged tree
     (`combined-run-pass.ts`). `--python <path>` names the interpreter for the impact graph and
     the dependency diff, default `python3`, and the one the type check resolves imports against. `--ruff <path>` names ruff. Without it the runner uses `PENGUIN_RUFF`, then this repository's
     pinned ruff in `.venv/bin/ruff`, then `ruff` on `PATH`, because an older ruff elsewhere on `PATH`
     (such as an Anaconda install) formats differently;
   - lists and runs the facts runs of merge plans ([Plan facts runs](#plan-facts-runs)), reporting
     each one to `POST /plan-facts/<run id>` (`plan-facts-run.ts`);
   - lists and runs verification runs, pushing each merge to the Huddle repo's `integration` branch
     (`verification-run.ts`);
   - lists approved branches and pushes the Huddle repo's `approved` branch (`approval-run.ts`);
   - claims the reviews agents submitted with `submit_review`. It fetches each feature's fork,
     runs the [review harness](#side-by-side-runs) on the checkpoint's baseline and the checkpoint,
     then reports the record (`review-run.ts`, [design.md](design.md#reviews-on-the-runner));
   - claims the trials of plan part revisions, builds each part's trial tree and runs the part's
     scopes' tests and the review harness on it ([Part trials](#part-trials));
   - claims the `impact`, `check` and `apply_fix` requests agents made. It fetches the feature's
     fork and the other running features' forks, runs the tool on the checkpoint and reports the
     result (`tool-run.ts`, [Agent tools on the runner](#agent-tools-on-the-runner));
   - claims the writes of approved plan parts of every kind and the module copies, and writes each
     into the affected feature's fork ([Fix writes](#fix-writes));
   - claims the block runs of features that land or whose plan needs checking again, runs the
     checks and reports each one ([Block runs](#block-runs)).

Passing `--combined` or `--repo` is the runner operator's consent to those runs and pushes. The test
jobs loop on their own, so a long test run never holds up the operation pushes. `--once` runs a
single pass of each and exits 1 when anything was refused or failed.

### Failed runs

A pass that stops a run on an error, such as a fetch that failed, reports the run to
`POST /runs/failures` with its kind, its id and the reason (`run-failure.ts`). The kinds are
`combined`, `review`, `tool`, `plan-facts`, `fix-write`, `block` and `part-trial`. Penguin releases
the run at once, so the next claim of any runner takes it without waiting for the lease. A pass that
succeeds sends no failure report, so a run that works costs no extra request.

- Only the runner that holds a run's claim can release it. Penguin refuses a report from any other
  bridge. A facts run is listed to every runner and never claimed, so its report releases nothing
  and only counts the failure.
- A runner that dies without reporting still loses its claim when the lease ends, as before.
- Penguin counts the failures of each run. At `PENGUIN_RUN_FAILURE_LIMIT`, 3 by default, it stops
  handing the run out and routes it to the feature's person with the last reason
  ([design.md](design.md#exceptions)). A stopped block run fails, so a land goes back to building.
- When the failure report itself cannot reach Penguin, the run keeps its claim until the lease ends.

The pass prints what became of each stopped run:

```text
Block run utc-day/2 (land) stopped; Penguin released it for any runner (failure 1 of 3): fetch-pack: protocol error: bad band #78
```

The runner fetches owner forks and feature forks with read tokens. It pushes Huddle repos with write
tokens. The Worker grants a runner bridge `write` on `huddle-<id>` repos and an owner bridge only
`read`. The runner gets `write` on a `feature-<id>` repo only with a claimed fix write, for that one
part, so it pushes no `apply_fix` commit. It reads the `base` repo and never holds `write` on it.

Every Git command against Artifacts, on a runner or an owner's bridge, picks its protocol version
from its subcommand (`artifactsGitOptions` in `git-remote.ts`). Fetch, clone and `ls-remote` run
with `-c protocol.version=2`. A push runs with `-c protocol.version=1`, because Artifacts does not
support protocol v2 for pushes
([Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)). Facts runs and block
runs fetch every running fork into one runner repository. Over protocol v1, Artifacts answers some of
those fetches with `fetch-pack: protocol error: bad band #78`. Over v2 every fetch succeeds (see
[Runner fetch check](#runner-fetch-check)). Each command also clears `credential.helper` and
`core.askPass`. The token reaches Git through the command's environment only.

### Block runs

A feature reaches main as a block ([design.md](design.md#block-promotion-in-the-build)). Each pass
claims the waiting block runs from `POST /blocks/claim` under a 30-minute lease (`block-run.ts`). A
claim names the run, its purpose (`land` or `plan_check`), the feature's fork and checkpoint, main's
head and branch, the targets with each fork's head and the originating identity's charter. The
targets are the running features the change reaches: those that call what it modifies, by the caller
list, with those that change the same files. A claim with no targets is checked on main alone: the
runner fetches only `base` and the feature's fork, merges onto main only and runs no caller replay. The bridge checks each commit is a full object ID and the branch a plain branch name before
it uses them.

For each run the runner fetches `base`, the feature's fork and every target's fork with read tokens.
It runs a combined run with the [block checks](#block-checks): the checkpoint merged onto main and
onto each target, keyed by the target's feature id. The change is the checkpoint against its merge
base with main. Every scope's test command also runs on main's merged tree, because main moves to
exactly that tree. Each failed or erred check gets one decision from the
[resolution ladder](#resolution-ladder), routed by the claim's charter. No fix runs.

The runner reports to `POST /blocks/<feature>/<n>`. The Worker hands the report to the feature's
FeatureAgent, which moves main itself when a land run passed. The answer names the run's new state
and, for a promotion, main's commit before and after. A run whose repos cannot be fetched is
reported as a [failed run](#failed-runs), which frees it for the next claim. A run that cannot be
checked reports an `error` check on main, which never passes.

On the helpful-fix fixture, the block of `owner-priya` with the switch to `start_of_local_day` written
into Jun's and Sam's forks passes every check. All three scopes' tests pass on main's merged tree.
Without the switch, Jun's and Sam's tests fail on their merged trees and each failure carries one next
step (no test yet (docs/testing.md)).

### Preview

`penguin-bridge preview --feature <id> [--commit <sha>] [--dir <path>]` fetches a feature's fork with
the bridge's expiring read token into `<path>`, default `<state-dir>/previews/<id>`. It checks out
`<sha>` or the fork's `main`. An owner uses it to see a block before it reaches main. Artifacts makes
no new repo. Nothing is pushed.

### Block exit check

`tests/e2e/block-landing.test.ts` runs the Phase E exit check against real Artifacts through local
`wrangler dev` under a repo prefix unique to the run. It deletes every repo it made. It needs a
Wrangler login and this repository's `.venv`:

```sh
PENGUIN_BLOCK_E2E=1 node --test tests/e2e/block-landing.test.ts
```

It writes `worker.log`, `runner.log` and `evidence.json` to `PENGUIN_BLOCK_E2E_OUT`, default a
temporary folder. On the helpful-fix fixture, three features open and Priya's plan is approved and
written. Priya's block reaches main, then Jun's and Sam's after a failing land and a race. Every
scope's tests run on main after each promotion.

### Record repo check

`tests/e2e/record-repo.test.ts` proves a feature's signed records reach the record repo against real
Artifacts, through local `wrangler dev` under a repo prefix unique to the run. It deletes every repo it
made. It needs a Wrangler login and this repository's `.venv`:

```sh
PENGUIN_RECORD_E2E=1 node --test tests/e2e/record-repo.test.ts
```

It writes `worker.log` and `evidence.json` to `PENGUIN_RECORD_E2E_OUT`, default a temporary folder. On
the helpful-fix fixture, setup makes `record`. Priya's feature opens and reaches main alone. Priya's
bridge then clones `record` with a read token. Every record the feature page lists is at its path with
the same bytes the page's link answers. Artifacts refuses a push with the read token. The bridge gets no
write token on `record`.

### Expand promotion check

`tests/e2e/expand-promotion.test.ts` proves an expand checkpoint reaches main on its own against real
Artifacts, through local `wrangler dev` under a repo prefix unique to the run. It deletes every repo it
made. It needs a Wrangler login and this repository's `.venv`:

```sh
PENGUIN_EXPAND_E2E=1 node --test tests/e2e/expand-promotion.test.ts
```

It writes `worker.log`, `runner.log` and `evidence.json` with each step's wall time to
`PENGUIN_EXPAND_E2E_OUT`, default a temporary folder. On the helpful-fix fixture, Jun's weekly report
runs while Priya's feature promotes `start_of_local_day` alone and keeps pushing to its fork. A changed
signature of `start_of_day` is refused. An addition to Jun's analytics scope waits for Jun's approval
on the dashboard, then reaches main. Every scope's tests run on main after each promotion.

### Runner fetch check

`tests/e2e/runner-fetch.test.ts` fetches many forks from real Artifacts into one runner repository.
It runs the Worker under local `wrangler dev` with every repo under a prefix unique to the run.
Project setup forks `PENGUIN_FETCH_E2E_FORKS` owner repos, default 20, from a base repo that holds
the money-minor-units fixture's main. The test pushes one of the fixture's feature branches to each
fork. The runner then fetches the base repo and every fork with read tokens through
`fetchRepoBranches`. It fetches them all a second time, as its next pass does. The test prints the
time of each fetch and deletes every repo it made. It needs a Wrangler login and this repository's
`.venv`:

```sh
PENGUIN_FETCH_E2E=1 node --test tests/e2e/runner-fetch.test.ts
```

In two runs on 20 forks over protocol v2, every fetch succeeded. The first pass over the base repo and
20 forks took 17.6 s and 19.2 s. The second pass took 7.9 s and 11.7 s. The same fetches over protocol
v1 failed for 7 of the 20 forks with `bad band #78`, on both passes.

### Fix writes

Once an author approves a part of a merge plan, its fix becomes one commit on the affected feature's
fork ([design.md](design.md#steps-1-and-3-in-the-build)). The check runner writes it, whatever the
part's kind (#207). No agent writes code in another person's fork. The commit holds the part's
approved patch: the plan's rules rewrite a mechanical part's call sites, and a behavioural part's patch
is the one its author approved. The same commit copies the originating change's modules the fork
imports. The receiving feature's agent only approves; `get_work` tells it that Penguin writes the
fix. The writers all use the same code (`fix-write.ts`):

- Runner mode claims every write at `POST /fix-writes/claim` under a 10-minute lease: each approved
  part's own write, and the copy writes a land asks for, a spec with an empty patch whose `copy`
  names the originating change's current revision
  ([design.md](design.md#steps-1-and-3-in-the-build)). One claim loop serves both. Each claimed write
  carries a `write` token minted for that part on the named fork alone. A write into a fork whose
  caller items wait on the receiving side stays queued; a land refused as `copy_not_written` names
  that wait.
- A write Penguin opened for an agent before #207 is still the agent's. The originating agent pipes
  the answer of the `fix_token` MCP tool to `penguin-bridge fix-write`, which fetches the fork into
  `<state-dir>/fix-writes`, or `--repo <path>`, writes the fix and prints the commit as JSON for
  `report_fix_write`. Or the affected feature's builder takes the part's fix task
  ([Edit tasks](#edit-tasks)), and the person's bridge commits the approved patch with no agent run
  (`edit-run.ts`). `fix_token` refuses every other part as `forbidden`.

An approved rule-written part of a split's migration plan comes through the same claim, onto its
running feature's fork or its plan's block feature
([design.md](design.md#migration-plans-in-the-build)). A fork whose start waits on an overlap lock is
left out of the claim. The runner writes each fix and reports the commit to
`POST /fix-writes/<write id>`, as `report_fix_write` does for an agent. A write that stops is reported
as a [failed run](#failed-runs). Penguin queues it again. The next claim prepares it with a new
token.

The writer fetches the fork's `main` and stops with `moved` when its head is not the granted parent.
It reads each file the patch writes at the parent and applies the patch with `applyPatchFile`
(`packages/protocol`), the function Penguin checks the commit with. Every hunk must match at its line.
The writer stores each new file as a blob in a scratch index over the parent's tree. A write whose
spec names a `copy` then sets each copied module to its blob and mode at the originating revision,
byte for byte (`copiedTree`). The writer first lists the originating change's own files with
`git diff-tree` from the change's baseline to the revision. It refuses a copy of any other file and
a revision its repository does not hold. Runner mode fetches the originating fork before such a
write. The writer refuses when the tree changes anything but the patch's files and the copies. It commits with Penguin's message as author
`Penguin` with no hook or signing. It pushes the commit to `main` with no force. The token reaches
Git only in the push's environment. A fork whose head moved refuses the push; asking `fix_token`
again rebases the write or sends the part back for revision.

Building and pushing one fix commit took about 200 ms against a bare fork on local disk. Against
Artifacts through local `wrangler dev` it took about 1 second; `fix_token` and `report_fix_write`
took about 2 seconds each, most of it Artifacts reads.

### Plan facts runs

A merge plan needs facts that only running the code can give ([design.md](design.md#steps-1-to-5-in-the-build)).
Penguin schedules one facts run per feature checkpoint when the checkpoint is reported: its impact
report holds the contract diff Penguin sorts ([design.md](design.md#sorting-and-splitting-in-the-build)).
`propose_plan` reuses that run, or schedules one of its own when it declares rewrite rules. Penguin
sorts the run's report as the runner reports it. `GET /plan-facts` lists each pending
run. The listing names the originating fork, the checkpoint, its baseline on main and the targets.
`main` is one target, at the baseline. Each running feature that may read the change is another, at
its latest checkpoint, keyed by its feature id and naming its person. Every target lists `test:<scope>` command IDs only. For each run the runner:

1. refuses a listing that names a repo other than a `feature-<id>` fork or a commit that is not a
   full SHA, then fetches each fork it names;
2. runs `analysis:python-impact` on the baseline and the checkpoint, with one fork per running
   feature. Each fork names the baseline as `since`, so the analysis lists only the uses in files the
   feature added or changed since its merge base with the baseline. A use in a file the feature
   carries unchanged from main is main's caller. The report counts those as `carried` and leaves
   them out of the fork's uses. When the listing carries `retiring`, the contracts an expand written
   first declares, the same analysis searches for them as if they had changed (`symbols`), so the
   report lists their callers too. The runner refuses a listing whose `retiring` names anything but
   `path::name` contracts in Python files, or more than 64. Those uses choose no target in step 4:
   they are callers of the old shape, which the expand leaves working;
3. merges the checkpoint onto each target with `git merge-tree --write-tree`;
4. runs each listed test command on the merged commit in a throwaway worktree. A running feature
   whose own changes the impact graph shows make no use of the change gets `not-affected` without a
   run;
5. states each failing test as a break: its docstring at the merged commit (`test-evidence.ts`)
   with the assertion line and first error line pytest printed for it. On a running feature a
   failing test is a break when its file is one the feature added or changed since its merge base,
   the one the impact report gives, or when its traceback passes through a file holding one of the
   feature's own callers. Any other failing test sits in a file the feature carries unchanged from
   main. It is main's break, listed on main's part. The result counts those as `carried`. The
   changed files come from one local `git diff` of the merge base and the feature's commit, with no
   fetch. When a running feature's command still has a failing test, the runner runs the same
   command on the feature's fork head without the change. A test that fails there too is the
   fork's own failure: it is not a break and the report leaves it out (`withoutForkFailures`). On
   Larder, `japan-launch` fails its yen test on its own head, so case 2's change is not charged
   with it;
6. applies the plan's rewrite rules when the listing carries them
   ([design.md](design.md#steps-1-to-5-in-the-build)). In each listed place the runner runs the
   codemod with the rules in a throwaway worktree, then `ruff check --fix` and `ruff format` on the
   files the rules changed (`FixApplier.rewrite`). Main's place covers every Python file under the
   dependent scopes' paths at the baseline. A running feature's place covers the files it added or
   changed since its merge base with the baseline. The report lists each changed file's blob before
   and after, with each rule the codemod refused and the reason. Nothing is committed.

The report carries the impact report and each command's result with its fingerprint and breaks. It
carries no log. `PLAN_FACTS_REPORT_SCHEMA` (`packages/protocol`) caps each docstring at 500
characters and each assertion or error line at 300. A newer checkpoint of the feature supersedes a
pending run. A report of a superseded run answers 409.

On the helpful-fix fixture the facts run of Priya's checkpoint against Jun's and Sam's checkpoints
takes between 1 and 3 seconds of wall time on an Apple silicon laptop, analysis and three merged trees included.

### Part trials

Each revision of a merge plan's part is tested on the tree it would reach main as
([design.md](design.md#part-trials)). Each pass claims the waiting trials from
`POST /part-trials/claim` under a 30-minute lease. A claimed trial names the originating fork and the
plan's checkpoint, the target (main at the plan's baseline, or the affected feature's fork head), the
part's fix (a commit in the originating fork with its base, or a patch), `test:<scope>` command IDs,
the forms to review and, for a rule-written migration part, the scopes in `sideBySide` whose
side-by-side run goes ahead with no form. For each trial the runner (`part-trial-run.ts`):

1. refuses a claim that names a repo other than `base` or a `feature-<id>` fork, a commit that is not
   a full SHA or a command that is not a test command, then fetches each repo it names;
2. builds the trial tree without a checkout (`trial-tree.ts`): the patch applied to the fork head,
   the checkpoint merged in with `git merge-tree --write-tree`. A fix commit is applied on top with
   `git merge-tree --merge-base`. A step that does not apply reports a conflict and runs nothing;
3. runs each test command on the tree in a throwaway worktree;
4. runs the [review harness](#side-by-side-runs) for each form with the target as base and the tree
   as fork;
5. runs the [side-by-side run](#side-by-side-runs) alone for each scope in `sideBySide`, with the
   same base and fork, over the examples the scope declares. A runner built without it refuses such
   a trial.

The runner reports to `POST /part-trials/<id>`. A trial whose repos cannot be fetched is reported
as a [failed run](#failed-runs). A report of a trial a newer one replaced answers `superseded`.

## Allowlisted commands

Penguin names a test only by command id, `test:<scope id>`. The bridge resolves the id to the
scope's `test_command` in `penguin/scopes.json` as committed at the pinned commit, read with
`git cat-file`, so an uncommitted or later edit cannot change what runs. An id with no scope there is
refused and never runs (`command-allowlist.ts`).

Each run happens in a throwaway detached worktree at the pinned commit, in a temporary directory,
removed afterwards; the owner's own worktrees are never read from or written to (`test-runner.ts`).
The test runner asks for consent before it creates each worktree. In runner mode, `--combined` or
`--repo` is that consent.

The command's environment leaves out every `PENGUIN_*` and `ARTIFACTS_*` variable and
`CLOUDFLARE_API_TOKEN`, so no Penguin, Artifacts or Cloudflare credential reaches a command the
repository defines.

### Impact analysis

The bridge also ships Penguin's own analysis commands. An analysis ID such as
`analysis:python-impact` resolves to a script in `services/local-bridge/analysis/`, never to text
from the repository. Any other `analysis:` ID is refused (`command-allowlist.ts`). The runner
starts the script as `python3 -I python_impact.py --repo <path>` with an argument vector and no
shell, in the scrubbed environment described above (`impact-analysis.ts`). Isolated mode keeps the
working directory and `PYTHON*` variables out of the interpreter's import path. The request goes in
on standard input as JSON: the base and head commits plus each fork's id, commit and scopes. A fork
may also name `since`, a commit on main. The script then looks up the fork's merge base with it
(`git merge-base`, one call per fork) and lists the merge base's paths with `git ls-tree`. It reports
the fork's uses and unreadable files only in paths the fork added or changed since that merge base.
The fork's entry in the report repeats `since` and adds `mergeBase` and `carried`, the number of uses
left out. When the two histories never meet, `mergeBase` is null and every file counts as the fork's
own. A request may also list `symbols`, up to 64 contracts as `path::name`. The script searches for
each one as if it had changed, so a request whose base equals its head reports only their uses.
Penguin uses it for retiring symbols ([design.md](design.md#steps-1-to-5-in-the-build)). A request
with `edges: true` also gets `scopeEdges`: for each pair of scopes, the import, call and reference
sites the consumer scope's files at head hold into the provider scope's modules and definitions. An
edge names two scope ids and three counts, no path or symbol. A request with `calls: true` gives each
fork `calls`: every module and definition of its tree its own files use, defined outside them, as
dotted names, and every file or folder of its tree, outside those files, that a string constant in
them names, as `path:<repo path>`. A string names a path from the repository root or from its own
file's folder, so `open("examples/closures.json")` lists `path:examples/closures.json`. The candidate
must be a safe repository path and is only looked up among the tree's paths from `git ls-tree`;
nothing is read for it. The report then also carries `removedPaths`: each file the change renames,
moves or deletes, each folder it removes and each folder that loses an entry. Penguin keeps the names
as the caller list ([design.md](design.md#caller-list)). A rename or
move whose old name still reaches the very definition it moved to, through `old = new` in the module
or class or through an import of the new definition into the old module, is reported with `kept:
true`. The old name's callers are still listed. The report comes back on standard output and is checked against `IMPACT_REPORT_SCHEMA` in
`packages/protocol` before anything reads it. [design.md](design.md#impact-graph-and-contract-diff-for-python)
lists what the report holds.

The script reads only Git objects. It never checks out a tree or imports the code it reads.

| Input | Handling |
|---|---|
| Paths | Taken from `git ls-tree`. A path that is absolute, not normalised or leaves the repository is refused. Symlinks and submodules are skipped |
| File over 1,000,000 bytes | Not read; reported as `too-large` |
| Bytes that are not UTF-8 | Reported as `not-utf8` |
| Syntax error or null byte | Reported as `syntax` with the line |
| Nesting past the parser's limit or past 100 syntax tree levels | Reported as `too-deep` |
| More than 50,000 Python files in one commit | The rest are not read; reported as `too-many-files` |
| A list past 2,000 entries | Cut; the report sets `truncated` and counts as incomplete |
| Missing commit or malformed request | Exit status 2 with one line on standard error. In a `--batch` run, that request's place holds `{"error": message}` and the others are reported |

A combined run (`CombinedRunner`) takes its targets as forks, each with an id, a person and a
checkpoint. A running feature's fork is a target keyed by its feature id, so one person's two
features are two targets. An owner fork is a target keyed by its owner's id. A target is tested in
the scopes it names, or in its person's dependent scopes when it names none. A named scope need not
depend on a changed one: a scheduled run whose target the caller list picked names the scopes its
feature touches ([design.md](design.md#caller-list)). A dependent
scope that no target covers gets a `no-checkpoint` result, unless its DRI is the person who made
the checkpoint, named as the request's `changer`. The checkpoint already holds that scope's code,
so its tests run on the checkpoint itself, with no merge, and report `passed` or `failed` with the
checkpoint as both `ownerCheckpoint` and `mergedCommit`. The result's target is the changer's id.
Another person's fork that covers the scope is tested as well; only a fork of the changer's own
replaces the run on the checkpoint. That checkpoint is no fork target of the block checks. The
scheduled combined runs and the agent `check` tool both name the changer: a scheduled run names
the trigger's person, and `check` names the feature's person, which the tool claim carries as
`person`. On the helpful-fix fixture Priya is DRI for both `ingestion` and `shared-dates`, and
`ingestion` reads `shared-dates`, so a change of hers to `shared-dates` runs the `ingestion` tests
on her checkpoint. Given an
analyzer, the run analyses first, with one fork per target that covers a dependent scope. It merges
every target's checkpoint, then runs tests only for the targets the report selects. Each skipped
scope gets a `not-affected` result with its target's checkpoint and is listed under `notAffected`
in the run's report. Penguin accepts a `not-affected` result as the end of that target's claimed
run (`combined-run-schedule.ts`), so the run is never claimed again. A merge conflict outranks the
impact graph: an unaffected target whose merge conflicts gets `conflict`. A failed analysis is recorded as `impactError`. Every dependent scope's
tests then run. Runner mode passes the analyzer to every combined run.

To see the report for any two commits:

```sh
penguin-bridge impact --repo <path> --base main --head owner-priya-checkpoint \
  --fork jun=owner-jun-checkpoint:analytics --fork sam=owner-sam-checkpoint:messaging [--json]
```

The text form lists each finding with its file and line, then each fork's uses and whether its
tests run. `--json` prints the full report. `--python <path>` names another interpreter.

On a test repository of 1,000 modules with 50 changed, the analysis of base, head and three forks
takes about 1.8 seconds on an Apple silicon laptop. 5,000 modules take about 9.8 seconds.

### Side-by-side runs

`analysis:side-by-side` runs a scope's public functions on main and on a fork for the review
harness ([design.md](design.md#review-harness)). The ID resolves to
`services/local-bridge/analysis/side_by_side.py`, the bridge's own script (`command-allowlist.ts`).
For each side the runner adds a throwaway detached worktree at the commit. It starts
`python3 -I side_by_side.py --tree <worktree>` with an argument vector and no shell
(`side-by-side.ts`). The environment is the scrubbed one above, plus `PYTHONDONTWRITEBYTECODE=1`
and `PYTHONHASHSEED=0`. Each side stops after 5 minutes. The runner reads at most 16 MiB of its
report. The worktree is removed afterwards.

The request goes in on standard input as JSON: the declared contracts and one call per input, each
a contract and keyword arguments. The script checks every call against the function's signature
before any call runs. A call that does not fit comes back `invalid` with the reason. The script then
imports the tree's code and runs each remaining call. It reports the returned value as canonical
JSON, or the exception raised, with the call's time. Anything the tree's code prints goes to
standard error, so only the report reaches standard output.

| Input | Handling |
|---|---|
| `str`, `int`, `float`, `bool`, `None`, `Literal` | The same JSON value; a bool is no int |
| Lists, tuples, sets, iterables, sequences | A JSON array, each item built by its own annotation |
| Dicts and mappings | A JSON object with string keys |
| Dataclasses and enums | An object of the dataclass's fields; an enum's value |
| Unions and `X \| None` | Each member tried in turn |
| `Any`, `object` or no annotation | The JSON value as it is |
| Any other type | Only `{"$call": "<contract>", "args": {...}}`, which calls a contract declared in `penguin/scopes.json`. A declared class covers its methods, such as `IdentityMap.from_events` |
| A contract no scope declares | `invalid`; nothing is imported for it |

A review on the runner runs the whole harness (`review-harness.ts`): it checks the form, makes the
contract diff for the stored data rule, keeping the changed stored shapes the reviewing scope reads
with the scope that owns each one. It then runs both sides. The form needs a marker only for a shape
its own scope owns ([design.md](design.md#review-harness)).

```sh
penguin-bridge review --repo <path> --base main --fork <commit> --scope analytics \
  --form form.json [--out review.json] [--json] [--no-diff]
```

The text form prints the verdict with each refusal, the changed stored shapes the scope reads, the
exceptions for the scope's owner and each input that differs, with both outcomes. `--out` writes the
full record as JSON. `--no-diff` leaves out the contract diff. The command exits 0 when the form is
accepted and 1 when it is refused. Runner mode runs the same harness on every submitted review
without this command. It reports the record the `--out` file would hold.

On the identity-unification fixture one side of a run of two recorded examples takes about 110 ms
of wall time on an Apple silicon laptop, worktree included. The two calls take under 1.5 ms together.

### Block checks

Runner mode runs the checks of [design.md](design.md#checks) on every merged tree of each combined
run (`block-checks.ts`). The targets are `main`, which is the checkpoint merged onto main's commit,
plus every listed fork's checkpoint merged with the trigger, one target per running feature. A fork
that covers no dependent scope still gets the overlap, merge, lint, format and dependency checks.
Its type check reports `not-affected`. Each check names a command ID that
maps to a fixed program in the bridge. No program or argument comes from the repository.

| Check | Command ID | What runs | Fails when |
|---|---|---|---|
| Overlap | `git:diff-hunks` | `git diff -U0` from the merge base to each side, per file both sides change to different blobs, with `--literal-pathspecs`. `git ls-tree` reads each side's blob; a file both sides hold at the same bytes, such as a module Penguin copied into the fork, is not counted | Both sides change the same hunk of one file |
| Merge | `git:merge-tree` | `git merge-tree --write-tree` | A path conflicts. Lint, format, type check and tests then report `not-run` |
| Dependency diff | `analysis:python-dependencies` | `python3 -I python_dependencies.py`, reading Git objects only | Never. It names each changed library and each place the target's scopes import it. It gives `error` when the analysis cannot run |
| Lint | `check:ruff-lint` | `ruff check --output-format json` on the Python files the merge changes | The merged tree has a finding the target's own tree lacks |
| Format | `check:ruff-format` | `ruff format --check` on the same files | A file would be reformatted that the target's own tree leaves alone |
| Type check | `check:pyright` | pyright 1.1.414 with `--outputjson` on the whole merged tree | The merged tree has an error the target's own tree lacks |
| Tests | `test:<scope id>` | The scope's test command (`test-runner.ts`) | The command exits other than 0. On a running feature's fork, only a failing test the fork head does not already fail on its own counts |

On a running feature's fork, a tests check whose command fails runs the same command again on the
fork head without the change (`discountForkFailures` in `combined-run.ts`). A test that fails there
too is the fork's own failure, not the block's: it leaves the check's findings, and a check left with
no failing test passes, its summary naming how many fail on the fork alone. Main's tests count in
full. On Larder, `japan-launch` fails its yen test on its own head, so cases 2 and 3 land past it.

Lint, format and the type check run twice: once in a throwaway worktree of the merged commit, once
in one of the target's own commit. A finding counts when the merged tree has it and the target's
tree does not. The match uses the file, the rule and the message, without the line, since the merge
can move lines. On identity unification Sam's checkpoint already has one pyright error in
`messaging/audience.py`. The merged tree has it too, so the check passes with "no new type errors
(1 already on sam)".

ruff uses the repository's own settings when the merged tree's root holds `ruff.toml`, `.ruff.toml`
or a `pyproject.toml` with a `[tool.ruff]` table. Otherwise it runs with `--isolated`, so a
configuration file in the runner's home directory never changes a result. File paths go to ruff
after `--`, so a file named `-x.py` is read as a path. pyright comes from the `pyright` package that
`npm install` puts beside the bridge. It resolves imports against one interpreter's installed
packages, passed as `--pythonpath`: `--python <path>` when the command or the runner names one, then
`PENGUIN_PYTHON`, then this repository's uv environment, `.venv/bin/python`. Only when none exists
does pyright search the host itself. A host's own Python decides the result otherwise: on a machine
whose Python lacks pytest, every test file's `import pytest` is an error that a machine with pytest
installed never reports. The type check's kept log starts with `python: <path>`, the interpreter it
used.

The type check and the tests run only for targets the impact graph selects. Every other target gets
`not-affected` for both. Each tool runs with an argument vector, no shell, the scrubbed environment
above and its own process group. A tool still running after 10 minutes is stopped with its group.
A test command still running after 30 minutes is stopped the same way. A tool that cannot start, or
whose output does not parse, gives the result `error`.

Each check is a `BlockCheck` record (`packages/protocol/src/block-check.ts`) with these fields:

| Field | Holds |
|---|---|
| `planId` | The merge plan, or null for a combined run |
| `target`, `check`, `result` | `main`, the feature id or the owner fork's owner, the check and `passed`, `failed`, `not-affected`, `not-run` or `error` |
| `tool` | The program's name, the version it reports and the command ID |
| `input` | The trigger checkpoint, the target's commit, the merged commit and the files read |
| `findings`, `findingCount` | The first 20 findings with file, line, rule and message; the total count |
| `summary` | One line that says what the check found |
| `fingerprint` | The merged commit, its lockfile hash and the command ID, hashed |
| `logRef` | `sha256:` of the tool's raw output, which stays on the runner |
| `durationMs` | Wall time of the check on both trees |

The checks go to Penguin in the combined-run report's `checks` field. Penguin validates each record
against `BLOCK_CHECK_SCHEMA` and keeps it in the ProjectAgent's `BlockCheck` table by trigger,
target and check. A later report of the same check on the same target commit replaces the row. Raw
output never leaves the runner.

To run the checks on local commits:

```sh
penguin-bridge check --repo <path> --base main --head owner-priya-checkpoint \
  --checkpoint jun=owner-jun-checkpoint --checkpoint sam=owner-sam-checkpoint \
  [--main <commit>] [--python <path>] [--ruff <path>] [--yes] [--json]
```

`--checkpoint <owner>=<commit>` names an owner fork. `--checkpoint <person>/<feature>=<commit>` names
one of a person's features, a target of its own: `--checkpoint jun/weekly-report=<commit>
--checkpoint jun/cohort-ltv=<commit>` checks two merged trees for Jun. `resolve` takes the same
forms.

The command asks before each test run unless `--yes`. It exits 1 when any check fails or errs. On
the dependency bump it prints, for Ana's checkpoint without Ana's fix. The dependency diff passes
with the places Ana imports the client. The one failure is Ana's payment test:

```text
4a56f11d9f6c onto ana@e6994519dd70 (merged dad2a2dfc816)
  overlap passed: no file changed in both [git diff, git:diff-hunks, 35 ms]
  merge passed: merges cleanly [git merge-tree, git:merge-tree, 26 ms]
  dependencies passed: shared.http changed version; ana imports it in 4 places [python-dependencies, analysis:python-dependencies, 262 ms]
    shared/http.py vendored shared.http 1.4.0 -> 2.0.0, from vendor.wire_v1 to vendor.wire_v2
    payments/tests/charge_replay.py:6 imports shared.http (shared.http)
    payments/tests/fake_processor.py:3 imports shared.http (shared.http)
    payments/tests/test_webhooks.py:4 imports shared.http (shared.http)
    payments/webhooks.py:4 imports shared.http (shared.http)
  lint passed: no new lint findings [ruff 0.17.0, check:ruff-lint, 24 ms]
  format passed: no new files to reformat [ruff 0.17.0, check:ruff-format, 26 ms]
  typecheck passed: no new type errors [pyright 1.1.414, check:pyright, 2115 ms]
  tests failed: 1 failing test; the command exited with 1 [test, test:payments, 367 ms]
    payments/tests/test_webhooks.py fails: test_timed_out_charge_is_charged_once
```

On the three fixtures one combined run with every check takes 4 to 9 seconds on an Apple silicon
laptop. pyright takes about 1 to 2.5 seconds of each target.

### Caller replay

The caller replay tells the originating agent and each running feature's owner how a change moves
the calls the feature's code makes into the functions the change modifies
([design.md](design.md#caller-replay)). Every combined run with an impact graph runs it, so a `check`
request and a block run carry it (`combined-run.ts`, `caller-replay.ts`). `callerReplay: false` on
the `CombinedRunner` turns it off.

1. `replaySymbols` takes the impact report's modified, removed, renamed and moved functions and
   methods: at most 64, each with the module it imports as and the contract it belongs to. A `check`
   claim also carries `held`: the functions the feature's unsettled caller items name
   (`heldReplay` in `services/project-agent/src/caller-items.ts`, #193). `withHeld` adds them, so a
   revision that restores a function to main's bytes still replays its callers and shows them
   `unaffected` instead of withdrawing their items. The forks those items name run their tests even
   when the impact graph no longer selects them.
2. On each running feature whose tests the impact graph selects, the scope's test command runs on the
   merged commit with the replay's pytest plugin loaded. The same command then runs once on the
   fork head with the plugin. That second run also finds the tests the fork fails alone, so the
   replay adds one run of each affected scope's tests.
3. The plugin is `services/local-bridge/analysis/replay/penguin_caller_replay.py`, the bridge's own
   module under the command ID `analysis:caller-replay` (`command-allowlist.ts`). The test runner
   puts its folder first on `PYTHONPATH`, adds `-p penguin_caller_replay` to `PYTEST_ADDOPTS` and
   names a spec file and a recording file in `PENGUIN_CALLER_REPLAY_SPEC` and
   `PENGUIN_CALLER_REPLAY_OUT`. Both files sit beside the throwaway worktree, never in it. Only the
   Python standard library runs in the plugin.
4. `replayTarget` pairs the two recordings and gives each caller its verdict.

Before any test module is collected, the plugin wraps each named function where it is defined and
where the named module re-exports it. Each wrapped call records:

| Field | Holds |
|---|---|
| `test` | The pytest node id of the test that made the call |
| `frames` | The tree's own frames that led to the call, innermost first, at most 24 |
| `args` | The arguments by parameter name, `self` included, encoded before the call runs |
| `outcome` | The returned value, or the exception's type and message |
| `effects` | Each request object handed to a transport (an object with string `method` and `url`, the shape of `vendor/wire_v1` and `wire_v2`'s `Request`), each `http.client` request (which `urllib` uses), each socket connect or send, each file opened for writing, moved or removed. When the call ends, each written file's size and SHA-256. At most 32 |
| `approximate` | True when some value is a `repr` |

Every value is canonical JSON: sorted keys and sets, dataclasses and objects by their fields with
the type named, bytes as their length and SHA-256, memory addresses removed. An object with no
fields to read, such as a lock, is kept as its `repr` and marks the call approximate. A value over
2,048 characters of JSON is kept as its SHA-256, its length and a 200-character preview, so two
long values still compare exactly. Each field of an effect is capped at 600 characters. The plugin
keeps 5,000 calls a run and counts the rest. The bridge parses the recording as JSON, compares
values as canonical text and never evaluates one. The plugin also records each test's outcome:
`passed`, `failed` for a failed assertion, or `error` for any other exception or a failure to set
up or collect.

A call's caller is its innermost frame in one of the feature's dependent scopes, outside test code
(a `tests` or `test` folder, `test_*.py`, `*_test.py` or `conftest.py`) and outside the files the
change itself changed. A call made through a helper of the change belongs to the feature's line that
called the helper: with Penguin's update in case 3, `payouts/send.py:18` calls `post_once()`, which
calls `Client.post`. Calls are paired by test, function, caller and order within the test.

| Verdict | When |
|---|---|
| `broken` | A call raises on the merged tree where it returned, or raises another exception type. A test that made a call dies on the merged tree with an `error` before making it. Every call matches yet a test that reached the caller passes on the fork head and fails on the merged tree |
| `differs` | A call's result, exception message or effects differ, or a call happens on one tree only |
| `unaffected` | Every call through the caller matches |
| `unknown_reach` | The impact graph shows a call to a changed function at that line, but no test of the feature reaches it. Every such line gets it when the test command wrote no recording, such as a command that is not pytest |

`broken` comes first, then `differs`. A failing test the calls explain stays `differs`: on case 3's
upgrade alone `test_timed_out_payout_is_paid_once` fails because the second payout went out, which
is the difference the replay shows.

The section (`CallerReplaySection`, `packages/protocol/src/caller-replay.ts`) holds one run per
feature and one verdict per caller. A run names its id, the feature, the originating checkpoint, the
fork head, the merged commit, the scopes, the wrapped functions, the functions a side could not wrap,
each side's test tally and recorded calls. It also names the extra run's time. A caller names the feature,
the contract, the file and line, the verdict with its reason, the run id, the call counts, the tests
that reached it and the first 5 differing calls. Each differing call has a call id and both sides:
status, arguments, value or exception and the first 8 effects, each with a one-line summary. A
section over 256 KiB of JSON drops the differing calls' arguments, then all but one differing call
per caller, then the rest; `trimmed` says so and every count stays.

A run id is `replay-` and 20 hexadecimal digits of the SHA-256 of the checkpoint, the feature, the
fork head, the merged commit and the wrapped functions. A call id is `call-` and 20 digits of the
SHA-256 of the feature, the contract, the caller's file and line, the test, the function and the
call's order. The same trees give the same ids. A call keeps its id when a revised change is
replayed again. `replayRun` and `replayCall` look them up.

Penguin checks a reported section with `parseCallerReplay`: its shape and size, every recorded
value's size, each caller naming a run of the section for its own feature, call ids unique within a
run and each verdict agreeing with its calls. A block report's runs must start from the run's
checkpoint and replay only the forks the run named at the heads it named. The ProjectAgent keeps the
section in the `BlockRun` row (`BlockStore.callerReplay`). The signed `block_checked` record carries
`caller_replay`: each run's id and commits, then each caller's verdict with the ids of its differing
calls. A `check` result carries the section in `callerReplay`. `penguin-bridge check` prints it after
the block checks:

```text
instant-payouts replay-650b3ccd297432b12a35 (payouts): 4 and 4 calls recorded, 5/4 passed on the fork head/merged tree
  payouts/send.py:18 shared/platform/http.py::Client differs: 1 of 2 calls differ: result, exception, effects
    call-dcb27a7e9856d4d2d1d6 payouts/tests/test_send.py::test_timed_out_payout_is_paid_once: raised Timeout, 1 effects -> returned {"$type":"Response","json":{"id":"mv_2"},"status":200}, 2 effects
```

On the Larder seed on gn100 the extra run on a fork head takes 130 to 182 ms per feature. Case 1's
`check` replays nine features in 1,389 ms in all, `cohort-ltv` 182 ms of it. Case 3's replays four
in 578 ms in all: `instant-payouts` 141 ms, `tip-jar` 150 ms.

### Resolution ladder

The runner routes each failed or erred block check through the resolution ladder of
[design.md](design.md#routing-and-the-resolution-ladder) (`resolution.ts`). For steps 1 to 3 it
applies Penguin's own fix and runs the combined run again on the fixed commits. Steps 4 to 6 go to
an agent or a person with the failing check attached. No step calls a model or an agent.

Each fix is a fixed program with an argument vector and no shell, in a throwaway worktree of the
commit it starts from, with the scrubbed environment above (`apply-fix.ts`):

| Fix | Command ID | What runs |
|---|---|---|
| Format | `fix:ruff-format` | `ruff format` on the named files, with the repository's ruff settings or `--isolated` |
| Lint autofix | `fix:ruff-autofix` | `ruff check --fix` on the named files |
| Lockfile | `fix:uv-lock` | `uv lock` in the directory of each `uv.lock`, after merging the other side when the lockfile conflicts |
| Codemod | `fix:python-codemod` | `python3 -I python_codemod.py --tree <worktree>`, the bridge's own script, with the edits on standard input |

The codemod script uses libcst 1.9.0 (T21). A `rename` or `move` edit rewrites every import and
reference of one dotted name to another with libcst's `RenameCommand`. A `rename-parameter` edit
rewrites one keyword in each call that resolves to the function. Given a plan's rewrite rules in
place of edits, the script compiles each rule into LibCST matchers. A name in the contract's module
matches however the file imports it, through `QualifiedNameProvider`. A method a pattern calls
through the contract class, such as `Client.post($client, "/v1/payouts", $body)`, also matches
`client.post("/v1/payouts", body)` when `ScopeProvider` shows `client` bound only as a parameter
annotated with the class. Each placeholder captures one
expression, parenthesised where the replacement needs it. After the rewrite the script removes each
import of the contract's module that the file no longer uses and adds each import a replacement
declares. The script parses the code and never imports or runs it. The runner starts it with the interpreter of this repository's uv
environment, `.venv/bin/python`, which has the pinned libcst. `PENGUIN_CODEMOD_PYTHON` or
`--codemod-python` names another.

A fix may change only the files it names, inside the allowed paths. For the originating checkpoint
those are its identity's charter: the charter scopes' paths and its charter paths, from
`penguin/identities.json`. For an owner's fork they are the paths of the owner's scopes. A lockfile
fix may change only `uv.lock` files. Its merge may conflict only there. A named file that is a
symlink or lies under a symlinked directory is refused before the program runs. A program that
changes any other file is refused and nothing is committed. A fix that changes files becomes one
commit by `Penguin <penguin@penguin.invalid>` on top of the commit it started from, with a
`Penguin-Fix: <command ID>` trailer. The ref `refs/penguin/fixes/<commit>` keeps it from garbage
collection.

The runner chooses where each fix goes:

| Failure | Fix goes into |
|---|---|
| Format or lint finding | The side that changed the file: the originating checkpoint, or the owner's fork |
| Renamed, moved or re-keyworded symbol an owner's fork uses | That owner's fork, on the files the contract diff lists |
| The same on `main` | The originating checkpoint, on the head tree's own callers |
| Lockfile conflict | The owner's fork, as a merge of the originating checkpoint; for `main`, the originating checkpoint as a merge of main |

The next round runs every check again. An owner's fork that a fix changed runs its tests and type
check whatever the impact graph says: after a codemod the fork uses the new name, which the graph no
longer counts as a use of the change. A fix counts as `accepted` once the next round no longer shows
its failure. One that did not clear its failure, or was refused, sends that failure up the ladder as
a behaviour change. Past the round limit (default 3, `--round-limit`) the failure goes to the
originating feature's person.

Every tool run and every decision is recorded: the tool, its caller, its command ID, its input, what
it found or changed with the commit before and after. It also holds the run's time. The record counts the
failures Penguin's fixes resolved, those routed to agents or people and the agent calls made, which
is zero for the ladder itself.

```sh
penguin-bridge resolve --repo <path> --base main --head <commit> --identity @<owner>/<name> \
  --checkpoint jun=<commit> --checkpoint sam=<commit> [--main <commit>] [--round-limit <n>] \
  [--python <path>] [--ruff <path>] [--uv <path>] [--codemod-python <path>] [--yes] [--write] [--json]
penguin-bridge apply-fix --repo <path> --kind codemod --commit <commit> --path analytics/weekly.py \
  --allow analytics --rename shared.dates.start_of_day=shared.dates.start_of_local_day [--json]
```

`resolve` exits 0 when no failure is left and 1 when one is routed to an agent or a person.
`--write` moves each branch that `--head` or `--checkpoint` names to its fixed commit, guarded by its
old value. On the helpful-fix fixture with Priya's head renaming `start_of_day` to
`start_of_local_day` in `shared/dates.py` and in Priya's own callers, it prints:

```text
round 1: 20 checks, 4 failing, on ebe750fadc97
  jun typecheck: step 3 rename -> penguin penguin [fix:python-codemod], accepted
    the contract diff shows shared.dates.start_of_day renamed to shared.dates.start_of_local_day, used in 1 file(s) of jun
  ...
  apply_fix-1 apply_fix fix:python-codemod by penguin: changed, codemod: changed 1 file fe97662fb615 -> c7c5d1ea71d9 [974 ms]
    changed analytics/weekly.py
  apply_fix-2 apply_fix fix:python-codemod by penguin: changed, codemod: changed 1 file 4c6e86d6772d -> a10602b89f26 [1136 ms]
    changed messaging/reminders.py
round 2: 20 checks, 0 failing, on ebe750fadc97
4 failures resolved by Penguin's fixes, 0 routed to agents, 0 to people; 0 agent calls; 2 rounds in 17544 ms.
```

On the fixture's own trigger, `owner-priya-checkpoint`, Jun's and Sam's failing tests go to step 5,
to the stewards `@jun/steward` and `@sam/steward`, because the failing files lie outside `@priya/utc-day-start`'s
charter. With an unused import added to Priya's `shared/dates.py`, lint fails on every target. The
failure goes to step 1. One `fix:ruff-autofix` commit on Priya's checkpoint clears it on all
three. On an Apple silicon laptop one codemod run takes about 1 second, most of it libcst's import.
Each round of checks takes 8 to 12 seconds.

### Agent tools on the runner

Runner mode answers the `impact`, `check` and `apply_fix` calls agents make through MCP
([design.md](design.md#tools-on-the-runner)). Each pass claims the waiting requests from
`POST /tool-runs/claim` under a 30-minute lease. For each request the runner fetches `feature-<id>`
and the other running features' forks with read tokens into the runner's repository. `impact` and
`apply_fix` name every other running fork. `check` names the forks its change reaches, as a land of
the feature targets them:

- `impact` runs the [impact analysis](#impact-analysis) on the checkpoint's baseline and the
  checkpoint, with each other fork, keyed by its feature id, searched in its person's scopes. While
  the project has retiring symbols, the request carries them. The runner then runs a second
  analysis on the baseline alone, with each other fork's own changes searched for the retiring
  symbols. It reports the remaining callers grouped by owner under `migration`.
- A request Penguin records at a checkpoint with `search: "own"` is the retiring-calls check. The
  runner runs one analysis with the checkpoint as a fork of its own changes. It applies the declared
  rewrite rules to each file that uses a retiring symbol in a throwaway worktree and reports one
  ladder step per file and symbol under `decisions`.
- A request Penguin records after a promotion with `search: "callers"` is the count of the
  contract step. Its baseline and checkpoint are both main's commit after the promotion, held by the
  promoted feature's fork. The claim carries no agent's charter (`penguin`) and lists every running
  feature with a checkpoint, the promoted one included. The runner runs one analysis of main with
  each fork's own changes since that commit, searched for the retiring symbols. It reports that
  analysis as `impact` with the migration groups under `migration`. The groups leave out the
  defining scope's own uses: a use in the module that defines a retiring symbol, or in a test file
  of the scope whose paths hold it, on main or in the originating feature's own changes, read with
  the scope map at the checkpoint. The contract step removes those with the symbol
  ([design.md](design.md#sorting-and-splitting-in-the-build)).
- A request Penguin records after a promotion with `search: "edges"` reads main's scope
  dependencies ([design.md](design.md#scope-dependencies-from-the-code)). It is claimed like a
  count, with no other fork. The runner runs one analysis of main at the promotion with
  `edges: true` and reports it as `impact`.
- A request Penguin records at each checkpoint with `search: "calls"` reads the checkpoint's caller
  list ([design.md](design.md#caller-list)). It is claimed with no other fork. The runner reads every
  waiting list of a pass in one analysis with `calls: true`, at most 256 forks at a time, and reports
  each request's names under `calls` with no `impact`. An incomplete read is reported as an error.
- A request Penguin records after a count with `search: "rewrite"` is the rewrite of a split's
  migration parts ([design.md](design.md#migration-plans-in-the-build)). It is claimed like a count.
  Its input names the originating feature's retiring symbols with their rules. It also names each
  place: `main` or a running feature, with the files whose uses the rules may rewrite. For each place the
  runner applies the rules to those files at main's commit or at the feature's fork head, in a
  throwaway worktree, with the codemod, the lint autofix and the formatter. It keeps the change as
  a unified diff. It applies each target's patches to a commit kept only in the runner's
  repository, with no checkout. One analysis of those commits then searches for the retiring
  symbols. It reports, per place under `rewrites`, the files and rules, the patch, the uses left
  (`residual`, less the defining scope's own uses) and any error. Nothing is pushed.
- `check` runs the [block checks](#block-checks) on the checkpoint merged onto its baseline and onto
  each other running feature's fork at its head, with every fix written into it, as a land merges
  onto it. Each merged tree is named by its feature id, so a person with
  several running features has each one checked. The feature's person decides which scopes' tests
  run and receives the routed failures. The checking feature's person is the run's `changer`, so
  their own dependent scopes run their tests on the checkpoint itself, as a `tests` check named
  by their id. Each failed or erred check gets
  one decision from the [resolution ladder](#resolution-ladder). No fix runs.
- `apply_fix` runs the [fix](#resolution-ladder) the agent asked for on the checkpoint. The fix may
  change only the named files inside the caller identity's charter. A codemod by `rules` runs the
  rewrite rules of retiring symbols, each contract module read at the checkpoint. A codemod by
  `expand` writes a split's expand step with the same script and allowlisted command ID
  (`fix:python-codemod`): `old = new` after the new definition for a rename, `from <new module>
  import <name> as <old name>` after the old module's imports for a move. For a keyword rename it writes a
  signature that takes both keywords and forwards the old one. The edits come from the ProjectAgent's
  split, never from the agent. An edit the script cannot write comes back under `refused` with the
  reason.

The runner reports each result to `POST /tool-runs/<id>`. Penguin hands it to the requesting session
at its next safe checkpoint. A request whose forks cannot be fetched is reported as a
[failed run](#failed-runs). A tool that runs and fails is reported with the result `error`.

A write token on another feature's fork comes only with an approved merge plan part
([Fix writes](#fix-writes)). An `apply_fix` request carries no plan part, so the runner pushes no
`apply_fix` commit. Each one stays at
`refs/penguin/fixes/<commit>` in the runner's repository. Its result carries `pushed: false` with
the commit and the files it changed.

### Colour handling

The runner finds failing tests from pytest's `FAILED <node id>` summary lines. Coloured output wraps
those lines in escape codes, so the bridge turns colour off for every command: it removes
`FORCE_COLOR`, `PY_COLORS` and `CLICOLOR_FORCE` from the environment and sets `NO_COLOR=1`. The
parser also strips ANSI escape sequences before it reads the log (`combined-run.ts`), so a test tool
that colours its output anyway still reports its failures.
