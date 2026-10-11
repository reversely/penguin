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
