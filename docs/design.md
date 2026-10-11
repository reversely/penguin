# Design

This page is the design reference for Penguin. It describes the approved procedure. Each feature is
a fork of main. Affected authors approve a merge plan in advance. Approved fixes go into the forks
where the affected code lives. Main moves once per block. Parts of it are still being built. Pages that describe
the current build open with a note naming the section here that changes them.

## Model

Penguin serves a team whose members each own parts of one codebase and each run several coding
agents. Owners and their agents coordinate through typed records in shared state: feature
declarations, merge plans, approvals, check results and promotions. Each person and each session
reads only the records that concern their own features and scopes.

### Concepts

| Concept | Meaning |
|---|---|
| Person | A member of the team. A person owns scopes and features. A person approves an overlapping start in their area and the part of a plan that touches their code |
| Scope | A part of the codebase with one owner: paths, contracts and declared invariants. One scope depends on another when it reads the other's data or calls its contracts |
| Feature | One unit of work heading to main. Each feature is a fork of main in Cloudflare Artifacts, created when the feature opens. A feature declares its area: the scopes, paths and contracts it expects to touch |
| Agent identity | A named agent a person creates, such as `@ines/money`, with a job and a charter. The charter lists the scopes and paths the identity may change. Identities follow the model of Grok Bot ([Grok Bot](https://docs.x.ai/grok-bot/bots)) |
| Session | One running agent working as an identity on one feature |
| Merge plan | The plan written by the agent whose feature changes something other features depend on. It lists the change, each affected feature and scope, plus the fix proposed for each |
| Block | Every write a merge plan makes: the originating feature's fork plus the fixes written into each affected fork. Penguin checks a block as one set and promotes it as one set |
| Invariant | A plain statement a scope's owner declares once, such as "tax is rounded per line item". The statement must hold after every change |
| Penguin | The coordinator. Penguin checks, routes, applies deterministic fixes and promotes blocks to main. Agents write every judgment fix. People decide every disagreement |

### Rules

- **Claims and evidence.** An agent's report that its work is complete is a claim. A passing
  deterministic check, an approved plan or a promoted block is evidence. The dashboard shows which
  is which.
- **Escalation.** Penguin decides anything it can decide from facts. An agent does anything that
  fits inside its charter. A person sees a decision only when the decision touches their code or
  breaks a declared rule.

### Pieces

| Piece | Holds or does |
|---|---|
| `main` in Artifacts | The team's code. Only Penguin writes to it, only to promote a block |
| `feature-*` in Artifacts | One fork of main per feature. The feature's agents write to it. The originating agent of an approved plan writes its fix into it |
| `record` in Artifacts | One signed file per record: features, plans, approvals, checks and promotions |
| Worker | The front door: authentication, the MCP tools, the dashboard API, forks and repo-scoped tokens through `fork()` and `createToken()` |
| ProjectAgent | One Durable Object per project: people, scopes, invariants, features and their areas, overlap locks, sessions and inboxes. It validates and signs every record |
| FeatureAgent | One Durable Object per feature with a merge plan: the plan, its approvals, the fix writes, the block checks and the promotion |
| Check runner | A designated machine that runs the checks in [Checks](#checks) on merged trees |
| Bridge | One per person's machine: it publishes checkpoints with consent and runs the project's allowed commands |

## Procedure

The procedure moves conflict handling to the start of the work. Each step below names who acts.

### Open

1. A person, or an agent on their behalf, opens a feature. Penguin forks main into the feature's repo.
   It issues each of the feature's agents a short-lived write token for that fork.
2. The feature declares its area. The agent writes the declaration. The person may edit it. Each
   checkpoint updates the declaration with what the feature actually touched.
3. Penguin checks the declaration against every running feature:
   - **Same area.** Another running feature already works in that area. Penguin blocks the new
     feature from starting until the person whose agent works there approves. That person approves
     when the two pieces of work are far enough apart. Penguin's tools then resolve routine merge
     conflicts between them.
   - **Depends on it.** Running features read what the new feature will change. Penguin lists them.
     They leave the start unblocked. They go into the merge plan.
4. If a merge plan touching this area is already announced, Penguin hands it to the new feature at
   open.

#### Steps 1 and 2 in the build

- **Opening.** An agent session calls `open_feature` with a feature id and its area. A person posts
  the same to `POST /api/features` on the dashboard. The ProjectAgent stores the `Feature` row and a
  signed `open_feature` record. The Worker then forks main into `feature-<id>` with `fork()`. A
  second open of the same id makes no fork: it answers `existing`. A session of the same person
  joins the feature. Anyone else is refused. Each session works on one feature.
- **Tokens.** The Worker mints a `write` token on `feature-<id>` for each agent session of the
  feature: one with `open_feature`, a fresh one with `feature_token`. A session that has not joined
  the feature is refused. The tools name a feature id, never a repo. A request therefore cannot
  reach main, another feature's fork or the record repo. The token's plaintext goes to the session
  once. Penguin keeps no copy and logs none. A person who opens a feature on the dashboard gets no
  token.
- **Area.** Scope ids and contracts must be named in `penguin/scopes.json`. Each scope there may
  list `contracts`, its public symbols as `path::symbol`. Paths are relative and hold only letters,
  digits, `_`, `.`, `-` and `/`. No segment may start with `-` and none may be `..`. The agent
  replaces the area with `declare_area`. The person replaces it with
  `POST /api/features/<id>/area`. A checkpoint reported on the fork, through `report_checkpoint`
  or the bridge's `POST /checkpoints`, adds each path it changed against its baseline on main and
  the scope that path falls in. Contracts change only by declaration until the contract diff
  exists ([Checks](#checks)).
- **Records.** Each opening, declaration and checkpoint update is a record signed with Penguin's
  service key. Each record carries its path in the record repo,
  `records/<feature>/<author>-<writer>-<seq>.json`. The ProjectAgent keeps the records until the
  record repo exists.
- **Configuration.** `PENGUIN_FEATURE_FORK_DEFAULT_BRANCH_ONLY` sets `fork()`'s
  `defaultBranchOnly`. `PENGUIN_FEATURE_TOKEN_TTL_MINUTES` sets the token lifetime.
  `PENGUIN_REPO_PREFIX` leads every repo name. Opening refuses without valid values.

### Plan

1. A feature that changes a contract, a stored data shape or an invariant that other features or
   scopes depend on needs a merge plan. Its agent writes the plan before it writes the change.
2. Penguin supplies the facts the plan needs: the contract diff, the impact graph of callers, the
   affected running features and each affected scope's invariants.
3. The plan lists each affected place with its proposed fix:
   - **Code already on main** in other scopes: the fix goes into the originating feature's fork.
   - **Unfinished work** in affected running features: the fix goes into that feature's fork.
4. Penguin classifies each fix as mechanical or behavioural ([Routing](#routing-and-the-resolution-ladder)).
   Penguin's tools generate the mechanical fixes. The originating agent writes the behavioural ones.
5. **Break limit.** If a plan touches more running features than the project's limit (default 10),
   Penguin returns it to its author to split or restructure.

### Advance notice

1. The plan goes to each affected author and their running agents before any of it reaches main.
2. Each affected author's agent reviews the part touching their code through the review form
   ([Review harness](#review-harness)). Penguin validates the form and runs the side-by-side
   comparison.
3. The author approves their part once or asks for a change. A requested change goes back to the
   originating agent, which revises that part of the plan.
4. Penguin brings the decision to the author in person only in three cases: the review form reports
   a broken invariant, the side-by-side run shows a difference on a protected invariant, or the plan
   touches a path the author protects.

### Build

1. As soon as an author approves their part, Penguin issues the originating agent a short-lived write
   token on that author's feature fork. The agent writes the approved fix straight into the fork. No
   new branch or fork is made.
2. The affected feature's own agents keep working on code that already fits the change, so the merge
   conflict never forms.
3. A running feature that starts touching the plan's area midway shows up at its next checkpoint.
   The plan gains a fix for it. Its author approves that fix the same way.

### Block promotion

1. When the originating feature is ready, Penguin checks the block. It merges the originating fork
   onto main. It also merges it onto each affected fork with that fork's fix in place. Every merged
   result runs the checks in [Checks](#checks).
2. Failures go through the [resolution ladder](#routing-and-the-resolution-ladder).
3. An owner who wants to see the result gets an expiring read token on the originating fork and
   clones it. Penguin creates no new repo for the preview.
4. When every check passes, Penguin moves main to the originating feature's commit in one push. The
   push uses a write token on main that only Penguin holds, for minutes. Every affected fork already
   carries its fix, so none of them breaks when it next takes main.
5. The originating fork turns read-only. It records exactly what reached main.

### Late starters

A feature opened after a plan was announced receives the plan at open. Its agent writes against the
planned change from the start. The agent resolves any remaining conflict itself before its own block
reaches main.

## Deterministic checks, tools and routing

### Checks

Each check is a mechanical fact about code. No check calls a model.

| Check | Finds |
|---|---|
| Overlap | Same files and same hunks changed in two forks |
| Merge | Whether forks combine cleanly (`git merge-tree --write-tree`) |
| Impact graph | Which functions, classes and modules a change touches; which forks import or call them |
| Contract diff | Changed signatures, removed exports, changed schemas, migrations, config keys and stored data shapes |
| Type check | Interface breaks on the merged tree |
| Lint | Lint rules on the merged tree |
| Dependency diff | A shared library changed version; which forks use it |
| Tests | Each affected scope's own tests on the merged tree |

Penguin runs tests and type checks only for forks the impact graph marks as affected.

#### Impact graph and contract diff for Python

The check runner builds the impact graph and the contract diff of a Python change with the
allowlisted command `analysis:python-impact`. The command reads the change's base and head commits
plus one commit per fork. It uses only the Python standard library: `git ls-tree` lists the paths,
`git cat-file` reads the bytes and `ast.parse` reads the code. It never imports or runs the code.
[bridge-and-runner.md](bridge-and-runner.md#impact-analysis) describes the command and its limits.

One run records a structured report: the tool, the command ID, the base and head commits, each fork
with its commit and scopes, then what the analysis found.

| Finding | Contents |
|---|---|
| Changes | Each function, method, class and module-level value the change modifies, adds, removes, renames or moves, with its file, line, scope and the declared contract that covers it. A docstring edit is no change |
| Signatures | Before and after of each changed signature with the parameters added or removed. It says whether a call that worked before can now fail, with the reason |
| Removed exports | Each name a module exported at base that an import of the module at head can no longer reach |
| Stored data shapes | Field lists before and after for each dataclass, `NamedTuple`, `TypedDict` and `Enum` whose fields change |
| Uses | Each import, call or reference of a changed symbol, with its file and line. Head uses lie outside the changed files. Fork uses lie inside the fork's scopes |

Names resolve through imports and re-exports. A re-export in `__all__` that points at another
definition counts as a change to the re-exported name. In the dependency bump, `shared/http.py`
re-exports the client from a newer vendored version, so the report lists `shared.http.Client` as
modified with its new constructor signature. A method call resolves when the variable's class comes
from a parameter annotation, a constructor call or an annotated return type.

Scope paths and contracts come from `penguin/scopes.json` at head. A contract is a `path::symbol`
entry in a scope's `contracts` list. A contract that names a class covers its methods.

The selection function `selectAffectedForks` (`packages/protocol`) returns the forks whose scopes
import, call or reference a changed symbol, plus any fork with an unreadable file in its scopes.
Every fork is selected when the report is incomplete: a changed file other than an importable
Python module, a changed file that did not parse, or a list cut at its limit. On the helpful fix the
report lists `start_of_day()` as modified with an unchanged signature. It lists Jun's call in
`analytics/weekly.py` and Sam's call in `messaging/reminders.py`, so both forks run tests. On
identity unification it lists the `Profile` field change and the new required `identity` parameter
of `Profile.set`. It lists every analytics and messaging file that imports the identity map.

### Tools for agents

Agents call these tools through MCP. Each tool answers with facts or applies one deterministic change.

| Tool | Answers or does |
|---|---|
| `whats_near` | Running features that touch these paths or depend on these scopes, with their people and agents |
| `impact` | Functions, contracts and forks a checkpoint affects |
| `check` | Runs the [checks](#checks) on the agent's change combined with each affected fork |
| `apply_fix` | Applies one deterministic fix: format, lint autofix, regenerate a lockfile, or a codemod for a rename, move or signature change |
| `propose_plan` | Submits a merge plan; Penguin fills in the facts and returns what is missing |
| `submit_review` | Submits the review form for a plan part ([Review harness](#review-harness)) |

### Routing and the resolution ladder

When a check fails, Penguin classifies the failure and returns one next step to one agent. An agent
therefore never tries tools in turn.

| Step | Failure | Next step |
|---|---|---|
| 1 | Formatting, import order, lint | Penguin applies the formatter and lint autofix |
| 2 | Lockfile conflict | Penguin regenerates the lockfile |
| 3 | Mechanical interface change: rename, move, added parameter with a default | Penguin applies a codemod generated from the contract diff |
| 4 | Behaviour change inside the agent's charter | The originating agent adapts, with the failing check and the changed lines attached |
| 5 | Behaviour change outside its charter | The agent of the scope's owner adapts |
| 6 | Exception ([Exceptions](#exceptions)) | One person |

Each step's result goes back through the checks before Penguin accepts it. Penguin writes no
judgment fix. Steps 4 and 5 belong to agents.

## Review harness

The review harness puts deterministic gates around an agent's review of a semantic change. The gates
make each review account for stored data, every declared invariant and the inputs that behave
differently.

1. **Declared invariants.** Each scope's owner lists the scope's invariants once in
   `penguin/invariants.json` in the base repo. Penguin hands the relevant invariants to any agent
   reviewing a plan that touches contracts the scope uses.
2. **Fixed review form.** A review holds one row per invariant: the invariant, a verdict of holds,
   breaks or unknown, the evidence (a test name or a code location in the fork) and the effect on
   data stored before the change. Penguin refuses a form with a missing row, evidence that does not
   exist, or "unknown" without a test behind it.
3. **Side-by-side runs.** For each contract the plan touches, Penguin runs the scope's public
   functions on main and on the fork, on recorded examples and test fixtures. It attaches the
   differences, such as "invoice tax differs on 312 of 5,000 sample orders; every case has three or
   more lines".
4. **Named risky inputs.** The form lists inputs the reviewer expects to behave differently. Penguin
   runs them against the old code and the new code. It attaches the results.
5. **Stored data rule.** If the contract diff shows that stored data changes meaning or shape, the
   plan needs a migration, a backfill or a cutover marker before anyone can approve it.

#### Invariants and examples

`penguin/invariants.json` sits beside `penguin/scopes.json` on main. Each invariant has an `id`, the
`scope` that declares it, a one-line `statement` and `protected` (false when absent). Each entry of
`examples` names a scope, a JSON file inside that scope's paths and the scope's invariants the file
bears on. Only the scope's owner therefore writes the data its functions run on.

```json
{
  "invariants": [
    { "id": "tablet-patrons-separate", "scope": "analytics",
      "statement": "Patrons who log in on one library tablet stay separate people", "protected": true }
  ],
  "examples": [
    { "scope": "analytics", "file": "analytics/examples/daily_active_users.json",
      "invariants": ["tablet-patrons-separate"] }
  ]
}
```

An examples file names one of the scope's contracts and its recorded cases:
`{ "contract": "analytics/models.py::daily_active_users", "cases": [{ "name": "...", "args": {...} }] }`.
The scope's public functions are its contracts in `penguin/scopes.json`. `parseInvariantsFile`
(`packages/scope-map`) refuses a file with an unknown field, a repeated id, a scope or invariant from
elsewhere, a statement over 500 characters or an examples file outside its scope. It lists every
problem.

#### The review form

A form holds `rows`, one per invariant of the reviewing scope, each with `invariant`, `verdict`
(`holds`, `breaks` or `unknown`), `evidence` and `storedData`. It may add `riskyInputs`, each a name,
one of the scope's contracts, an optional invariant and keyword arguments as JSON. It may add a
`storedDataMarker`: a `kind` (`migration`, `backfill` or `cutover`) and the marker's place in the fork.

Evidence is a test or definition written as a pytest node ID, such as
`analytics/tests/test_identity.py::test_shared_device_split`, or a line, such as `tax/invoice.py:42`.
A node ID counts as a test when its file is `test_*.py` or `*_test.py` and its last name starts
with `test`. Penguin looks each piece up in the fork's files at the reviewed commit: the file must
exist, the definition must be in it at the named nesting and the line must be in range. A path with
`..`, a leading `/` or a character outside letters, digits, `_`, `.` and `-` is refused. Penguin never
runs evidence. `validateReviewForm` (`packages/protocol`) refuses a form with each of these reasons:

| Refusal | Cause |
|---|---|
| `missing_row` | An invariant of the scope has no row |
| `unknown_invariant`, `duplicate_row` | A row names an invariant the scope does not declare, or repeats one |
| `no_evidence` | A row has no evidence, whatever its verdict |
| `invalid_evidence`, `evidence_not_found` | Evidence is malformed, or the fork lacks it |
| `unknown_without_test` | An `unknown` row cites no test |
| `stored_data_without_marker` | The contract diff shows a stored data shape changed and the form names no marker |
| `invalid_form` | A field is missing, unknown or over its limit, such as 600 characters of evidence or 64 KiB of one input's arguments |

#### Submitting a review

An agent submits the form with the MCP tool `submit_review`, naming the feature under review and its
own scope. Penguin checks that the session's person owns the scope and that the feature's fork has a
checkpoint. It reads the invariants from main and each evidence file from the fork at that
checkpoint. It answers at once with `accepted` or `refused` and every reason. A refused answer is
marked as a tool error so the agent fixes the form. The ProjectAgent keeps every well-formed form in
`FeatureReview`, keyed by feature and scope until merge plans give it a plan part. The form's text,
the reviewer's invariant names and the owner's statements come back inside `personWritten`.

The stored data rule needs the contract diff. The side-by-side run needs the scope's code run. Both
therefore happen on the check runner. The answer says both are waiting for it.

#### Side-by-side runs on the runner

The runner's review (`penguin-bridge review`, [bridge-and-runner.md](bridge-and-runner.md#side-by-side-runs))
checks the form again against the fork's Git objects. It makes the contract diff with
`analysis:python-impact` and applies the stored data rule to its stored data shapes. It then runs
the scope's examples files and the form's risky inputs on main and on the fork through
`analysis:side-by-side`. Inputs reach the scope's code as JSON data built into the parameter types.
Each input is checked against the function's signature before any input runs.

The record of a run names the base and fork commits and the scope. Each set in the record gives the
contract, the examples file or the risky inputs, the invariants it bears on and every input's name.
It lists each input whose outcome differs, with its arguments and both outcomes. It lists each input
not run with the reason. It sums the call time on each side. The run proceeds for a refused form too, because its differences
are what the reviewer needs next.

`reviewExceptions` gives what goes to the scope's owner in person. It raises a `broken_invariant` for
each row of an accepted form whose verdict is `breaks`. It raises a `protected_difference` for each
protected invariant whose set shows a difference, whatever the form says. An empty list means the
agent's review stands without the owner.

On identity unification, with "patrons who log in on one library tablet stay separate people" as
analytics' protected invariant, the run on Priya's checkpoint shows `daily_active_users` returning
3 people on main and 1 on the fork for three patrons on one tablet. A risky input of six patrons on
one tablet still differs on Priya's limit of five and matches main on Priya's limit of one.

## Exceptions

People see only the exceptions in this table. Everything else proceeds without them.

| Exception | Goes to |
|---|---|
| A new feature starts in an area another running feature covers | The person whose agent works in that area; the start waits for their approval |
| A plan touches code in an author's scope | That author, once, for their part |
| A plan touches a path its owner protects | That owner, who confirms the final lines |
| A review form reports a broken invariant, or a side-by-side run shows a difference on a protected invariant | That scope's owner |
| A check fails in an area with no tests and no type coverage | That scope's owner |
| Agents pass a fix back and forth past the project's round limit (default 3) | The originating feature's person |
| A plan exceeds the break limit | The originating feature's person, to split it |

## Interface

### Dashboard for people

| View | Shows |
|---|---|
| Team | Each person as a square with their features. Each feature carries its agents and a one-word state: building, planning, waiting on approvals, promoting or promoted. Only exceptions are highlighted |
| Approvals inbox | Overlapping starts, plan parts touching the person's code, protected-path confirmations and exceptions. Each item shows the facts behind it: the changed lines in the person's scope, the side-by-side differences and the review form |
| Feature page | The declaration, the merge plan with each affected place and its state, the fixes written into other forks, the block's checks, the promotion and the record |
| Identities | Creating and editing agent identities with their charters |

Session transcripts stay on each person's machine. No dashboard page shows one.

### MCP for agent sessions

Sessions call `register_session`, `get_work`, `post_update` and `report_checkpoint`, plus the
[tools for agents](#tools-for-agents). Penguin delivers new plan parts, approvals and exceptions at
the session's next safe checkpoint, through the bridge's hook.
