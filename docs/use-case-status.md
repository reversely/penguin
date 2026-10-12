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
| Sam's parts approved by Penguin | gap | Both reviews refused with `stored_data_without_marker` (#126) |
| Jun's tablet invariant routes to Jun; two revisions | works | Walkthrough case 1, frames 05 to 07 |
| Fixes written into Jun's and Sam's forks | works | #91, walkthrough frame 08 |
| Land as one block | works | Walkthrough case 1 promoted, main green |

## Case 2: helpful fix (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Sort: `start_of_day` behaviour change, merge plan kept | works | #116 fixture test |
| Plan proposed after `start_of_local_day()` exists | gap | Plan proposed one checkpoint early; trials fail (#126) |
| Jun's and Sam's parts approved by Penguin | gap | Blocked by the row above (#126) |
| Land as one block | works | Walkthrough case 2 promoted |

## Case 3: dependency bump (merge plan)

| Step | State | Evidence or ticket |
|---|---|---|
| Dependency diff finds Ana's imports; side-by-side shows the double charge | works | #93, #98 |
| Ana's part approved | partial | Needs a trial pass (#122 merged; not yet run on case 3) |
| Land as one block | gap | The dependency check never passes (#121) |

## Case 4: money in minor units (split)

| Step | State | Evidence or ticket |
|---|---|---|
| Overlapping start: one approved, one declined | works | #88 on the fixture |
| Sort: `display()`, `price()`, `total()` incompatible; next step "Expand first" | works | #116 fixture test |
| Expand promoted on its own | works | #115 live proof (on helpful-fix data) |
| Fixture modelled as one split feature | gap | The fixture still models hand-built waves (#118) |
| Retire: new float calls get the replacement as next step | works | #113, Noor's pagination |
| Migrate: migration parts proposed per owner group | rule needed | Penguin computes the groups (`migrationGroups`) but nothing proposes the plans (#131) |
| Migration edits run by each owner's steward or builder | gap | #128, #129 |
| Rahul's tax part routes to Rahul | works | #107, #122 |
| Jun confirms the protected revenue report | works | #112 |
| Contract when no caller is left | partial | #117 counts callers after each promotion and proposes at zero; the money fixture still has 59 callers after the waves (14 on main, 45 in readers' own changes), moved by #131 |
| Contract after the originating feature has landed | rule needed | #131 (steward of the defining scope's DRI) |
| Runner fetches 40 forks | works | #119 live proof (20 forks) |

## Across cases

| Question | State | Ticket |
|---|---|---|
| Who makes an edit when no session is open | gap | #128, #129 |
| Does the stored-data rule apply to every reviewing scope or only those that read the changed data | rule needed | #132 |
| May a plan's patch use a symbol its checkpoint does not have | rule needed | #132 |
| Two plans writing into the same fork at once | rule needed | #133 |
| A failed runner pass holds its run 30 minutes | gap | #120 |
| Signed records in a record repo | gap | #123 |
| Reads derived from the code, readable at hundreds of scopes | gap | #134 |
| Teams above people (an engineering manager's view) | gap | #135, #136 |
