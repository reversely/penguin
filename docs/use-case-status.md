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
| Migrate: migration parts proposed per owner group | works | After the `money-type` expand's count (84 callers) Penguin proposes 10 plans with 32 parts. After the last migrate wave (45 callers) 9 plans hold 23 live parts, which cover all 45 callers: Ade 2, Jun 3, Kofi 2, Mei 3, Noor 2, Priya 3, Rahul 2, Sam 3, Tomas 3 (`apps/worker/test/money-migration.test.ts`, #131) |
| The defining scope's own uses are no callers | works | A use in a retiring symbol's defining module, or in a test file of the scope that holds it, is not counted and makes no part. The contract step removes it with the symbol; uses in the scope's other files still count (#144, `packages/protocol/test/retiring.test.ts`, `services/project-agent/test/retiring-count.test.ts`). On the fixture the money scope's tests hold 10 such uses (`test_money.py`, `test_discounts.py`) and the orders scope's `test_model.py` holds 4, of `line_total()` and `order_total()`. They were Ines's and Tomas's parts on main; neither plan has a part on main now (`apps/worker/test/money-retiring.test.ts`) |
| A later caller joins its owner's open plan | works | Noor's pagination checkpoint adds 3 uses; its retiring-calls check adds the place to Noor's open plan under one `migration_joined` record. Once a plan landed, a later place opens the owner's next plan (`services/project-agent/test/migration-plans.test.ts`) |
| Rule-shaped parts written by the runner | works | The runner's rewrite of each place leaves no use in 10 of the 23 parts; their patches are the parts' fixes and each is tried on its trial tree |
| Rule-written parts approved by Penguin with no review form | works | Each trial runs the part's scopes' tests and, with no form, each scope's side-by-side run over its declared examples (#139). Of the 10 rule-written parts after the last wave, Penguin approves 1: Kofi's `instant-payouts` passes `test:payouts` with no protected difference. The check runner's write of it into Kofi's fork is queued (`apps/worker/test/money-migration.test.ts`) |
| A failing rule-written part becomes an edit task | works | The other 9 fail their scope's tests on the trial tree. In `store-league` the `display` rule rewrites `money.display(amount)` to `amount.display()` while `amount` is still a float. Each of the 9 becomes a `migration` edit task for the feature's builder with the failing test attached. None reaches a person: a part reaches one only when its edit task's run fails (`services/project-agent/test/migration-plans.test.ts`) |
| Migration edits run by each owner's steward or builder | partial | After the last wave 22 of the 23 parts are `migration` edit tasks (23 of 24 with pagination): 13 the rules do not write in full and 9 from a failed trial. Each running feature's own changes go to its builder. No part on main is left after the waves. No bridge ran them on the fixture (#129) |
| A migration plan of running features closes when every fix is written | works | A plan whose places are all running features opens no block. It is `closed` once every live part is written into its fork: by the check runner for an approved part, by a kept edit task commit otherwise (`services/project-agent/test/migration-plans.test.ts`). No plan closes on the fixture: no bridge ran the edit tasks |
| Each migration plan with code on main reaches main as its own block | partial | Penguin opens the plan's block feature from main for code on main. The runner's write or the steward's commit goes into it. Once every part on main is written, Penguin lands the block itself. The plan is `landed` when that block reaches main. No block reaches main on the fixture (next row) |
| Features Penguin opens go through the overlap lock | works | A block feature or contract carrier is checked at its opening and at each wider area. While a lock holds its start, no edit task into its fork is claimed and the runner writes nothing there (`services/project-agent/test/migration-plans.test.ts`). On the fixture each block feature Penguin opens gets an overlap check. None of the checks opens a lock (`apps/worker/test/money-migration.test.ts`) |
| Rahul's tax part routes to Rahul | works | #107, #122 |
| Clean wave parts approved by Penguin | works | Preview: Lena's promotions part and Mei's invoicing part, 2 of 2, with the fixture's forms and each scope's own tests inside its place (#126, `apps/worker/test/money-waves.test.ts`) |
| Jun confirms the protected revenue report | works | #112 |
| Block feature lands once every part is written | partial | Penguin records the fork's head as the block's checkpoint and asks for the land with no agent, with the charter of the steward of the block's person. Each head gets one block run; a failed block's next steps go to that steward (`services/project-agent/test/penguin-land.test.ts`). On the fixture the plans with code on main after the expand (refunds, analytics, payouts, promotions, invoicing, mobile-api, checkout, tax and messaging) lose those parts as the waves migrate the scopes. Before #144, Ines's money part and Tomas's orders part were left, both holding only the float functions' own tests. Since #144 those uses are the contract step's, so after the last wave no plan holds code on main and no block is asked to land. A ready block or carrier whose fork main moved past is rebuilt from main, never merged: Penguin forks it again from main's head, re-applies each written part's patch or kept commit and tries it again; a passing trial is written by the check runner, a failing one or a commit that is no plain text patch becomes the steward's edit task, and a carrier's removal task opens again (#143, `services/project-agent/test/penguin-land.test.ts`). On the fixture no rebuild happens: the nine block features and the `percent_off()` carrier are all behind main, but none is ready. The blocks carry no part and the carrier's removal task is open (`apps/worker/test/money-migration.test.ts`) |
| Contract when no caller is left | partial | #117 counts callers after each promotion and proposes at zero. Since #144 the count leaves out each symbol's own module and its scope's tests. On the fixture `percent_off()` reaches zero at the count after the `money-checkout` wave, which moved its caller in promotions: its 6 remaining uses are all in the money scope's tests. The other five float functions have 0 callers on main after the waves and 45 in readers' own changes, which #131 puts in migration plans; their count reaches zero once those readers move (`apps/worker/test/money-retiring.test.ts`) |
| Contract after the originating feature has landed | works | Penguin opens `contract-<owner>-<feature>` from main for the DRI of each defining scope, signs a no-places `contract_proposed` there approved by Penguin and gives the removal to that DRI's steward as a `contract` edit task (`services/project-agent/test/migration-plans.test.ts`). Once the removal is done and its checkpoint's facts are in, Penguin lands the carrier itself. Its promotion closes the removed symbols (`services/project-agent/test/penguin-land.test.ts`). On the fixture Penguin carries `percent_off()` in `contract-ines-money-type`, with a `contract` task for Ines's steward naming `shared/money/tests/test_discounts.py` and `test_money.py`. The fixture holds no commit that removes `percent_off()` alone, so the task stays open (`apps/worker/test/money-migration.test.ts`) |
| Runner fetches 40 forks | works | #119 live proof (20 forks) |

## Across cases

| Question | State | Ticket |
|---|---|---|
| Who makes an edit when no session is open | gap | #128, #129 |
| Does the stored-data rule apply to every reviewing scope or only those that read the changed data | works | Only those that read it, per the impact graph of the reviewing scope (#126) |
| Who carries the marker for stored data | works | The change that owns the store declares a migration or backfill once (`storeMarker`), covering every scope that only reads it. A scope that persists derived data names its own cutover marker. Without the owner's marker, a reader's part goes to the originating person (#132) |
| May a plan's patch use a symbol its checkpoint does not have | works | No: `propose_plan` answers `patch_missing_symbol` naming the symbol and the next step. On the helpful fix, a plan at Priya's first checkpoint names `start_of_local_day` for both patches (#132, `tests/integration/plan-from-fixture.test.ts`) |
| Two plans writing into the same fork at once | works | Writes into one fork go one at a time in the order they opened: fix writes, rule-written migration writes and migration edit task runs alike. After a write, each other waiting part is tried again on the new head. It is written on top when the trial passes. Otherwise a plan part goes back to its originating agent with the conflict and a migration part becomes an edit task. A migration edit task's claim waits while another write holds its fork. A block run whose target fork took a fix after the run named its head is checked again (`services/project-agent/test/fork-turns.test.ts`, `services/project-agent/test/migration-plans.test.ts`, `services/project-agent/test/block-land.test.ts`, #133, #142). On the money fixture no fork takes two writes. After pagination's second checkpoint each person's bridge claims its migration edits: 32 forks (24 running features and 8 block features) take one write each, 31 edit task runs and Kofi's `instant-payouts` runner write. 18 runs hold their fork under the cap of two per person and no write waits (`apps/worker/test/money-migration.test.ts`). The one-block plan and the money-contract wave are both returned over the break limit, so no merge plan has a part in a reader's fork |
| A failed runner pass holds its run 30 minutes | works | The pass reports the failure and Penguin frees the run at once for any runner; the third failure goes to the feature's person (`services/project-agent/test/run-failures.test.ts`, `services/local-bridge/test/run-failure.test.ts`). Not yet run in the walkthrough |
| Signed records in a record repo | gap | #123 |
| Reads derived from the code, readable at hundreds of scopes | gap | #134 |
| Teams own scopes; each scope names a DRI and a fallback order | works | `penguin/teams.json` parses; a scope that names only an owner reads as a one-person team, so every example fixture routes to its owner as before (`packages/scope-map/test/teams.test.ts`). Plan parts, review forms, review exceptions and protected paths go to the DRI, then down the fallback order (`services/project-agent/test/teams.test.ts`, on `tests/fixtures/team-scopes`). Not yet in a use-case fixture (#130) |
| Teams above people (an engineering manager's view) | partial | The API carries each team, its scopes with their DRIs and the lead's read-only exceptions (#135). The views are #136 |
