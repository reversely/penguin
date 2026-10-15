# Review policies

Code ships through five stages: local development, central development, test, pre-production and
production. Penguin runs a sandbox where the work coding agents do in local development merges. A
sandbox is one Penguin project, its base repo and the forks its agents work in. A team can run a
sandbox at any of the five stages. The review policy names that stage. The stage sets who decides each
type of approval in the sandbox. A failed check goes back to the agent that made the change. An
update that passes either merges into the affected branch automatically (Auto-merge) or waits for
the worktree owner's review (Worktree owner reviews). Worktree owners review more at each stage nearer
production. A team lead picks the stage on the dashboard's Review policy page and may change single
rows. The kinds of validation behind each row are defined in [validation.md](validation.md).

## Rows

| Type of approval | Kind | A part or start of this type |
|---|---|---|
| Logic | Logic | The review form reports an invariant not holding, or the check runner refused the form |
| Data matching | Data matching | The side-by-side run differs on a protected invariant |
| Stored data | Stored data | A changed stored shape has no migration or backfill in the plan |
| Custom path rules | Custom path rules and place | The fix touches a path under a scope owner's custom path rule (`custom_paths` in `penguin/scopes.json`) |
| Place | Custom path rules and place | The fix reaches outside the part's scopes |

A part whose one failing condition is Stored data goes to the originating feature's person, not
the part's owner, when the Stored data row sends it to a person or the stage is Production. That
person's agent adds a migration or backfill to the change, or the person approves the part. The
part's route reads `Stored data needs a migration or backfill in the originating change`.

Tests are no row. A failed test always goes back to the agent. Penguin approves no part whose tests
have not passed. Overlapping starts are no row either: at every stage Penguin lets an overlapping
start open, records the overlap and tells the person who owns the running feature.

## Stages

The policy's presets are the stages of the release pipeline, from least to most human review. The
dashboard draws them in one row: Local development, Central development, Test, Pre-production,
Production. Test has no setting of its own: it shares Pre-production's.

| Stage | Logic, Data matching, Stored data, Custom path rules, Place | A rule-written migration part whose side-by-side run differs | Every other part |
|---|---|---|---|
| Local development | Auto-merge, worktree owner told | Auto-merge, worktree owner told | Auto-merge |
| Central development, the default | Worktree owner reviews | Edit task for an agent | Auto-merge |
| Test and Pre-production | Worktree owner reviews | Worktree owner reviews | Auto-merge |
| Production | Worktree owner reviews | Edit task for an agent, then the worktree owner reviews | Worktree owner reviews |

Central development is Penguin's rule from before policies: Penguin approves a part only when every
check is clean. On plan parts Pre-production routes exactly as Central development does. The two
differ in one place: a rule-written migration part whose trial passes its tests but whose
side-by-side run differs on a protected invariant. Central development sends it back to an agent as
an edit task. Pre-production sends it to its worktree owner for review (`migrationPolicyRoute` in `validation.ts`).
Production sends every part to its worktree owner whatever its rows say, as `PENGUIN_PLAN_ADMIN_MODE=on` does.
A sandbox that changes a row keeps its stage's name with "changed" after it, such as "Central
development policy, changed".

The stored names are `local_development`, `central_development`, `pre_production` and `production`.
Migration note: a policy or a route stored before #177 under `throwaway` or `dev` reads as
`local_development` or `central_development` (`readPreset` in `validation.ts`). The
`overlapping_starts` row such a policy names is ignored.

## Caller items

A caller item asks the receiving worktree's agent to confirm or approve before another feature's
change writes into its fork or reaches main. The
stage decides when the worktree owner sees items at all and how long an item waits on the agent
(`CALLER_STAGES` in `packages/protocol/src/caller-items.ts`):

| Stage | Worktree owner decides | Worktree owner is told | Wait for the agent |
|---|---|---|---|
| Local development | An item no test reaches, one the agent left unanswered and one rejected twice | Nothing else | 24 hours |
| Central development, the default | The same | Each open `broken` or `differs` item on their worktrees | 24 hours |
| Test and Pre-production | The same | The same | 8 hours |
| Production | Every item, after the agent's answer, plus the three above | The same | 4 hours |

An item past its wait goes to the worktree owner as unanswered. Under Production the agent's
confirmation or approval keeps the item open until the worktree owner approves it on the dashboard.
The rows above apply to every stage whatever its plan part rows say.

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
record before it stands. With no record, the policy is Central development. The ProjectAgent keeps the policy it
read until a newer record is stored, so each decision costs one lookup of the newest record id.

## Where Penguin applies it

| Decision | Code | Under the policy |
|---|---|---|
| A plan part | `approveCleanParts` in `plan-approval.ts` | Penguin approves a pending part whose route names Penguin |
| A rule-written migration part after its trial | `migrationTrialReported` in `migration-plans.ts` | A failing test still makes an edit task. Under Pre-production a side-by-side run that differs goes to its worktree owner for review. A type set to auto-merge no longer sends the part to its worktree owner. Production sends a part whose trial passed to one |
| An overlapping start | `checkOverlap` in `overlap-lock.ts` | At every stage Penguin approves each new lock at once with a signed `approve_overlap` record that names the owner. The owner gets an `overlap_started` inbox item. No one is asked |
| A caller item | `callerAction`, `sweepUnanswered` and `ownerCallerItems` in `caller-items.ts` | The stage's row in [Caller items](#caller-items): who decides, who is told and the wait |

The break limit counts the parts that fail a check when a plan is proposed, whatever the policy.

## Measured split

`GET /api/review-policy` answers the policy, whether it is locked, who changed it last and when,
whether the signed-in person may change it and the split over the last 30 days. The split counts the
`approve_plan_part` and approved `migration_part_decided` records stored in that
window: parts Penguin approved and those people approved, overall and per type of approval that
marked them. `teams` gives the same split for each declared team, counting the parts its members own.
