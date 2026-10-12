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
5. **Break limit.** If a plan touches more running features than the project's limit (default 10),
   Penguin returns it to its author to split or restructure. The build counts the plan's behavioural
   parts ([Steps 1 to 5 in the build](#steps-1-to-5-in-the-build)).
6. **Waves.** The author splits a returned change into waves by parallel change, each its own
   feature and plan. The expand wave adds the new shape beside the old one and changes no existing
   symbol, so its plan has no place. Each migrate wave moves one scope or a small group onto the new
   shape as its own change. Its places are the other scopes on main that call what it changes. The
   running features inside the scopes it moves are same-area features, whose people approve its
   start. The contract wave removes the old shape. Its places are the callers left on main and in
   running features' own changes. [case-study-money.md](case-study-money.md) runs the waves on the
   money fixture.

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
- **Break limit.** The limit counts a plan's behavioural parts, the fixes an agent writes. Mechanical
  parts are left out, because Penguin's codemod writes them. `PENGUIN_PLAN_BREAK_LIMIT`, a Worker
  setting, sets the limit, 10 when unset. Any value other than a positive whole number refuses every
  plan as misconfigured. A plan over the limit gets a signed `plan_returned` record naming its
  behavioural places. The originating person gets a `plan_returned` inbox item.
- **Storing.** A complete plan is a signed `propose_plan` record listing each part. Its `Plan` and
  `PlanPart` rows live in the feature's FeatureAgent, the per-feature Durable Object.
  `plan-store.ts` is the one module that holds them. `GET /api/features/<id>/plan` answers the
  newest plan as JSON for the dashboard. A part's patch and changed lines (`diff.patch`, `diff.files`) go to the feature's person, the part's owner
  and that owner's delegate, the same rule the feature page applies (`mayReadPartLines` in
  `dashboard-views.ts`). For any other signed-in person both fields are null.
- **Limits.** A commit subject is cut at 300 characters, a docstring at 500 and an assertion or error
  line at 300. A note may hold 2,000 characters and a plan 128 parts. Penguin keeps every such string
  as data. The MCP answer puts each one inside `personWritten`.

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

#### Advance notice in the build

- **Delivery.** A stored plan reaches every author at once
  (`services/project-agent/src/plan-approval.ts`). Each part's owner gets a `plan_part` inbox item.
  That owner's running sessions hear of the part at their next safe checkpoint: the bridge hook's
  answer names it, `report_checkpoint` lists it under `newPlanParts` and `get_work` lists it under
  `planPartsNeedingYou` with the scopes to review. A newer plan of the same feature withdraws the
  older plan's items. Every item and record names the part it concerns as `<feature>/v<version>#<n>`.
- **Review.** The author's agent reviews the part with `submit_review` for each scope the part
  touches ([Review harness](#review-harness)). An agent never approves: no MCP tool approves a part.
- **Decision.** The author approves the part or asks for a change on the dashboard inbox, which
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
- **Routing.** `partRouting` (`packages/protocol`) takes the recorded review results of the
  originating feature and the scope map's protected paths. It counts the newest review of each scope
  the part touches. A broken invariant in an accepted form, a side-by-side difference on a protected
  invariant or a changed file under a protected path makes the part need its author in person. The
  dashboard lists each reason beside the part. With no reason, the agent's review stands and the
  author approves once.
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
  delegate with their changed lines and routing reasons. It also lists the parts that write a path
  the person protects, the features whose own change writes one, the parts of their plans past the
  round limit and the reviews of their scopes that raised an exception.
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
- **Preview.** An owner fetches the originating fork with an expiring read token through
  `penguin-bridge preview --feature <id>` ([bridge-and-runner.md](bridge-and-runner.md#preview)).
  Artifacts makes no new repo.

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
| `apply_fix` | Applies one deterministic fix: format, lint autofix, regenerate a lockfile, or a codemod for a rename, move or signature change |
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
Python names. By hand, `penguin-bridge apply-fix` applies one fix and `penguin-bridge resolve` runs
the checks with the ladder ([bridge-and-runner.md](bridge-and-runner.md#resolution-ladder)).

Each call is an `AgentToolRun` row: the feature, the session, the caller's identity, the tool, its
input, its answer and its duration. The feature page and demos read the rows. Their count per
resolved failure is the agent calls metric of PRD section 11.

#### Tools on the runner

Runner mode claims waiting requests with `POST /tool-runs/claim`, as it claims reviews. A claim hands
out up to 8 requests and holds them for 30 minutes. An unreported request is handed out again after
that. Each claimed request names the feature's fork `feature-<id>`, the checkpoint, its baseline, the
caller's charter and the other running features' forks. Each of those forks comes with its person
and latest checkpoint. Every running feature is listed, so a person who runs several features has
each one merged and checked.
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
| 3 | Mechanical interface change: rename, move, added parameter with a default | Penguin applies a codemod generated from the contract diff |
| 4 | Behaviour change inside the agent's charter | The originating agent adapts, with the failing check and the changed lines attached |
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
checkpoint. It reads the invariants from main and each evidence file from the fork at that
checkpoint. It answers at once with `accepted` or `refused` and every reason. A refused answer is
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
after that. Each claimed review names the feature's fork `feature-<id>`, the checkpoint, its
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

A plan part goes to its owner as a `plan_part` item, a protected path a part or the feature's own
change writes to that path's scope owner as a `protected_path` item and a part past the round limit
to the originating person as a `round_limit` item
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
