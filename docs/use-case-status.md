# Use case status

This page tracks each use case, step by step, against what `main` does. Each row cites the run or
test that shows the step working, or the ticket that covers the gap. It is updated after each merge
that touches a step.

States: **works** (a run or test shows it), **partial** (works with a stated limit), **gap** (does
not work yet), **rule needed** (the procedure does not yet say what should happen).

## Case 1: identity unification (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Open: Priya's feature starts; Jun's and Sam's features listed as readers | works | Walkthrough case 1 (`docs/progress/100/identity-unification/`) |
| Sort: `person_id` additive; `resolve()`, `profile()` behaviour changes; merge plan kept | works | #116 fixture test |
| Plan: four parts stored from the fixture | works | #106 |
| Sam's parts approved by Penguin | partial | The stored-data rule is decided (#132). Messaging only reads `Profile`, which identity-map owns, so Sam's form needs no marker and is accepted on both of Sam's trials. Priya's change reshapes `Profile` (`attributes` becomes `by_identity`) and the fixture's commits hold no migration or backfill, so the plan declares no `storeMarker`. Both of Sam's parts therefore route to Priya as `stored_data` asks; Sam is not asked. Penguin approves them once Priya's change carries a backfill and the plan names it, or Priya approves them as they stand (`apps/worker/test/preview-approvals.test.ts`, `tests/integration/part-trial.test.ts`). PRD case 1 step 3 says "Penguin approves both of Sam's parts", which the fixture's data does not support |
| Jun's tablet invariant routes to Jun; two revisions | works | Walkthrough case 1, frames 05 to 07. In the preview, Jun's form is accepted on the trial of Jun's own part with the cutover marker it names, and the broken invariant routes both of Jun's parts to Jun (#126) |
| Fixes written into Jun's and Sam's forks | works | #91, walkthrough frame 08 |
| Land as one block | works | Walkthrough case 1 promoted, main green |

## Case 2: helpful fix (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Sort: `start_of_day` behaviour change, merge plan kept | works | #116 fixture test |
| Plan proposed after `start_of_local_day()` exists | works | The plan is proposed at `owner-priya-local-day` (#126, `apps/worker/test/preview-approvals.test.ts`) |
| Jun's and Sam's parts approved by Penguin | works | Preview: 2 of 2 parts approved by Penguin; both trials pass and both forms hold (#126) |
| Jun's and Sam's forms filled in headless, with no one asked | works | Live check `tests/e2e/review-task-run.test.ts` (#138): with no steward session running, each author's bridge ran `claude -p` (haiku). Each run sent its form through Penguin's MCP server with its task token. Penguin refused Jun's first form for a line range as evidence. The run fixed it and submitted again. Both forms were accepted, both trials passed and Penguin approved 2 of 2 parts with no author asked |
| Land as one block | works | Walkthrough case 2 promoted |

## Case 3: dependency bump (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Dependency diff finds Ana's imports; side-by-side shows the double charge | works | #93, #98 |
| Ana's part approved by Penguin; Ana told | works | Preview seed of case 3: the trial passes `test:payments` and accepts Ana's form, Penguin approves the part and Ana gets a `penguin_approved` item |
| Land as one block | works | `tests/integration/dependency-bump-block.test.ts`: with Ana's fix in Ana's fork every check passes; the dependency diff is a passing fact. Without the fix the block fails on Ana's test alone. Not yet run in the walkthrough |

## Case 4: money in minor units (split)

| Step | State | Evidence or ticket |
|---|---|---|
| Overlapping start: one approved, one declined | works | #88 on the fixture |
| Sort: `display()`, `price()`, `total()` incompatible; next step "Expand first" | works | #116 fixture test |
| Expand promoted on its own | works | #115 live proof (on helpful-fix data) |
| Fixture modelled as one split feature | gap | The fixture still models hand-built waves (#118) |
| Retire: new float calls get the replacement as next step | works | #113, Noor's pagination |
| Migrate: migration parts proposed per owner group | works | After the `money-type` expand's count (98 callers) Penguin proposes 11 plans with 34 parts. After the last migrate wave (59 callers) 10 plans hold 25 live parts, which cover all 59 callers: Ade 2, Ines 1, Jun 3, Kofi 2, Mei 3, Noor 2, Priya 3, Rahul 2, Sam 3, Tomas 4 (`apps/worker/test/money-migration.test.ts`, #131) |
| A later caller joins its owner's open plan | works | Noor's pagination checkpoint adds 3 uses; its retiring-calls check adds the place to Noor's open plan under one `migration_joined` record. Once a plan landed, a later place opens the owner's next plan (`services/project-agent/test/migration-plans.test.ts`) |
| Rule-shaped parts written by the runner | works | The runner's rewrite of each place leaves no use in 10 of the 25 parts; their patches are the parts' fixes and each is tried on its trial tree |
| Rule-shaped parts approved by Penguin | rule needed | 0 of 10 approved. 9 fail their scope's tests on the trial tree: the `display` rule rewrites `money.display(amount)` to `amount.display()` where `amount` is still a float (store-league), so a rule that leaves no use can still break. They go to their owners in person. Kofi's instant-payouts part passes `test:payouts` and waits for the payouts review form, which no steward has sent. The PRD does not say whether a failing rule-shaped part goes to its owner or back to an agent as an edit task, nor whether a Penguin-written part needs a review form |
| Migration edits run by each owner's steward or builder | partial | 15 of the 25 parts (16 with pagination) are `migration` edit tasks: each running feature's own changes to its builder, the money and orders scopes on main to Ines's and Tomas's stewards in the plans' block features. No bridge ran them on the fixture (#129) |
| Each migration plan lands as its own block | gap | Each plan names its block feature and Penguin opens it from main for code on main; no promotion moves that block to main yet. A plan with only running-feature places has no code of its own for a block |
| Rahul's tax part routes to Rahul | works | #107, #122 |
| Clean wave parts approved by Penguin | works | Preview: Lena's promotions part and Mei's invoicing part, 2 of 2, with the fixture's forms and each scope's own tests inside its place (#126, `apps/worker/test/money-waves.test.ts`) |
| Jun confirms the protected revenue report | works | #112 |
| Contract when no caller is left | partial | #117 counts callers after each promotion and proposes at zero; the money fixture still has 59 callers after the waves (14 on main, 45 in readers' own changes); #131 puts every one of them in a migration plan. No plan has reached main yet |
| Contract after the originating feature has landed | works | Penguin opens `contract-<owner>-<feature>` from main for the DRI of each defining scope, signs a no-places `contract_proposed` there approved by Penguin and gives the removal to that DRI's steward as a `contract` edit task (`services/project-agent/test/migration-plans.test.ts`). Not reached on the fixture: callers remain |
| Runner fetches 40 forks | works | #119 live proof (20 forks) |

## Across cases

| Question | State | Ticket |
|---|---|---|
| Who makes an edit when no session is open | gap | #128, #129 |
| Does the stored-data rule apply to every reviewing scope or only those that read the changed data | works | Only those that read it, per the impact graph of the reviewing scope (#126) |
| Who carries the marker for stored data | works | The change that owns the store declares a migration or backfill once (`storeMarker`), covering every scope that only reads it. A scope that persists derived data names its own cutover marker. Without the owner's marker, a reader's part goes to the originating person (#132) |
| May a plan's patch use a symbol its checkpoint does not have | works | No: `propose_plan` answers `patch_missing_symbol` naming the symbol and the next step. On the helpful fix, a plan at Priya's first checkpoint names `start_of_local_day` for both patches (#132, `tests/integration/plan-from-fixture.test.ts`) |
| Two plans writing into the same fork at once | rule needed | #133 |
| A failed runner pass holds its run 30 minutes | works | The pass reports the failure and Penguin frees the run at once for any runner; the third failure goes to the feature's person (`services/project-agent/test/run-failures.test.ts`, `services/local-bridge/test/run-failure.test.ts`). Not yet run in the walkthrough |
| Signed records in a record repo | gap | #123 |
| Reads derived from the code, readable at hundreds of scopes | gap | #134 |
| Teams own scopes; each scope names a DRI and a fallback order | works | `penguin/teams.json` parses; a scope that names only an owner reads as a one-person team, so every example fixture routes to its owner as before (`packages/scope-map/test/teams.test.ts`). Plan parts, review forms, review exceptions and protected paths go to the DRI, then down the fallback order (`services/project-agent/test/teams.test.ts`, on `tests/fixtures/team-scopes`). Not yet in a use-case fixture (#130) |
| Teams above people (an engineering manager's view) | partial | The API carries each team, its scopes with their DRIs and the lead's read-only exceptions (#135). The views are #136 |
