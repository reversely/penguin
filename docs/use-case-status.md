# Use case status

This page tracks each use case, step by step, against what `main` does. Each row cites the run or
test that shows the step working, or the ticket that covers the gap. It is updated after each merge
that touches a step.

States: **works** (a run or test shows it), **partial** (works with a stated limit), **gap** (does
not work yet), **rule needed** (the procedure does not yet say what should happen).

Cases 1 to 4 run in order on one build of Larder, the money-minor-units fixture. "Larder run" is
the preview seed's run of the four cases (`scripts/preview/seed.ts`), checked by
`tests/cases/cases.test.ts` ([fixture-money.md](fixture-money.md#cases-1-to-3-on-the-preview-seed)).

## Case 1: shopper accounts (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Open: Priya's `accounts-merge` starts from `base` with no start to approve | works | Larder run |
| Plan: five parts, analytics' and messaging's code on main, Jun's `cohort-ltv`, Sam's `weekly-digest` and loyalty's verify part | works | Larder run: the plan's feature places are the two forks Priya's agent writes into |
| Sam's parts go to Priya while the plan names no backfill | works | Larder run: the plan at `checkpoint` routes both of Sam's parts to Priya as `stored_data`; no one decides that plan |
| Priya's agent adds the backfill and proposes again; Penguin approves Sam's parts; Sam is told | works | Larder run: the plan at `backfill` names `accounts/backfill.py::backfill_shopper` as its store marker (#168) |
| Jun's kiosk invariant routes to Jun; Jun asks for a limit, then a lower one | works | Larder run: two `request_plan_change` records by Jun, answered by `limit-five` and `limit-one` |
| Jun's cohort report part approved by Penguin once the second revision passes | works | Larder run: the part is trialled on `limit-one` and its form holds (#169) |
| Jun's analytics part for code on main | partial | Jun approves it in person after `limit-one`. Jun's form names the cutover marker in Jun's fork, which the trial of analytics' code on main does not hold, so the review is refused with `evidence_not_found`. PRD case 1 counts Jun twice |
| Loyalty's verify part approved by Penguin; Lena is told | works | Larder run |
| Fixes written into Jun's and Sam's forks | partial | The seed reports the fixture's commits as checkpoints of those forks once their parts are approved; it makes no `fix_write` record (#171) |
| Land as one block | partial | The seed moves main to the feature's head once every part is approved, with no block check (#171) |

## Case 2: the helpful fix (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Open: Hugo's `structured-logs` starts from main after case 1 | works | Larder run. Noor's `pagination` declares `platform`, so Noor approves the start |
| Plan proposed at `local-day`, once `start_of_local_day()` exists | works | Larder run: parts for `holiday-closures` and `weekly-digest` |
| A test a fork already fails is not charged to the change | works | Larder run: `japan-launch` fails its yen test on its own head, so the facts run leaves it out and the plan has no part there (#170) |
| Elif's and Sam's parts approved by Penguin; no one asked; both told | works | Larder run: both trials pass and both forms hold |
| Forms filled in headless | works | Live check `tests/e2e/review-task-run.test.ts` (#138), on the helpful-fix fixture |
| Fixes written and land as one block | partial | As in case 1 (#171) |

## Case 3: the dependency bump (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Open: Hugo's `dependency-audit` starts from main after case 2 | works | Larder run. Noor approves the start beside `pagination` |
| Dependency diff names `instant-payouts` and `tip-jar` | works | Larder run: the agent's `check` names the places those two forks import the upgraded client. It also names Hugo's own `retry-budget` and `rounding-mode` in platform |
| Kofi's and Priya's parts approved by Penguin; no one asked; both told | works | Larder run |
| Fixes written and land as one block | partial | As in case 1 (#171) |

## Case 4: money in minor units (split)

The Larder run carries the fixture's one split feature from open to contract after cases 1 to 3
(`tests/cases/cases.test.ts`, [fixture-money.md](fixture-money.md#the-split-on-the-preview-seed)).

| Step | State | Evidence or ticket |
|---|---|---|
| Overlapping start approved | works | Ines's start waits on Hugo's rounding-mode and Tomas's three orders features; each approves (preview seed). The decline is #88 on the fixture |
| Fixture modelled as one split feature | works | `money-minor-units` holds the expand and the contract; nine blocks hold each owner's code on main (#118) |
| Sort of the first checkpoint | works | The first checkpoint is the expand, so Penguin sorts 25 additive entries. The plan Ines's agent proposes there declares the six float functions retiring. Penguin checks that each exists on main, has callers outside Ines's scopes and has its replacement in the checkpoint, then records the split from the declaration at that checkpoint; the retiring contracts are that split's, retired with the plan's rules when the expand reaches main (`tests/cases/cases.test.ts`, `money-split.test.ts`, #149). The `Expand first` answer for an incompatible checkpoint is #116's own test |
| Expand promoted on its own | partial | The preview seed moves main to the expand; the walkthrough lands it with `land_feature` and `expand: true`, which asks Tomas once for orders. #115 live proof on helpful-fix data |
| Retire: new float calls get the replacement as next step | works | Noor's pagination: step 4 to its builder for `line_total`, step 3 to Penguin for `display` (`tests/cases/cases.test.ts`) |
| Migrate: migration parts proposed per owner group | works | After the expand's count (84 callers) Penguin proposes 10 plans with 32 parts; pagination joins Noor's plan with 3 uses |
| Rule-written parts approved by Penguin | works | 1 of 10 approved with no form: Kofi's `instant-payouts`. 9 fail their scope's tests on the trial tree and become edit tasks with the failing check (#139) |
| Migration edits run by each owner's steward or builder | partial | 32 edit tasks. The preview seed writes each from the fixture: each reader's builder reports its migration, each owner's steward writes the block. No bridge ran them on the fixture (#129). Each reader's task names the reader's own builder, `@<person>/<feature>`, the identity its agent session runs as (#145) |
| Each migration plan lands as its own block | works | Penguin lands each of the nine blocks once its parts are written; the check runner checks and promotes it. The count after each drops from 84 to 36, 33, 25, 23, 15, 11, 5, 2 and 0. Tomas's plan holds only running features and closes once they are written. A count of an earlier promotion reported after an owner's block landed opens no second plan for that block's scopes, so each owner has one plan (#146) |
| Rahul's tax part routes to Rahul | works | Review on the tax block: 1633 of 5000 orders differ on the whole-order step and the broken `tax-per-line` invariant reaches Rahul; 10 differ on the per-line revision and the review holds |
| Stored data marker for tax | works | Tax only reads `orders.model.Line` and stores nothing derived; the expand changes no stored shape, so no marker is needed (`tests/test_fixtures.py`) |
| Jun confirms the protected revenue report | partial | Jun's own steward writes the analytics block, so the change is Jun's own and no confirmation is asked. #112 covers another person's change |
| Contract when no caller is left | works | Penguin proposes the contract on Ines's feature per defining package, once every retiring function there reaches zero callers, its own module and tests aside (#144, #150): `orders` after Noor's block, `shared/money` after Lena's, one `contract_proposed` record each. Ines's contract checkpoint removes the six with their own tests, lands and closes all six retiring records |
| Contract after the originating feature has landed | works | `tests/rules/migration.test.ts`. Not reached on the fixture: Ines's feature still runs at zero, so the preview seed opens no carrier |
| Dropped parts and empty blocks | works | A dropped migration part closes its open edit tasks as `dropped` with the reason; a block Penguin opened left with no part on main is closed, its tasks dropped and its locks released, with its fork kept read-only (`tests/rules/migration.test.ts`, #150). On the preview seed no task is open after the last block and all nine blocks land, so none closes |
| Walkthrough runs the split | partial | `npm run walkthrough` follows the expand, migrate and contract steps for case 4 |
| Runner fetches 40 forks | works | #119 live proof (20 forks) |

## Across cases

| Question | State | Ticket |
|---|---|---|
| Who makes an edit when no session is open | gap | #128, #129 |
| Does the stored-data rule apply to every reviewing scope or only those that read the changed data | works | Only those that read it, per the impact graph of the reviewing scope (#126) |
| Who carries the marker for stored data | works | The change that owns the store declares a migration or backfill once (`storeMarker`), covering every scope that only reads it. A scope that persists derived data names its own cutover marker. Without the owner's marker, a reader's part goes to the originating person (#132) |
| Does a combined run test the changing person's own dependent scope | works | Yes, on the checkpoint itself with no merge. The scheduler schedules a run of the changer's own dependent scopes, and the scheduled runs and the agent `check` tool name the changer. On the helpful fix Priya is DRI for `ingestion` and `shared-dates`: her checkpoint runs the `ingestion` tests and passes, in a scheduled run and in a `check`, and a change that sends `start_of_day` back to local midnight fails them (#147, #155, `tests/test_analysis.py`, no test yet (docs/testing.md), no test yet (docs/testing.md)) |
| How a plan covers an affected place that needs no change | works | A verify part with no diff: `{ place, verify: true }`. Its trial runs the scope's tests on the checkpoint merged onto the place, and Penguin approves it when they pass; otherwise it needs a fix like any other part. On the money fixture, Decimal rates in `tax/rates.py` leave tax-filing passing and Penguin approves its verify part; the same change without Washington fails the trial (#148, `tests/cases/cases.test.ts`) |
| May a plan's patch use a symbol its checkpoint does not have | works | No: `propose_plan` answers `patch_missing_symbol` naming the symbol and the next step. On the helpful fix, a plan at Priya's first checkpoint names `start_of_local_day` for both patches (#132, `tests/cases/cases.test.ts`) |
| Two plans writing into the same fork at once | works | Writes into one fork go one at a time in the order they opened: fix writes, rule-written migration writes and migration edit task runs alike. After a write, each other waiting part is tried again on the new head. It is written on top when the trial passes. Otherwise a plan part goes back to its originating agent with the conflict and a migration part becomes an edit task. A migration edit task's claim waits while another write holds its fork. A block run whose target fork took a fix after the run named its head is checked again (no test yet (docs/testing.md), `tests/rules/migration.test.ts`, no test yet (docs/testing.md), #133, #142). On the money fixture's split no fork takes two writes: each reader and each block takes one migration. The preview seed writes each from the fixture, not through the bridges' claims, so it measures no wait (#118) |
| A failed runner pass holds its run 30 minutes | works | The pass reports the failure and Penguin frees the run at once for any runner; the third failure goes to the feature's person (no test yet (docs/testing.md), no test yet (docs/testing.md)). Not yet run in the walkthrough |
| Signed records in a record repo | works | Project setup makes `record`. A few seconds after each record is stored, Penguin commits every waiting record at `records/<feature>/<author>-<writer>-<seq>.json` in one push with its own short-lived write token. Order holds across batches and a failed push retries without a duplicate (no test yet (docs/testing.md)). Live through local `wrangler dev`: after a land, every record on the feature page is in the repo, cloned with a bridge's read token (`tests/e2e/record-repo.test.ts`, #123) |
| Reads derived from the code, readable at hundreds of scopes | gap | #134 |
| Teams own scopes; each scope names a DRI and a fallback order | works | `penguin/teams.json` parses; a scope that names only an owner reads as a one-person team, so every example fixture routes to its owner as before (`tests/rules/routing.test.ts`). Plan parts, review forms, review exceptions and protected paths go to the DRI, then down the fallback order (`tests/rules/routing.test.ts`, on `tests/fixtures/team-scopes`). Every use-case fixture declares `penguin/teams.json`: the money case's fourteen people in four teams, DRI for two or three of 29 scopes each, with one steward per person and one builder per feature (#130) |
| Teams above people (an engineering manager's view) | works | The API carries each team, its scopes with their DRIs and the lead's read-only exceptions (#135). The org, team and person pages show them, with the viewer's team as the landing page: each member's features by stage, their steward's own queue, what waits on them and each scope's health (`tests/rules/stages.test.ts`, #136) |
