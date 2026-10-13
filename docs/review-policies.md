# Review policies

A review policy sets who decides each type of approval in one sandbox: Penguin or a person. A sandbox
is one Penguin project, its base repo and the forks its agents work in. A team lead picks a preset
for the sandbox and may change single rows. The kinds of validation behind each row are defined in
[validation.md](validation.md).

## Rows

| Type of approval | Kind | A part or start of this type |
|---|---|---|
| Logic | Logic | The review form reports an invariant not holding, or the check runner refused the form |
| Data matching | Data matching | The side-by-side run differs on a protected invariant |
| Stored data | Stored data | A changed stored shape has no migration or backfill in the plan |
| Protected paths | Protected paths and place | The fix touches a path a scope's owner protects |
| Place | Protected paths and place | The fix reaches outside the part's scopes |
| Overlapping starts | Overlapping starts | A feature's start overlaps another person's running feature |

Tests are no row. A failed test always goes back to the agent. Penguin approves no part whose tests
have not passed.

## Presets

| Preset | Logic, Data matching, Stored data, Protected paths, Place | Overlapping starts | Every other part |
|---|---|---|---|
| Throwaway | Penguin, which tells the owners | Penguin | Penguin |
| Dev, the default | Person | Person | Penguin |
| Production | Person | Person | Person |

Dev is Penguin's rule from before policies: Penguin approves a part only when every check is clean.
Production sends every part to a person, as `PENGUIN_PLAN_ADMIN_MODE=on` does. A sandbox that changes
a row keeps its preset's name with "changed" after it, such as "Dev policy, changed". Under
Production every part still goes to a person whatever its rows say.

## Changing the policy

- **Who.** Only a lead of a team declared in `penguin/teams.json` changes the policy. A one-person
  team, the reading of a scope that names only `owner`, has no lead for this purpose.
- **How.** The lead posts `POST /api/review-policy` with `{ preset, rows }` from the dashboard. The
  Worker takes the person from the session and refuses a body with any other field. The ProjectAgent
  refuses a person who leads no team and a row that is not `penguin` or `person`.
- **Record.** Each change is a signed `review_policy_changed` record authored by the lead, with
  `old`, `new` and `changed_by`. It is kept under `records/_project/`, a folder no feature id can
  name. It goes to the record repo with the feature records.
- **When it applies.** The new policy applies to the parts and starts decided after it. Penguin reads
  every pending part again at once under it.
- **Admin mode.** While `PENGUIN_PLAN_ADMIN_MODE` is `on` the policy is Production, locked. The
  dashboard shows it locked and every change is refused.

## Reading the policy

The ProjectAgent reads the newest `review_policy_changed` record whose signature verifies with the
service key and whose `changed_by` is its author. A record that fails either check is refused. The
record before it stands. With no record, the policy is Dev. The ProjectAgent keeps the policy it
read until a newer record is stored, so each decision costs one lookup of the newest record id.

## Where Penguin applies it

| Decision | Code | Under the policy |
|---|---|---|
| A plan part | `approveCleanParts` in `plan-approval.ts` | Penguin approves a pending part whose route names Penguin |
| A rule-written migration part after its trial | `migrationTrialReported` in `migration-plans.ts` | A failing trial still becomes an edit task. A type set to Penguin no longer sends the part to a person; Production sends a part whose trial passed to one |
| An overlapping start | `checkOverlap` in `overlap-lock.ts` | With Overlapping starts set to Penguin, Penguin approves each new lock at once with a signed `approve_overlap` record that names the owner. No one is asked |

The break limit counts the parts that fail a check when a plan is proposed, whatever the policy.

## Measured split

`GET /api/review-policy` answers the policy, whether it is locked, who changed it last and when,
whether the signed-in person may change it and the split over the last 30 days. The split counts the
`approve_plan_part`, approved `migration_part_decided` and `approve_overlap` records stored in that
window: parts and starts Penguin approved and those people approved, overall and per type of approval
that marked them. `teams` gives the same split for each declared team, counting the parts and starts
its members own.
