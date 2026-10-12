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
     the dependency diff, default `python3`. `--ruff <path>` names ruff. Without it the runner uses `PENGUIN_RUFF`, then this repository's
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
   - claims the `impact`, `check` and `apply_fix` requests agents made. It fetches the feature's
     fork and the other running features' forks, runs the tool on the checkpoint and reports the
     result (`tool-run.ts`, [Agent tools on the runner](#agent-tools-on-the-runner));
   - claims the writes of approved mechanical plan parts and writes each into the affected
     feature's fork ([Fix writes](#fix-writes));
   - claims the block runs of features that land or whose plan needs checking again, runs the
     checks and reports each one ([Block runs](#block-runs)).

Passing `--combined` or `--repo` is the runner operator's consent to those runs and pushes. The test
jobs loop on their own, so a long test run never holds up the operation pushes. `--once` runs a
single pass of each and exits 1 when anything was refused or failed.

The runner fetches owner forks and feature forks with read tokens. It pushes Huddle repos with write
tokens. The Worker grants a runner bridge `write` on `huddle-<id>` repos and an owner bridge only
`read`. The runner gets `write` on a `feature-<id>` repo only with a claimed fix write, for that one
part, so it pushes no `apply_fix` commit. It reads the `base` repo and never holds `write` on it.

### Block runs

A feature reaches main as a block ([design.md](design.md#block-promotion-in-the-build)). Each pass
claims the waiting block runs from `POST /blocks/claim` under a 30-minute lease (`block-run.ts`). A
claim names the run, its purpose (`land` or `plan_check`), the feature's fork and checkpoint, main's
head and branch, every other running feature's fork with its head and the originating identity's
charter. The bridge checks each commit is a full object ID and the branch a plain branch name before
it uses them.

For each run the runner fetches `base`, the feature's fork and every target's fork with read tokens.
It runs a combined run with the [block checks](#block-checks): the checkpoint merged onto main and
onto each target, keyed by the target's feature id. The change is the checkpoint against its merge
base with main. Every scope's test command also runs on main's merged tree, because main moves to
exactly that tree. Each failed or erred check gets one decision from the
[resolution ladder](#resolution-ladder), routed by the claim's charter. No fix runs.

The runner reports to `POST /blocks/<feature>/<n>`. The Worker hands the report to the feature's
FeatureAgent, which moves main itself when a land run passed. The answer names the run's new state
and, for a promotion, main's commit before and after. A run whose repos cannot be fetched stays
claimed and runs again after its lease. A run that cannot be checked reports an `error` check on
main, which never passes.

On the helpful-fix fixture, the block of `owner-priya` with the switch to `start_of_local_day` written
into Jun's and Sam's forks passes every check. All three scopes' tests pass on main's merged tree.
Without the switch, Jun's and Sam's tests fail on their merged trees and each failure carries one next
step (`services/local-bridge/test/block-run.test.ts`).

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

### Fix writes

Once an author approves a part of a merge plan, its fix becomes one commit on the affected feature's
fork ([design.md](design.md#steps-1-and-3-in-the-build)). Two writers use the same code
(`fix-write.ts`):

- The originating agent pipes the answer of the `fix_token` MCP tool to `penguin-bridge fix-write`.
  The command fetches the fork into `<state-dir>/fix-writes`, or `--repo <path>`, writes the fix and
  prints the commit as JSON for `report_fix_write`.
- Runner mode claims the writes of approved mechanical parts at `POST /fix-writes/claim` under a
  10-minute lease. Each claim carries a `write` token minted for that part on that fork. The runner
  writes each fix and reports the commit to `POST /fix-writes/<write id>`.

The writer fetches the fork's `main` and stops with `moved` when its head is not the granted parent.
It reads each file the patch writes at the parent and applies the patch with `applyPatchFile`
(`packages/protocol`), the function Penguin checks the commit with. Every hunk must match at its line.
The writer stores each new file as a blob in a scratch index over the parent's tree. It refuses when
the tree changes anything but the patch's files. It commits with Penguin's message as author
`Penguin` with no hook or signing. It pushes the commit to `main` with no force. The token reaches
Git only in the push's environment. A fork whose head moved refuses the push; asking `fix_token`
again rebases the write or sends the part back for revision.

Building and pushing one fix commit took about 200 ms against a bare fork on local disk. Against
Artifacts through local `wrangler dev` it took about 1 second; `fix_token` and `report_fix_write`
took about 2 seconds each, most of it Artifacts reads.

### Plan facts runs

A merge plan needs facts that only running the code can give ([design.md](design.md#steps-1-to-5-in-the-build)).
`propose_plan` schedules one facts run per feature checkpoint. `GET /plan-facts` lists each pending
run. The listing names the originating fork, the checkpoint, its baseline on main and the targets.
`main` is one target, at the baseline. Each running feature that may read the change is another, at
its latest checkpoint, keyed by its feature id and naming its person. Every target lists `test:<scope>` command IDs only. For each run the runner:

1. refuses a listing that names a repo other than a `feature-<id>` fork or a commit that is not a
   full SHA, then fetches each fork it names;
2. runs `analysis:python-impact` on the baseline and the checkpoint, with one fork per running
   feature. Each fork names the baseline as `since`, so the analysis lists only the uses in files the
   feature added or changed since its merge base with the baseline. A use in a file the feature
   carries unchanged from main is main's caller. The report counts those as `carried` and leaves
   them out of the fork's uses;
3. merges the checkpoint onto each target with `git merge-tree --write-tree`;
4. runs each listed test command on the merged commit in a throwaway worktree. A running feature
   whose own changes the impact graph shows make no use of the change gets `not-affected` without a
   run;
5. states each failing test as a break: its docstring at the merged commit (`test-evidence.ts`)
   with the assertion line and first error line pytest printed for it;
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
own. The report comes back on standard output and is checked against `IMPACT_REPORT_SCHEMA` in
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
| Missing commit or malformed request | Exit status 2 with one line on standard error |

A combined run (`CombinedRunner`) takes its targets as forks, each with an id, a person and a
checkpoint. A running feature's fork is a target keyed by its feature id, so one person's two
features are two targets. An owner fork is a target keyed by its owner's id. A target is tested in
the dependent scopes it names, or in its person's dependent scopes when it names none. Given an
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
contract diff for the stored data rule and runs both sides.

```sh
penguin-bridge review --repo <path> --base main --fork <commit> --scope analytics \
  --form form.json [--out review.json] [--json] [--no-diff]
```

The text form prints the verdict with each refusal, the stored shapes the diff found, the
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
| Overlap | `git:diff-hunks` | `git diff -U0` from the merge base to each side, per file both sides change, with `--literal-pathspecs` | Both sides change the same hunk of one file |
| Merge | `git:merge-tree` | `git merge-tree --write-tree` | A path conflicts. Lint, format, type check and tests then report `not-run` |
| Dependency diff | `analysis:python-dependencies` | `python3 -I python_dependencies.py`, reading Git objects only | A library changed version and the target's scopes import it |
| Lint | `check:ruff-lint` | `ruff check --output-format json` on the Python files the merge changes | The merged tree has a finding the target's own tree lacks |
| Format | `check:ruff-format` | `ruff format --check` on the same files | A file would be reformatted that the target's own tree leaves alone |
| Type check | `check:pyright` | pyright 1.1.414 with `--outputjson` on the whole merged tree | The merged tree has an error the target's own tree lacks |
| Tests | `test:<scope id>` | The scope's test command (`test-runner.ts`) | The command exits other than 0 |

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
`npm install` puts beside the bridge. It resolves imports with the Python on `PATH`, or with
`--python <path>`.

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
the dependency bump it prints, for Ana's checkpoint:

```text
4a56f11d9f6c onto ana@e6994519dd70 (merged dad2a2dfc816)
  overlap passed: no file changed in both [git diff, git:diff-hunks, 35 ms]
  merge passed: merges cleanly [git merge-tree, git:merge-tree, 26 ms]
  dependencies failed: shared.http changed version; ana imports it in 4 places [python-dependencies, analysis:python-dependencies, 262 ms]
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
matches however the file imports it, through `QualifiedNameProvider`. Each placeholder captures one
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
to `@jun/reports` and `@sam/reminders`, because the failing files lie outside `@priya/batches`'s
charter. With an unused import added to Priya's `shared/dates.py`, lint fails on every target. The
failure goes to step 1. One `fix:ruff-autofix` commit on Priya's checkpoint clears it on all
three. On an Apple silicon laptop one codemod run takes about 1 second, most of it libcst's import.
Each round of checks takes 8 to 12 seconds.

### Agent tools on the runner

Runner mode answers the `impact`, `check` and `apply_fix` calls agents make through MCP
([design.md](design.md#tools-on-the-runner)). Each pass claims the waiting requests from
`POST /tool-runs/claim` under a 30-minute lease. For each request the runner fetches `feature-<id>`
and every other running feature's fork with read tokens into the runner's repository:

- `impact` runs the [impact analysis](#impact-analysis) on the checkpoint's baseline and the
  checkpoint, with each other fork, keyed by its feature id, searched in its person's scopes.
- `check` runs the [block checks](#block-checks) on the checkpoint merged onto its baseline and onto
  each other running feature's fork. Each merged tree is named by its feature id, so a person with
  several running features has each one checked. The feature's person decides which scopes' tests
  run and receives the routed failures. Each failed or erred check gets
  one decision from the [resolution ladder](#resolution-ladder). No fix runs.
- `apply_fix` runs the [fix](#resolution-ladder) the agent asked for on the checkpoint. The fix may
  change only the named files inside the caller identity's charter.

The runner reports each result to `POST /tool-runs/<id>`. Penguin hands it to the requesting session
at its next safe checkpoint. A request whose forks cannot be fetched stays claimed and runs again
after its lease. A tool that runs and fails is reported with the result `error`.

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
