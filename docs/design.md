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

#### Step 3 in the build

- **When the check runs.** The ProjectAgent checks a feature's stored area against every other
  running feature at each opening and at each declaration, from `declare_area` or
  `POST /api/features/<id>/area` (`services/project-agent/src/overlap-lock.ts`). A checkpoint
  grows the area without a check. Checks and approvals run one at a time.
- **Same area.** Two areas overlap where a scope one declares holds a path, a contract or a scope
  of the other. They also overlap where one declared path is, contains or lies inside a path the
  other declares, or where both name one contract. Two files in one scope stay apart unless one
  feature declares the scope. Each covering feature gives one `OverlapLock(feature_id,
  blocked_feature_id, state, approved_by)` with the scopes, paths and contracts where the areas
  meet. A later declaration that no longer overlaps withdraws an open lock. An approved lock stays
  approved.
- **Same person.** A covering feature that belongs to the declaring feature's own person makes no
  lock, since that person already knows both pieces of work. The ProjectAgent keeps the overlap as
  an `OwnOverlap`, writes it into the check's record and lists it on the feature under
  `ownOverlaps` in the `open_feature`, `declare_area` and `get_work` answers.
- **The wait.** While any lock on a feature is open, the Worker mints no write token on its fork.
  `open_feature` still makes the fork. It answers with a null token and lists each covering
  feature with its person in `waitingOn`. `feature_token` refuses with `locked`. `get_work` reports
  the wait under `feature.waitingOn`. Once every lock is approved, `feature_token` gives the token.
- **The end of the wait.** When a lock is approved or withdrawn, each session of the waiting
  feature hears of it once, at its next safe checkpoint. The bridge hook's answer names the lock
  and tells the agent to call `feature_token`. `report_checkpoint` lists it under `locksSettled`.
  `get_work` lists each approval under `feature.approvedBy`. A session that joins the feature
  after the lock settled hears nothing of it.
- **The approval.** The covering person gets an inbox item of reason `overlap`. Their running
  sessions hear of it at their next safe checkpoint: the bridge hook's answer names it,
  `report_checkpoint` lists it under `newOverlaps` and `get_work` lists it under
  `overlapsNeedingYou`. The person approves on the dashboard inbox, which posts
  `POST /api/overlaps/approve` with `{ feature, blockedFeature }`. The Worker takes the approver
  from the dashboard session and refuses a body with any other field. The ProjectAgent refuses a
  caller who does not own the covering feature, a lock that does not exist and a second approval.
- **Depends on it.** A running feature that works in a scope whose `depends_on` names a scope the
  new area falls in is stored on the new feature as a `FeatureDependent`, with the consumer
  scope, the provider scope and the dependency's kind. It creates no lock.
- **Records.** Each check writes a signed `overlap_check` record on the checked feature, authored by
  Penguin, with the locks it opened, the locks it withdrew, the same person's overlaps and the
  dependents. Each approval writes
  a signed `approve_overlap` record on the blocked feature, authored by the approving person.

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
5. **Break limit.** If a plan has more parts needing a person than the project's limit (default 10),
   Penguin returns it to its author to split or restructure. A part needs a person when it fails a
   condition of [Advance notice](#advance-notice) step 3.
6. **Waves.** The author splits a returned change into waves by parallel change, each its own
   feature and plan. The expand wave adds the new shape beside the old one and changes no existing
   symbol, so its plan has no place. Each migrate wave moves one scope or a small group onto the new
   shape as its own change. Its places are the other scopes on main that call what it changes. The
   running features inside the scopes it moves are same-area features, whose people approve its
   start. The contract wave removes the old shape. Its places are the callers left on main and in
   running features' own changes. [case-study-money.md](case-study-money.md) runs the waves on the
   money fixture.
7. **Retiring symbols.** Once the expand step has put the new shape beside the old one, its plan
   marks the old contracts as retiring, each with its replacement. A checkpoint whose own changes
   call a retiring symbol gets a next step naming the replacement
   ([Routing](#routing-and-the-resolution-ladder)). Penguin lists the remaining callers on main and
   in running features' own changes, grouped by owner, as the migration's parts. Software
   Engineering at Google, chapter 22, describes both: Rosie "shards [a large change] based upon
   project boundaries and ownership rules". Google's review tooling reports a change "when an engineer
   introduces a new use of a deprecated object", to prevent "backsliding".

#### Steps 1 to 5 in the build

- **Proposing.** An agent session of the originating feature calls `propose_plan` with one part per
  affected place, each with an optional note. A part for code on main, `{ scope }`, names a commit in
  the originating feature's fork that holds the fix. A part for a running feature, `{ feature }`,
  carries its fix as a patch: a unified diff against that feature's fork head, the commit the facts
  run tested. The plan keeps the patch whole, so the fix can be written into the affected fork once
  its person approves. Penguin refuses a session of another person and a session that works on
  another feature (`services/project-agent/src/propose-plan.ts`).
- **The facts and their tools.** Each plan records which tool or read produced each fact:

  | Fact | Source |
  |---|---|
  | The change in plain words | The checkpoint commit's subject, read with the Artifacts binding's `readCommit`. The identity whose report recorded the checkpoint made it |
  | Contract diff | `analysis:python-impact` on the check runner, from the checkpoint's baseline on main to the checkpoint |
  | Callers | The same impact report: uses already on main plus uses in each running feature's own changes, the files it added or changed since its merge base with the baseline |
  | Affected running features | Running features whose own changes use a changed symbol or whose tests break on the merged tree |
  | Invariants | Each affected scope's entries in `penguin/invariants.json` on main |
  | Breaks | Each `test:<scope>` command the runner ran on the checkpoint merged onto main and onto each running feature. A break states the test's docstring, or the test's name in words when it has none, with the assertion line and the error line from the run. On a running feature, only tests in its own changes or whose traceback passes through its own callers |
  | Changed lines | For code on main, the part's commit against its base, read with `readCommit`, `readTree` and `readBlob`. For a running feature, the part's patch, checked against that feature's files at its fork head read the same way. Only files inside the part's affected scopes are read |

- **Facts runs.** The impact report and the breaks need the code parsed and run, so the check runner
  makes them ([bridge-and-runner.md](bridge-and-runner.md#plan-facts-runs)). The first proposal for a
  checkpoint schedules a run and answers `missing` with `waiting_for_runner`. A newer checkpoint
  supersedes a pending run.
- **Places.** A scope outside the changed scopes is a place when it has a caller on main or a break on
  the `main` target. A running feature is a place when its own changes use a changed symbol or hold a
  file the analysis could not read in its scopes, or when it breaks on its merged tree. Its own changes
  are the files it added or changed since its merge base with the baseline. A fork also carries
  main's files as they were when it started. A caller in a file the feature carries unchanged belongs
  to main's part. The feature gets that fix when it takes main, which the block check requires
  before the feature lands. A feature's breaks follow the same rule. A failing test in a file the
  feature changed is its break, and so is one whose traceback passes through a file holding the
  feature's own callers. A failing test in a file it carries unchanged is main's break, listed on
  main's part and not repeated on the feature's. The `breaks` source counts those carried tests. A
  feature whose own changes call nothing in the contract diff is no place.
  Its tests do not run. The `affected_features` source names each such feature with the reason. A
  part proposed for it is `not_affected` with the same reason. The scope's owner or the feature's
  person approves the part.
- **What is missing.** Penguin answers `missing` with every gap: an affected place with no part, a
  part for an unaffected place, two parts for one place, a diff commit missing from the fork, a diff
  that changes no file in the place's scopes, or a failed analysis. A patch is also refused when it
  names another base than the feature's fork head, cannot be parsed, writes outside the place's
  scopes or does not match the fork's lines at the head. `parsePatch` (`packages/protocol`) takes only
  text edits of regular files: no rename, copy, mode change or binary file.
- **Mechanical or behavioural.** A fix is mechanical when every changed line pairs with a new line
  that differs only by names a codemod edit of the contract diff swaps in that place. The edits come
  from `codemodPlan` (`packages/protocol`), the same edits the resolution ladder's step 3 applies: a
  rename, a move or a renamed keyword parameter. A plan part and the ladder therefore agree on what
  Penguin's codemod can write. A fix is also mechanical when every file it changes is exactly what
  the plan's rewrite rules write there (below). Any other fix is behavioural. The part names the
  first line or file that shows why. On the helpful fix both proposed fixes are behavioural: each
  one also adds the user's offset as an argument of the call it switches to `start_of_local_day`.
- **Rewrite rules.** A type migration needs pattern rewrites the contract diff cannot give, so the
  originating agent declares them in `propose_plan`'s `rules` (`rewrite-rule.ts` in
  `packages/protocol`). Each rule names one contract the contract diff touches (`path::symbol`), a
  kind, a pattern, a replacement and the imports the replacement needs. An `expression` rule
  rewrites each expression its pattern matches, such as `money.display($amount)` to
  `$amount.display()`. Its pattern must name a use of the contract. An `annotation` rule rewrites a
  type annotation, such as `float` to `money.Money`, on a function's return when every `return`
  calls the contract, and on a parameter passed by name to a call of the contract.
  - The facts run carries the rules (#105). The check runner compiles each rule into LibCST
    matchers and applies it with Penguin's codemod (`fix:python-codemod`), then the lint autofix
    and the formatter. Rules run on main's files at the baseline inside the dependent scopes. They
    also run on each running feature's own changed files at its checkpoint. The runner reports each
    changed file's blob before and after.
  - The runner refuses a rule whose pattern names no use of its contract, because it would rewrite
    code outside its contract. It also refuses a replacement that names anything other than its
    placeholders, the contract's module and the rule's imports. An import comes from the contract's
    module or the standard library. Penguin refuses a rule whose contract the contract diff does
    not touch. Each refusal is a `rule_refused` item in `missing`. Nothing in a rule is run.
  - A part is mechanical by the rules when each file the fix or the rules change inside the part's
    scopes has the same blob before and after on both sides. Other rules than the last run's need
    a new facts run.
- **Break limit.** The limit counts a plan's parts that fail one of Penguin's checks when the plan
  is proposed ([Penguin's approval in the build](#penguins-approval-in-the-build)). A mechanical
  part counts like any other. A review the author's agent has yet to submit, one the check runner has
  yet to record and one of an older checkpoint are waited for, so they do not count. In admin mode
  every part counts. `PENGUIN_PLAN_BREAK_LIMIT`, a Worker setting, sets the limit, 10 when unset.
  Any value other than a positive whole number refuses every plan as misconfigured. A plan over the
  limit gets a signed `plan_returned` record naming those places under `in_person`. The originating
  person gets a `plan_returned` inbox item.
- **Storing.** A complete plan is a signed `propose_plan` record listing each part. Its `Plan` and
  `PlanPart` rows live in the feature's FeatureAgent, the per-feature Durable Object.
  `plan-store.ts` is the one module that holds them. `GET /api/features/<id>/plan` answers the
  newest plan as JSON for the dashboard. A part's patch and changed lines (`diff.patch`, `diff.files`) go to the feature's person, the part's owner
  and that owner's delegate, the same rule the feature page applies (`mayReadPartLines` in
  `dashboard-views.ts`). For any other signed-in person both fields are null.
- **Retiring symbols.** `propose_plan` takes `retiring`: up to 64 `{ contract, replacement }`
  pairs, each `path::symbol` (`retiring.ts` in `packages/protocol`). Each contract must be one that
  `penguin/scopes.json` declares for a scope the feature's area names. Only an agent session of the
  feature's own person proposes its plan, so only that person declares. A contract another feature
  already retires is refused as `conflict`. A rewrite rule may name a retiring contract the
  contract diff does not touch. When the plan is stored, Penguin signs a `retire_symbols` record
  on the feature with each contract, its replacement and the ids of the plan's rules for it. The
  `RetiringSymbol` table on the ProjectAgent keeps the declarations
  (`services/project-agent/src/retiring-store.ts`). A newer plan of the same feature replaces them.
  - **Retiring calls.** Each checkpoint that an agent session reports while symbols are retiring
    records one `impact` request of Penguin's own (`requestRetiringCheck` in `agent-tools.ts`), once
    per checkpoint. The check runner runs `analysis:python-impact` once, from the checkpoint's
    baseline to the checkpoint, with the checkpoint as a fork of its own changes since the baseline
    and the retiring contracts as `symbols`: the analysis searches for them as if they had
    changed. For each file that uses a retiring symbol with declared rules, the runner applies the
    rules to that file with the codemod in a throwaway worktree that keeps no commit. Each
    file and symbol gets one ladder step. The step is 3 when a rule rewrote the file, so `apply_fix`
    with `kind: codemod` and the step's `rules` applies it. Otherwise the step is 4 inside the
    checkpoint identity's charter, or 5 outside it. Each step names the replacement and lists the
    uses as findings. The result reaches the session at its next safe checkpoint under
    `toolResults`.
  - **Migration groups.** While symbols are retiring, an agent's `impact` request carries them. The
    runner runs a second analysis from the request's baseline to itself, with every other running
    feature as a fork of its own changes since that baseline. `migrationGroups` groups the uses:
    a use on main is a place of its scope, owned by the scope's owner; a use in a running feature's
    own changes is a place of that feature, owned by its person. The result's `migration` lists one
    group per owner. An agent asks from a checkpoint at main's head to see main as it is.
- **Limits.** A commit subject is cut at 300 characters, a docstring at 500 and an assertion or error
  line at 300. A note may hold 2,000 characters and a plan 128 parts. Penguin keeps every such string
  as data. The MCP answer puts each one inside `personWritten`.

#### Sorting and splitting in the build

Penguin sorts each feature checkpoint's contract diff and decides between a split and a merge plan
(`sortContractDiff` in `packages/protocol/src/contract-sort.ts`,
`services/project-agent/src/contract-split.ts`).

- **One contract diff per checkpoint.** Each reported checkpoint asks for its facts run: Penguin
  reuses the checkpoint's run when one exists and schedules one otherwise. `propose_plan` and the
  expand's Only adds check read the same run. A feature before its first checkpoint has a fork equal
  to main, so the sort waits for that checkpoint.
- **The sort.** The author's scopes are the scopes the feature's person owns in
  `penguin/scopes.json`. A caller is a use on main or in a running feature's own changes in any other
  scope, or in no scope. Each entry gets one sort:

  | Entry | Sort |
  |---|---|
  | An added symbol | Additive |
  | A new parameter with a default; a rename or move whose old name still reaches the new definition (`kept`); a breaking change with no caller outside the author's scopes; a body change to an undeclared symbol nobody outside calls | Compatible |
  | A rename, move, keyword rename, removed symbol or export, breaking signature or changed type, with callers outside the author's scopes | Incompatible |
  | A body change or a stored data shape change, with the same signature, to a declared contract or a symbol with callers outside the author's scopes | Behaviour change |

  An incompatible entry decides a split. Otherwise a behaviour change decides the merge plan.
- **The split.** When the check runner reports a sort with incompatible entries the feature's split
  does not hold, Penguin records them with a signed `contract_split` record and tells the person.
  The agent's next step in `get_work` is "Expand first" with the entries listed. `apply_fix` with
  `expand: true` has Penguin's codemod write `old = new` for a rename, an import of the new
  definition into the old module for a move and a signature that takes both keywords for a keyword
  rename. Penguin derives the codemod's edits and files from the split. For a changed type, a
  breaking signature or a removed symbol the agent writes the parallel function. The analysis then
  reports each aliased rename or move as `kept`. The expand's Only adds check counts it as an
  addition ([Expand in the build](#expand-in-the-build)).
- **Retiring.** `land_feature` with `expand: true` may name in `retiring` the parallel function of
  each old name the codemod does not expand. Once the expand checkpoint reaches main, Penguin marks
  each old name of the split retiring with its replacement. One signed `retire_symbols` record holds
  them under the plan id `split:<feature>`. A rename or move names its own replacement. A method has
  no module-level contract to retire. An old name with no replacement stays unretired. The record
  lists each unretired name with the reason. The next step then lists the retiring names and asks
  for the migration plan ([Steps 1 to 5 in the build](#steps-1-to-5-in-the-build), Retiring
  symbols). A later plan of the feature keeps the split's declarations, except each contract it
  declares itself.
- **Behaviour change.** A sort with behaviour changes and no incompatible entry keeps the merge plan.
  The next step asks for `propose_plan`.
- **The view.** `get_work` reports the sort of the session's feature under `contract`
  ([mcp-setup.md](mcp-setup.md#contract-sort-and-split)). `GET /api/features/<id>/page` carries the
  same object as `contract`, for the feature page to show the split's stage. It is a
  `ContractWorkView` (`packages/protocol/src/contract-sort.ts`):

  | Field | Content |
  |---|---|
  | `checkpoint`, `factsRun` | The latest checkpoint and the facts run that holds its contract diff; null before the first checkpoint |
  | `state` | `no_checkpoint`, `waiting`, `failed` or `sorted` |
  | `decision` | `split`, `plan` or `none`; null until sorted |
  | `counts`, `complete` | The number of entries of each sort; false when the impact report was incomplete |
  | `entries`, `omitted` | Each `ContractSortEntry`: `symbol`, `path`, `line`, `kind`, `change`, `sort`, `breaks`, `scope`, `contract`, `to`, `keyword`, `callers` and `reason`. Incompatible entries come first, at most 100; `omitted` counts the rest |
  | `split` | Null without a split; otherwise `state` (`expand_first` or `retiring`), the `checkpoint` that last added an entry, its `entries`, the `replacements` the agent named, the `promotion` commit, the `retiring` pairs, the `unretired` names with reasons and the `recordId` of its last signed record |
  | `nextStep` | The agent's next step in one paragraph |
- **On the fixtures.** Each sort comes from the fixture's checkpoint against main
  (`apps/worker/test/contract-sort-fixtures.test.ts`). On identity unification, Priya's checkpoint
  adds `IdentityMap.person_id`, which sorts additive. The same checkpoint edits `resolve()` and
  `profile()` in place with the same signatures. Both sort as behaviour changes to the declared
  `IdentityMap` contract, so the feature keeps its merge plan and no old lookup retires from this
  checkpoint. On the helpful fix, `start_of_day()` keeps its signature and sorts as a behaviour
  change. On money in minor units, Ines's checkpoint removes `display()`, changes the parameters of
  `price()` and changes the types of `total()`. All three have callers in other scopes and sort
  incompatible, so Penguin splits the feature.

### Advance notice

1. The plan goes to each affected author and their running agents before any of it reaches main.
2. Each affected author's agent reviews the part touching their code through the review form
   ([Review harness](#review-harness)). Penguin validates the form and runs the side-by-side
   comparison.
3. Penguin approves a part when every check is clean:
   - the part's tests pass on the merged tree;
   - its review form reports every invariant holding;
   - the side-by-side run shows no difference on a protected invariant;
   - it touches no path the author protects;
   - its diff stays inside its place: the part's files and the contract's symbols.

   Penguin tells the author, who may reverse the approval until the block reaches main.
4. Any other part goes to its author in person, who approves it once or asks for a change. A
   requested change goes back to the originating agent, which revises that part of the plan.
5. **Admin mode:** a project can require a person's approval for every part.

#### Penguin's approval in the build

`partRouting` (`packages/protocol/src/plan-approval.ts`) checks a part against the five conditions
from facts Penguin already holds. Each condition that is not clean is a reason. The dashboard
shows each reason as one line. Penguin approves the part only with no reason. An absent result is a
reason too:

| Check | Clean when | Read from |
|---|---|---|
| Tests | Each of the part's scopes is `passed` on the merged tree of the part's place. That tree holds the fix | The part revision's recorded [trial](#part-trials); without one, `PlanPart.tests`, kept from the facts run when the plan is proposed |
| Review | The newest review of each of the part's scopes was submitted on the plan's checkpoint. The check runner accepted it. Every row says the invariant holds | The feature's reviews (`review-submit.ts`), each form the part's trial ran read from that trial |
| Side by side | That review's run shows no difference on a protected invariant | The review's exceptions |
| Protected paths | No file of the diff lies under a path a scope's owner protects in `penguin/scopes.json` | The scope map |
| Place | Every changed file lies in the part's scopes and holds a caller of a changed contract symbol or a test the change breaks there | `PlanPart.diff.files`, `diff.outside`, `callers` and `breaks` |

- **Which fixes a run has tested.** Each part revision's trial builds the tree with the fix in place
  and runs the part's scopes' tests and reviews on it ([Part trials](#part-trials)). Once the trial
  is recorded, its results replace the facts run's for that revision. While the trial runs, each
  form it carries counts as pending, so Penguin waits for it. Before any trial, the checks read the
  facts run, which merges the originating checkpoint onto main and onto each running feature's fork
  head. A fix commit for code on main counts as tested there only when that commit is the checkpoint
  or one of its ancestors, which Penguin checks by walking up to 500 commits back from the
  checkpoint. A patch for a running feature is in no facts-run tree.
- **When Penguin looks.** `approveCleanParts` (`services/project-agent/src/plan-approval.ts`) runs
  after a plan is stored and announced, after the check runner records a review of the feature or a
  part trial, and after the originating agent revises a part. It approves each pending part with no reason.
- **The approval.** Each approval is a signed `approve_plan_part` record authored by Penguin, with
  `approved_by: "penguin"` and a `checks` field naming the checkpoint, the run its tests came from
  (`trial-<id>` or the facts run), the trial tree when a trial ran, each test result and each review
  it read. The part's `approvedBy` is `penguin`. The author's `plan_part`
  item gives way to a `penguin_approved` item. An approved mechanical part on a running feature
  queues the check runner's write as an author's approval does.
- **Reversal.** The part's owner or that owner's delegate may reverse Penguin's approval until the
  block reaches main, on the dashboard (`POST /api/plan-parts/reverse` with `{ feature, part,
  revision }`). Anyone else, another revision, an approval a person gave and a feature whose block
  reached main are refused. A reversal is a signed `reverse_penguin_approval` record authored by the
  person. The part waits on its author again with a `plan_part` item. Penguin never approves that
  revision again. A write of it that has not happened yet is withdrawn. A land run checks every
  approval of its plan again before it moves main, so a reversal while the block is checked stops
  the promotion. An expand run names no plan, so it checks the feature's newest plan, when there is
  one, the same way.
  Once main moves to the block, the `penguin_approved` items go.
- **Admin mode.** `PENGUIN_PLAN_ADMIN_MODE`, a Worker setting, set to `on` makes a person approve
  every part: each part carries an admin mode reason and Penguin approves none. Unset, empty or `off`
  leaves it off. Any other value counts as on, so a mistyped setting never lets Penguin approve.

#### Advance notice in the build

- **Delivery.** A stored plan reaches every author at once
  (`services/project-agent/src/plan-approval.ts`). Each part's owner gets a `plan_part` inbox item.
  That owner's running sessions hear of the part at their next safe checkpoint: the bridge hook's
  answer names it, `report_checkpoint` lists it under `newPlanParts` and `get_work` lists it under
  `planPartsNeedingYou` with the scopes to review. A newer plan of the same feature withdraws the
  older plan's items. Every item and record names the part it concerns as `<feature>/v<version>#<n>`.
- **Review.** The author's agent reviews the part with `submit_review` for each scope the part
  touches ([Review harness](#review-harness)). An agent never approves: no MCP tool approves a part.
- **Trials.** Each revision of a part is tested on the tree it would reach main as, before anyone
  approves it (`services/project-agent/src/part-trial.ts`, [Part trials](#part-trials)). Penguin asks
  for a trial of every part when it stores a plan and of a part when it is revised. It asks again for
  each part covering a scope when that scope's agent submits a form. The check runner builds the
  trial tree and runs the part's scopes' tests and the review harness for the newest form of each
  scope on it. Penguin keeps the report against the part revision. A newer trial of the part, or a
  newer plan of the feature, supersedes the older trial, so only the newest trial of the current
  revision counts.
- **Decision.** Penguin approves each part whose checks are clean
  ([Penguin's approval in the build](#penguins-approval-in-the-build)). For any other part the author
  approves it or asks for a change on the dashboard inbox, which
  posts `POST /api/plan-parts/approve` with `{ feature, part, revision }` or
  `POST /api/plan-parts/request-change` with the same fields plus `text`. The Worker takes the
  decider from the dashboard session and refuses a body with any other field. The ProjectAgent
  accepts a decision from the part's owner or the delegate that owner names in
  `penguin/owners.json`. It refuses anyone else, a part outside the feature's newest plan, a
  revision other than the part's current one and a second decision on the same revision. A request
  holds at most 2,000 characters, kept as data. Each approval is a signed `approve_plan_part` record
  and each request a signed `request_plan_change` record on the originating feature, authored by
  the deciding person.
- **Revision.** A requested change moves the part to `change_requested`. The originating feature's
  sessions hear of it at their next safe checkpoint under `planDecisions`. `get_work` shows the
  feature's plan with each part's state and the author's words inside `personWritten`. The
  originating agent answers with `revise_plan_part`, naming the part, the revision and a new fix in
  the form `propose_plan` takes. Penguin reads and checks the fix as it checks a proposed one,
  classifies it again and keeps it as the part's next revision in a signed `revise_plan_part`
  record. The part then waits on its author again, whose item turns unread.
- **Round limit.** Each requested change counts as one round. `PENGUIN_PLAN_ROUND_LIMIT`, a Worker
  setting, sets the limit, 3 when unset. Any value other than a positive whole number refuses every
  request as misconfigured. The request after the limit, the fourth by default, moves the part to
  `round_limit`. The originating person gets a `round_limit` inbox item and Penguin signs a
  `plan_round_limit` record. The originating agent may no longer revise the part. Its author may
  still approve the revision they have.
- **Routing.** `partRouting` (`packages/protocol`) lists every reason a part needs its author in
  person ([Penguin's approval in the build](#penguins-approval-in-the-build)). The dashboard lists
  each reason beside the part. With no reason, Penguin approves the part.
- **Protected paths.** A scope in `penguin/scopes.json` may list `protected_paths`, each inside the
  scope's own paths. A path protects itself and everything under it. A part whose fix writes such a
  path gives the scope's owner a `protected_path` item to confirm its lines.
- **The feature's own change.** The plan includes the originating feature's own change, so its
  protected paths are checked too, at each checkpoint of the feature
  (`services/project-agent/src/protected-change.ts`). Penguin reads the files that differ between
  the checkpoint and its merge base with main: the newest commit of main's history that the
  checkpoint reaches through any parent. A file main brought in by a merge is not the feature's own.
  Each changed file is matched once against the protected paths. A path the feature's own person
  protects raises nothing, as the overlap lock makes no lock between one person's features. Each
  other person who protects a touched path gets a `protected_path` item naming the feature, with the
  changed lines of those files. Only that person or their delegate confirms the lines, on the
  dashboard, at the checkpoint they saw (`POST /api/plan-parts/confirm-protected`). A confirmation is
  a signed `confirm_protected_change` record on the feature. A later checkpoint that leaves those
  files as confirmed keeps the confirmation. One that changes them asks again, and one that no longer
  touches the person's paths withdraws the item. The feature cannot land while a confirmation waits
  (`protected_path_unconfirmed`). The lines follow the plan patches' rule: the feature's person, the
  protecting person and that person's delegate read them. A project whose protected paths all belong
  to the feature's own person reads nothing more at a checkpoint.
- **Review verdicts.** The session that submitted a review hears the check runner's verdict at its
  next safe checkpoint under `reviewResults`: accepted or refused, the refusal codes and the
  exceptions raised. `get_work` repeats each verdict with its reasons.
- **Dashboard.** `GET /api/plan-parts` lists the parts waiting on the signed-in person as owner or
  delegate with their changed lines and routing reasons. It lists the parts Penguin approved for them
  until the block reaches main, each with `approvedBy: "penguin"`. It also lists the parts that write
  a path the person protects, the features whose own change writes one, the parts of their plans past
  the round limit and the reviews of their scopes that raised an exception.
- **Storage.** The parts with their revisions and states live in the feature's own Durable Object,
  which takes a change only while the part still stands where the decision read it.
  `PlanPartRoute` on the ProjectAgent keeps which revision of which part waits on whom, for
  checkpoints and the inbox.

### Build

1. As soon as an author approves their part, Penguin issues the originating agent a short-lived write
   token on that author's feature fork. The agent writes the approved fix straight into the fork. No
   new branch or fork is made.
2. The affected feature's own agents keep working on code that already fits the change, so the merge
   conflict never forms.
3. A running feature that starts touching the plan's area midway shows up at its next checkpoint.
   The plan gains a fix for it. Its author approves that fix the same way.

#### Steps 1 and 3 in the build

- **Who writes.** The originating agent named in the plan (`Plan.proposedBy`) writes a behavioural
  part. Its session on the originating feature calls `fix_token` with the part and the revision. A
  mechanical part is Penguin's codemod, so the check runner writes it: the approval queues the write
  and the runner claims it at `POST /fix-writes/claim`
  ([bridge-and-runner.md](bridge-and-runner.md#fix-writes)). A part for code on main gets no token on
  another fork. Its fix is a commit in the originating fork already
  (`services/project-agent/src/fix-write.ts`).
- **The token.** The Worker mints a `write` token on the affected feature's fork alone, for
  `PENGUIN_FIX_TOKEN_TTL_MINUTES` (default 10, at most 60). It mints one only on a grant from the
  ProjectAgent. A grant needs the current revision of a part in the feature's newest plan, approved
  and not yet written. Penguin refuses an unapproved part, another revision, another session or
  identity, a part already written and a mechanical part asked for by an agent. The token's
  plaintext goes to the writer once. Penguin keeps no copy.
- **The paths.** Before any grant, Penguin parses the approved patch again. Every file it writes must
  lie inside the part's scopes and in the part's approved diff. A patch that writes another path gets
  no token.
- **The fork head.** The commit must fast-forward the affected fork's `main`. When the head is still
  the patch's base, the base is the parent. When the author's own agent moved the head, Penguin
  applies the patch to the new head's files. If every hunk still matches at its line, the new head is
  the parent. If a hunk does not match, the part goes back to the originating agent as
  `change_requested` with Penguin's request naming the new head. That request counts no round.
  `revise_plan_part` then takes a patch against the new head. The author approves the revision again.
  A signed `plan_part_rebase` record states the move.
- **The commit.** The grant names the parent, the files, the approved patch and the commit message.
  Penguin builds the message from validated fields only: the part, the revision, the approver, the
  fix's reference and the writer's handle (`fixCommitMessage`, `packages/protocol`).
  `penguin-bridge fix-write` makes the commit from the `fix_token` answer without a checkout. It
  applies the patch with `applyPatchFile`, checks that the commit changes exactly the patch's files
  and pushes it with no force. A fork whose head moved refuses the push.
- **The record.** The writer reports the commit: the agent with `report_fix_write`, the runner at
  `POST /fix-writes/<write id>`. Penguin reads the commit through the Artifacts binding. It keeps the
  write only when the commit has the granted head as its one parent, carries the built message,
  changes exactly the patch's files with each file equal to the patch applied to the parent and sits
  on the fork's `main`. A kept write is a signed `fix_write` record on the originating feature and a
  `FixWrite(plan_part_id, target_repo, commit_sha)` row in the feature's plan store. A refused commit
  gets a signed `fix_write_refused` record.
- **Midway.** Each announced plan keeps its area: the scopes whose symbols its contract diff changes,
  the scopes of its parts and the contracts it changes. It also keeps which running features it
  accounts for: those with a part and those whose area already met it when it was announced
  (`services/project-agent/src/plan-coverage.ts`). At each feature checkpoint Penguin compares the
  feature's grown area with every announced plan that does not account for it. A plan the area now
  meets gains a part for the feature, owned by the feature's person, with a signed `plan_part_added`
  record. The part starts as `change_requested` with Penguin's request for a patch against the
  feature's checkpoint. The originating agent answers it with `revise_plan_part`. The feature's
  person approves the revision. The fix is then written as above. The checkpoint's answer lists the
  part under `plansJoined`. The originating feature's sessions hear of it under `planDecisions`.

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

#### Block promotion in the build

- **Who owns it.** The feature's FeatureAgent (`services/feature-agent`) keeps every block run, its
  checks and the promotion (`services/project-agent/src/block-store.ts`). The ProjectAgent checks each
  request and signs each record (`block-land.ts`). The same FeatureAgent keeps the feature's plan and
  fix writes. A feature with no plan goes through the same steps with no fix to check.
- **Ready to land.** The feature's agent calls `land_feature`. Penguin refuses the land with a reason
  and opens no run in six cases. The latest checkpoint does not yet hold main's head (`behind_main`):
  the agent merges main into its fork and reports the merge as a checkpoint. A part of the plan is not
  approved (`plan_not_approved`). A person whose protected path the feature's own change writes has
  not confirmed the lines (`protected_path_unconfirmed`). A part for a running feature has no fix
  written at its current revision (`fix_not_written`). A fix for code on main is not in the
  checkpoint (`fix_not_in_block`). A written fix is no longer under its fork's head
  (`fix_not_in_place`). Ancestry is read through the binding's `log` and `readCommit`; the search
  stops at main's own history.
- **The block run.** One run checks the checkpoint merged onto main's head and onto the head of the
  `main` branch of every other running feature's fork. That head carries each fix written into the
  fork. The check runner claims the run at `POST /blocks/claim` and runs the [checks](#checks) on each
  merged tree. It runs every scope's tests on main's merged tree. Main moves to exactly that tree, so
  each scope's tests must pass there. The runner reports to `POST /blocks/<feature>/<n>`, which the
  Worker hands to the feature's FeatureAgent. Penguin keeps the report only when it answers the claimed
  run: the same checkpoint, main and targets at the commits the run named.
- **The verdict.** A block passes when no check failed or erred, every target has a passed merge
  check and main's merged tree ran tests that all passed. A failing block leaves main where it is and
  sends the feature back to `building`. Each failure carries one next step from the
  [resolution ladder](#routing-and-the-resolution-ladder), routed by the originating identity's
  charter. The agent reads them in `get_work`'s `landing`, applies them, reports a checkpoint and calls
  `land_feature` again.
- **The promotion.** A passing land run takes the project's one promotion slot. The FeatureAgent
  mints a write token on the base repo and a read token on the feature's fork, each for
  `PENGUIN_PROMOTION_TOKEN_TTL_MINUTES` (default 5, at most 15). It reads main's ref, fetches the
  commits main lacks from the fork's `git-upload-pack` and sends one `git-receive-pack` command
  `<main before> <checkpoint> refs/heads/<BASE_BRANCH>` with that pack (`main-push.ts`). Git applies
  the command only while main still names the checked commit. Both tokens are revoked after the push.
  No bridge, MCP tool or dashboard route can ask for a token on main.
- **A race.** Main that moved after the check refuses the push. Penguin signs a `promotion_refused`
  record and checks the block again on main's new head. A checkpoint that no longer holds main goes
  back to the agent with a signed `land_returned` record naming `behind_main`.
- **Read-only.** After the push the FeatureAgent revokes every write token on the originating fork.
  The ProjectAgent marks the feature `landed`: it mints no feature token for it, writes no fix into it
  or for its plan, takes no checkpoint for it and retires its announced plan. Each start its overlap
  locks held is checked again.
- **The record.** Every step is a signed record on the feature: `land_requested`,
  `plan_check_requested`, `block_checked` with each check's result, fingerprint and log reference,
  `promotion` with `main_before`, `main_after`, the fixes written into other forks and the targets
  checked, `promotion_refused` and `land_returned`. Each `block_checked` record states the time from
  the request to the report. Each `promotion` record states that time and the time from the report to
  main moved.
- **Plan checks.** A checkpoint of a running feature whose area meets another feature's announced plan
  asks for a `plan_check` run of that plan's block (Build step 3). It runs the same checks, keeps its
  record and never moves main. A land run supersedes a waiting plan check; a plan check waits while a
  land run holds the feature.
- **Expand.** An expand checkpoint reaches main through the same run, slot and push with the run's
  purpose `expand` ([Expand in the build](#expand-in-the-build)). The feature stays `building` and its
  fork keeps its write tokens.
- **Preview.** An owner fetches the originating fork with an expiring read token through
  `penguin-bridge preview --feature <id>` ([bridge-and-runner.md](bridge-and-runner.md#preview)).
  Artifacts makes no new repo.

#### Expand in the build

The expand step of a split adds the new shape beside the old one. Penguin promotes that checkpoint to
main on its own, from the feature's fork, while the feature keeps building on top of it
(`services/project-agent/src/expand-promotion.ts`).

- **Asking.** The feature's agent calls `land_feature` with `expand: true`. Penguin checks what a land
  checks first: the latest checkpoint is in the fork and holds main's head (`behind_main` otherwise).
  A change to a path another person protects waits for that person's confirmation
  (`protected_path_unconfirmed`), as a land does. A feature that is landing answers `busy`.
- **The impact run.** The Only adds check reuses the facts run a merge plan reads
  ([Steps 1 to 5 in the build](#steps-1-to-5-in-the-build)): the checkpoint's impact report and test
  results against main's head. With no such run, Penguin schedules one and answers
  `waiting_for_runner`. A failed analysis answers `impact_failed`.
- **Only adds.** The checkpoint passes when the impact report is complete and every changed symbol is
  `added`. A changed signature, a removed export, a changed stored data shape or a modified, removed,
  renamed or moved symbol fails it. So does every place the facts show: a scope with a caller or a
  break on main, or a running feature whose own changes use a changed symbol or break. Adding a method
  to an existing class changes that class, so the class counts as modified. A rename or move whose old
  name the expand codemod kept as an alias counts as an addition: the old name still reaches the same
  definition, so its callers are no place. Penguin refuses a failing checkpoint with `not_only_adds`
  and lists each entry that fails.
- **Another owner's scope.** A checkpoint whose added symbols fall in a scope another person owns waits
  on that person through the overlap lock. Penguin opens one lock per person and feature, keyed
  `owner:<person>` in place of a covering feature, with a signed `overlap_check` record. The person
  gets an `overlap` inbox item and approves it on the dashboard with `POST /api/overlaps/approve`.
  Until then the expand answers `waiting_on_owner`. An approved person is not asked again for later
  expands of the same feature. This lock holds only the expand: the feature's start and its write
  tokens never wait on it.
- **The run and the promotion.** Penguin opens an `expand` block run with a signed `expand_requested`
  record that names the facts run and the added symbols. The run checks the checkpoint merged onto
  main and onto every other running feature's fork head, like a land run. A passing run takes the
  promotion slot and moves main with Penguin's own short-lived tokens in one push. The promotion is a
  signed `expand_promotion` record. The fork keeps its write tokens and the feature stays `building`.
  A race checks the expand again on main's new head, or records `land_returned` with the reason.
- **Afterwards.** The feature's next checkpoints build on the promoted one, which is now main's head.
  `get_work` lists each expand promotion under `landing.expansions`. The feature's own land later
  moves main from the expand checkpoint to its final checkpoint.

### Late starters

A feature opened after a plan was announced receives the plan at open. Its agent writes against the
planned change from the start. The agent resolves any remaining conflict itself before its own block
reaches main.

#### Late starters in the build

`open_feature` and `POST /api/features` answer a newly opened feature with `announcedPlans`: every
announced plan of another feature whose area the declared area meets. Each entry names the plan, its
feature and person, its scopes and contracts and where the two areas meet. The checkpoint's commit
subject sits inside `personWritten`. Each plan handed over this way then accounts for the feature, so
a later checkpoint adds no part for it.

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
| Only adds | Whether a checkpoint changes no existing signature and the impact graph shows no place |
| Retiring calls | Uses of a retiring symbol in a checkpoint's own changes |

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
| Changes | Each function, method, class and module-level value the change modifies, adds, removes, renames or moves, with its file, line, scope and the declared contract that covers it. A docstring edit is no change. A rename or move is `kept` when the old name still reaches the new definition through `old = new` or an import |
| Signatures | Before and after of each changed signature with the parameters added or removed. It says whether a call that worked before can now fail, with the reason |
| Removed exports | Each name a module exported at base that an import of the module at head can no longer reach |
| Stored data shapes | Field lists before and after for each dataclass, `NamedTuple`, `TypedDict` and `Enum` whose fields change |
| Uses | Each import, call or reference of a changed symbol, with its file and line. Head uses lie outside the changed files. Fork uses lie inside the fork's scopes. A fork asked with `since` lists only uses in files it changed since its merge base with that commit. The rest count as `carried` |

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

#### The checks on merged trees

The check runner merges the originating checkpoint onto main and onto each running feature's
checkpoint. Each feature is a target of its own, keyed by its feature id: PRD 0.4 section 1 gives a
person any number of features, each its own fork. A pre-0.4 owner fork is a target keyed by its
owner. It runs every check in the table above on each merged tree, except the contract diff,
which comes from the impact report. Overlap, merge and the dependency diff read Git objects. Lint
and format run ruff (T18). The type check runs pyright 1.1.414 (T19). Tests run each affected
scope's own test command. The type check and the tests run only for the targets the impact graph
selects. A target left out gets a `not-affected` result, which completes that target's run.
[bridge-and-runner.md](bridge-and-runner.md#block-checks) describes each command and its limits.

Lint, format and type findings count only when the merged tree has them and the target's own tree
does not. A finding already on the target before the merge never fails the block. The dependency
diff reads versions from `pyproject.toml`, `requirements*.txt`, `uv.lock` and vendored modules that
state `__version__`. It fails a target whose scopes import a library that changed version. In the
dependency bump, `shared/http.py` re-exports `__version__` from `vendor/wire_v2` in place of
`vendor/wire_v1`. The dependency diff therefore reports `shared.http` 1.4.0 to 2.0.0 with the three
places Ana's payments scope imports it.

Each result is a `BlockCheck` record: the target, the check, the result, the tool with its version
and command ID, the commits it read, its findings with file and line, a fingerprint, a reference to
the raw output kept on the runner and the wall time. The runner sends the records with the combined
run's report. The ProjectAgent keeps them by trigger checkpoint for the feature page.

On the three fixtures:

| Fixture | What the checks find |
|---|---|
| Identity unification | Tests fail for Jun (two tests) and Sam (one test). The type check passes on both: no caller outside Priya's file calls `Profile.set`. Sam's one existing pyright error is already on Sam's checkpoint. Lint passes (`examples/ruff.toml` matches a built fixture's import sorting) |
| Helpful fix | Tests fail for Jun and Sam, one test each. Lint passes |
| Dependency bump | The dependency diff fails for Ana and for main. Ana's payment test fails |

### Tools for agents

Agents call these tools through MCP. Each tool answers with facts or applies one deterministic change.

| Tool | Answers or does |
|---|---|
| `whats_near` | Running features that touch these paths or depend on these scopes, with their people and agents |
| `impact` | Functions, contracts and forks a checkpoint affects |
| `check` | Runs the [checks](#checks) on the agent's change combined with each affected fork |
| `apply_fix` | Applies one deterministic fix: format, lint autofix, regenerate a lockfile, or a codemod for a rename, move or signature change, or by the rewrite rules of a retiring symbol |
| `propose_plan` | Submits a merge plan; Penguin fills in the facts and returns what is missing |
| `submit_review` | Submits the review form for a plan part ([Review harness](#review-harness)) |

#### Tools in the build

The MCP server serves `whats_near`, `impact`, `check`, `apply_fix` and `submit_review`
(`services/mcp/src/tools.ts`). The ProjectAgent answers `whats_near` from the running features'
areas, the scope map and the sessions (`services/project-agent/src/agent-tools.ts`). It lists each
feature whose area touches the asked paths or scopes. It also lists each feature working in a scope whose
`depends_on` names one of them. The session's own feature is left out.

`impact`, `check` and `apply_fix` need the check runner's programs. The ProjectAgent checks the
request and records it at the feature's latest checkpoint, with that checkpoint's baseline on main.
Its answer says the request waits for the check runner. Only an agent session of the feature may
call them. `apply_fix` takes one of the fixed kinds `format`, `lint`, `lockfile` and `codemod`. It
takes only Python files inside the caller identity's charter. Its codemod edits must name dotted
Python names. A codemod may name `rules` instead of edits: ids of rewrite rules declared for
retiring symbols, which Penguin looks up in its own store. By hand, `penguin-bridge apply-fix` applies one fix and `penguin-bridge resolve` runs
the checks with the ladder ([bridge-and-runner.md](bridge-and-runner.md#resolution-ladder)).

Each call is an `AgentToolRun` row: the feature, the session, the caller's identity, the tool, its
input, its answer and its duration. The feature page and demos read the rows. Their count per
resolved failure is the agent calls metric of PRD section 11.

#### Tools on the runner

Runner mode claims waiting requests with `POST /tool-runs/claim`, as it claims reviews. A claim hands
out up to 8 requests and holds them for 30 minutes. An unreported request is handed out again after
that. Each claimed request names the feature's fork `feature-<id>`, the checkpoint, its baseline, the
caller's charter and the other running features' forks. Each of those forks comes with its person
and its head: the commit at the top of its `main` branch, with every fix written into it, or its
latest checkpoint while the fork has no head. A land merges onto the same heads
(`blockTargets` in `services/project-agent/src/block-land.ts`), so `check` and `land` test the same
trees. Penguin reads the heads only when a claim hands out a request. Every running feature is
listed, so a person who runs several features has each one merged and checked.
The runner fetches every fork with a read token and runs the tool (`tool-run.ts`):

| Tool | What the runner does | Result |
|---|---|---|
| `impact` | `analysis:python-impact` on the baseline and the checkpoint, searching each other fork in its person's scopes | The impact report and the features whose forks use the change |
| `check` | A combined run with the [checks](#checks): the checkpoint merged onto its baseline (`main`) and onto each other fork | Every block check, plus one ladder decision per failed or erred check |
| `apply_fix` | The requested fix on the checkpoint, allowed only inside the caller's charter | The fix's tool run with the files it changed |

`check` applies no fix. A step 1 to 3 decision names the fix the agent requests with `apply_fix`.

The runner reports each result to `POST /tool-runs/<id>`. The ProjectAgent checks it against
`TOOL_RESULT_SCHEMA` (`packages/protocol/src/tool-result.ts`). The result must name the request's
own tool, baseline and checkpoint. A fix result must come from the requested fix's command and change
only the files the request named. The ProjectAgent keeps the result on the `AgentToolRun` row. The
first report wins. A later report of the same request answers 409. A result over 1 MiB of JSON drops
its impact report and says so in its summary.

The result reaches the requesting session once, at its next safe checkpoint. The bridge's PreToolUse
hook names it. `report_checkpoint` lists it under `toolResults`. `get_work` lists the session's last
10 delivered results with each full outcome.

PRD section 8 gives Penguin a write token on another feature's fork only for an approved merge plan
part (#91, [Steps 1 and 3 in the build](#steps-1-and-3-in-the-build)). An `apply_fix` request is not
part of a plan, so the runner keeps its commit at `refs/penguin/fixes/<commit>` in its own repository
and reports it with `pushed: false`. Plan-part fixes are written into the affected fork.

On the helpful-fix fixture, Priya's agent calls `check` on Priya's checkpoint with Jun's and Sam's
features running. With no manual run, the session's next safe checkpoint brings the block checks
on `main`, `weekly-report` and `reminder-scheduling`. Jun's and Sam's tests fail. Both failures go to
step 5, to `@jun/reports` and `@sam/reminders` (`apps/worker/test/tool-runner.test.ts`).

### Routing and the resolution ladder

When a check fails, Penguin classifies the failure and returns one next step to one agent. An agent
therefore never tries tools in turn.

| Step | Failure | Next step |
|---|---|---|
| 1 | Formatting, import order, lint | Penguin applies the formatter and lint autofix |
| 2 | Lockfile conflict | Penguin regenerates the lockfile |
| 3 | Mechanical interface change: rename, move, added parameter with a default, or a new call to a retiring symbol that a declared rewrite rule rewrites | Penguin applies a codemod generated from the contract diff or the rule |
| 4 | Behaviour change inside the agent's charter, or a new call to a retiring symbol no rule rewrites | The originating agent adapts, with the failing check and the changed lines attached |
| 5 | Behaviour change outside its charter | The agent of the scope's owner adapts |
| 6 | Exception ([Exceptions](#exceptions)) | One person |

Each step's result goes back through the checks before Penguin accepts it. Penguin writes no
judgment fix. Steps 4 and 5 belong to agents.

#### The ladder in the build

The ladder and its routes are data in `packages/protocol/src/resolution.ts`. `RESOLUTION_LADDER`
holds the six steps above. `LADDER_ROUTES` maps a check and a failure kind to a step and the fix
Penguin applies there. A row for one check wins over a row for any check:

| Check | Failure kind | Step | Fix |
|---|---|---|---|
| Format | Files to reformat | 1 | `fix:ruff-format` |
| Lint | New lint findings, import order among them | 1 | `fix:ruff-autofix` |
| Merge | Conflicts only in `uv.lock` | 2 | `fix:uv-lock` |
| Tests, type check | The target uses a symbol the contract diff shows renamed, moved, or with one keyword parameter renamed | 3 | `fix:python-codemod` |
| Retiring calls | A rule declared for the retiring contract rewrites the file | 3 | `fix:python-codemod` with the rule |
| Retiring calls | No declared rule rewrites the file | 4 inside the checkpoint identity's charter, 5 outside it | None |
| Any | Any other failure: a behaviour change | 4 inside the originating agent's charter, 5 outside it | None |
| Any | The check could not run | 6 | None |
| Any | A step 1 to 3 failure past the round limit | 6 | None |

`classifyFailure` gives each failed or erred check exactly one decision: the step, the next step's
wording, one actor, the fix's command ID and a one-line reason, with the check's summary and findings
attached. The charter is the originating identity's `charter_scopes` and `charter_paths`. A failing
place lies inside it when its file falls in a charter scope or under a charter path. A check that
names no file is placed by the target's scopes. Step 5 goes to the identity of the scope's owner
whose charter holds the scope. When the owner has none, the failure goes to the owner in person at
step 6. A fix Penguin applied that did not clear its failure turns that failure into a behaviour
change. A tool error goes to the originating feature's person.

`codemodPlan` builds the codemod from the contract diff of `analysis:python-impact`. Each use a
target makes of a renamed or moved symbol gives a `rename` or `move` edit. A use that calls a function
whose signature removes one parameter and adds one gives a `rename-parameter` edit. The edits list
the files of those uses. An added parameter with a default breaks no call, so no check fails on it
and no codemod follows.

On the helpful-fix fixture, a head that renames `start_of_day` to `start_of_local_day` fails Jun's and
Sam's tests and type checks. All four failures go to step 3. Penguin's codemod writes one commit into
each fork, on Jun's `analytics/weekly.py` and Sam's `messaging/reminders.py`. The next round passes
every check with no agent call
([bridge-and-runner.md](bridge-and-runner.md#resolution-ladder)).

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
checkpoint. It reads the invariants from main. It reads each evidence file where the trial tree of
the part covering the scope has it, as far as the Worker can tell without building the tree: the
file the part's patch writes, or the file at the part's fix commit when the fix changes it, then the
file at the checkpoint, then the file at the affected fork's head. A running feature's part is
preferred when two parts cover the scope. Without a plan on that checkpoint, Penguin reads the
checkpoint alone. The check runner checks the form again on the real trial tree. It answers at once with `accepted` or `refused` and every reason. A refused answer is
marked as a tool error so the agent fixes the form. The ProjectAgent keeps every well-formed form in
`FeatureReview`, keyed by feature and scope until merge plans give it a plan part. The form's text,
the reviewer's invariant names and the owner's statements come back inside `personWritten`.

The stored data rule needs the contract diff. The side-by-side run needs the scope's code run. Both
therefore happen on the check runner. A form that passes is kept `pending` with the checkpoint's
baseline on main. The answer says both checks are waiting for the runner. A form refused at
submission never reaches the runner.

#### Reviews on the runner

Runner mode claims pending reviews with `POST /reviews/claim`, as it claims combined runs. A claim
hands out up to 8 reviews and holds them for 30 minutes. An unreported review is handed out again
after that. A pending form that a part trial carries is left to that trial: the claim skips it
while the trial runs. The trial's report completes it ([Part trials](#part-trials)). A trial
whose tree does not build runs no review, so its forms go back to the claim. Each claimed review
names the feature's fork `feature-<id>`, the checkpoint, its
baseline, the scope and the form. The runner fetches the fork with a read token and runs the review
harness below on the baseline and the checkpoint. It reports the record to `POST /reviews/<id>`
(`review-run.ts`).

The ProjectAgent checks that the record names the review's own baseline, checkpoint and scope. It
then makes the review `accepted` or `refused` with the runner's refusals. It keeps the record in
`FeatureReview` with its `sha256:` reference (`review-record.ts`). The first report wins. A later
report of the same review answers 409. A record over 1 MiB of JSON keeps the first 100 differing
inputs and the first 100 inputs not run of each set. Its totals still count every input.

Routing (PRD 4.3 step 4) uses the stored form and the invariants checked at submission, never the
runner's own list of exceptions. When `reviewExceptions` raises one, the scope's owner gets a
`review_exception` inbox item for `<feature>/<scope>`.

#### Side-by-side runs on the runner

The runner's review (`penguin-bridge review`, [bridge-and-runner.md](bridge-and-runner.md#side-by-side-runs))
checks the form again against the fork's Git objects. It makes the contract diff with
`analysis:python-impact` and applies the stored data rule to its stored data shapes. It then runs
the scope's examples files and the form's risky inputs on main and on the fork through
`analysis:side-by-side`. Inputs reach the scope's code as JSON data built into the parameter types.
Each input is checked against the function's signature before any input runs.

In a part trial the base is the trial's target: main at the plan's baseline for a scope on main, or
the affected fork's head for a running feature. The fork is the trial tree. The harness reads the
scope's invariants, examples and contracts at the base, so the examples a running feature's owner
declares in that feature's fork run. On the helpful-fix fixture main declares no examples for
analytics and Jun's fork declares `analytics/examples/weekly_report.json`. A run on Priya's
checkpoint against main ran 0 inputs; the trial of Jun's part runs every case of that file
(`tests/integration/part-trial.test.ts`).

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
In runner mode, Jun's review submitted on Priya's feature gets this record with no manual run. The
tablet difference then reaches Jun's inbox (`apps/worker/test/review-runner.test.ts`).

#### Part trials

A part trial tests one revision of a plan part on the tree it would reach main as
(`packages/protocol/src/part-trial.ts`). The check runner claims trials with `POST /part-trials/claim`
under a 30-minute lease, up to 8 at a time. It fetches the originating fork, the target's repo and
the fix's repo with read tokens (`services/local-bridge/src/part-trial-run.ts`). It builds the trial
tree from Git objects alone, with no checkout and no ref (`trial-tree.ts`):

1. The target. A part for a running feature starts at the fork head its patch was written against,
   which is the head Penguin writes the fix onto once the part is approved. A part for a scope on
   main starts at main at the plan's baseline.
2. A patch is applied to that head, as the fix write applies it (`patch-tree.ts`).
3. The plan's originating checkpoint is merged in with `git merge-tree --write-tree`, as a land
   merges it.
4. A fix commit in the originating fork is applied on top as its own change against its base, with
   `git merge-tree --merge-base`: a cherry-pick of the fix without the rest of the fork.

Each commit is written with fixed identities and dates, so one trial gives one tree commit. A step
that does not apply makes the trial a `conflict`, with the reason and no tree. On a built tree the
runner runs `test:<scope>` for each of the part's scopes and the review harness for each form the
trial carries: the newest form of each of the part's scopes submitted on the plan's checkpoint that
passed its check at submission. The review compares the target with the trial tree.

The runner reports to `POST /part-trials/<id>`. Penguin keeps the report when it names its trial's
part, revision, checkpoint and target. The report must run each of the trial's test commands once
and review each of its forms once on the trial tree against the target. The first report wins; a second answers 409.
A report of a superseded trial answers 200 with `superseded` and is not kept. Each form the trial ran
that still waits as pending is completed with the trial's record. The exceptions are derived from the
stored form, the invariants checked at submission and the trial's side-by-side run. An exception
reaches the scope's owner as a `review_exception` item.

The recorded trial is the part revision's evidence for the checks of PRD 4.3 step 3
(`trialEvidence`). Its tests take the shape of the plan's facts-run results for the part, with
`fixInTree` true only for a built tree. Its reviews take the shape of the routing's review results.
A trial still running, one of another revision, or none gives no evidence.

The trial uses the plan's checkpoint. A later checkpoint of the originating feature is outside the
trial until a new plan is proposed on it. On the helpful-fix fixture Jun's and Sam's fixes import
`start_of_local_day`, which Priya adds in the commit after her plan's checkpoint, so their trials on
that checkpoint fail.

On the identity-unification fixture Jun's form can cite
`analytics/tests/test_identity.py::test_shared_device_split` and name the cutover marker
`analytics/retention.py::person_id_cutover`. Both exist only in Jun's fork with the fix of Jun's
part. The review of Priya's checkpoint refuses the form with `evidence_not_found`. The review on the
trial of Jun's part accepts it, with the stored data rule satisfied by the marker (`tests/integration/part-trial.test.ts`).

## Exceptions

People see only the exceptions in this table. Everything else proceeds without them.

| Exception | Goes to |
|---|---|
| A new feature starts in an area another running feature covers | The person whose agent works in that area; the start waits for their approval |
| A plan part fails a check of [Advance notice](#advance-notice) step 3 | That part's author, once |
| A plan touches a path its owner protects | That owner, who confirms the final lines |
| A review form reports a broken invariant, or a side-by-side run shows a difference on a protected invariant | That scope's owner |
| A check fails in an area with no tests and no type coverage | That scope's owner |
| Agents pass a fix back and forth past the project's round limit (default 3) | The originating feature's person |
| A plan has more parts needing a person than the break limit | The originating feature's person, to split it |

A plan part that needs its owner goes to them as a `plan_part` item. A part Penguin approved goes
to its owner as a `penguin_approved` item the owner may reverse. A protected path a part or the
feature's own change writes goes to that path's scope owner as a `protected_path` item. A part past
the round limit goes to the originating person as a `round_limit` item
([Advance notice in the build](#advance-notice-in-the-build)). A review exception goes to the
scope's owner as a `review_exception` item. The dashboard inbox shows the plan parts in one card per
merge plan with each shared review once. It lists a feature's own protected changes under Protected
paths and review exceptions under their own heading ([dashboard.md](dashboard.md#inbox)).

The overlapping start is built for features of two different people. The ProjectAgent puts it in
the covering person's inbox and tells that person's running sessions at their next safe checkpoint
([Step 3 in the build](#step-3-in-the-build)). The dashboard inbox lists it under Overlapping starts
with an Approve start control.

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
