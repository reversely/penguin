# Validation

Penguin decides whether a change may reach main by running checks. Every check falls under one of six
kinds of validation. The dashboard, the `get_work` answer, the signed records and these docs use the
same six names. This page defines each kind: what it checks, the tool that runs it, who decides a
result by default and how a sandbox's review policy changes that.

Code ships through five stages: local development, central development, test, pre-production and
production. Penguin runs a sandbox where the work coding agents do in local development merges. A
sandbox is one Penguin project: its base repo and the forks its agents work in. A team can run a
sandbox at any of the five stages. Each sandbox has one review policy, which names its stage and so
sets how much of the review Penguin does and how much people do
([review-policies.md](review-policies.md)). People decide more at each stage nearer production.

## Kinds

| Kind | What it checks | Tool that runs it | Who decides by default (Central development) |
|---|---|---|---|
| Tests | The scopes' tests pass on the merged tree that holds the fix. The block checks pass: the merge, lint, format, type check, dependency diff and retiring calls | The check runner: the plan's facts run, each part's trial and each block run (`git merge-tree`, the scope's `test_command`, `ruff`, `pyright`, the dependency diff) | A failure always goes back to the agent. Penguin approves no part whose tests have not passed, under every policy |
| Logic | The owner's agent fills in a review form saying each declared invariant still holds | `submit_review`, validated by Penguin and recorded by the check runner (`review-submit.ts`, `review-record.ts`) | The part's owner, when the form reports an invariant broken or not holding, or the runner refuses it |
| Data matching | A side-by-side run of main and the fork gives the same output on each protected invariant's examples | The check runner's side-by-side run over `penguin/invariants.json` examples, in the review or the part's trial | The part's owner, when a protected invariant differs |
| Stored data | A changed stored shape that another scope reads comes with a migration or backfill in the originating change | The review record's changed stored shapes, read against the plan's `storeMarker` | The originating feature's person, when the plan names no migration or backfill |
| Custom path rules and place | The fix writes no path under a custom path rule, which a scope's owner lists under `custom_paths` in `penguin/scopes.json`. It changes no file outside the part's scopes. Penguin's update of a fork also copies modules of the originating change; each copy must be a file that change itself added or changed | `partRouting` over the part's diff and the scope map; the block check `overlap` compares the writes of two blocks | The part's owner, or the owner of the custom path rule, who confirms the lines on the dashboard |
| Overlapping starts | Where a new feature's declared area overlaps another person's running feature | The overlap lock at each declaration and checkpoint (`overlap-lock.ts`) | Penguin lets the start open at every stage. It records the overlap with a signed `approve_overlap` record and tells the person who owns the running feature |

Data matching also has a check that needs no examples file: the caller replay. Each running feature
that calls a function the change modifies runs its own tests on its fork head and on the merged
tree with that function wrapped. Each call site gets `unaffected`, `broken`, `differs` or
`unknown_reach` from the calls' results, exceptions and effects
([design.md](design.md#caller-replay)). The verdicts sit in the `check` result, the block run's report
and its `block_checked` record. Each opens a caller item that the receiving worktree's agent confirms
or approves before the change writes into its fork or reaches main
([design.md](design.md#caller-items-in-the-build)). The review policy's stage decides when the
worktree owner decides items too ([review-policies.md](review-policies.md#caller-items)).

Custom path rules and Place are one kind. The review policy keeps them as two rows, so a sandbox may
let Penguin decide one and not the other. Overlapping starts is no row of the policy: an overlapping
start never waits on a worktree owner's review.

A scope file written before the rename may still name its custom path rules `protected_paths`. The
scope map reads that key as `custom_paths`. The wire and record names keep the earlier word so that
signed records still read: the kind `protected_paths_and_place`, the row `protected_paths`, the
routing reason and plan part ask `protected_path`, the inbox reason `protected_path`, the record
`confirm_protected_change` and the route `POST /api/plan-parts/confirm-protected`.

## How a result is decided

1. Penguin runs the checks of each kind that apply to the part or the start.
2. A failed test sends the part back to the agent that made the change. Nothing else is decided until the tests pass.
3. Each other kind whose check does not pass marks the part with that kind's type of approval.
4. The sandbox's review policy names, for each type, Auto-merge or Worktree owner reviews (stored as
   `penguin` and `person`). An update that passes merges into the affected branch automatically
   when every one of its types is set to auto-merge, or when no check marked it. The worktree owners are told
   of every update Penguin merges. An update waits for the worktree owner's review
   when any of its types is set to worktree owner review. Production sends every update to its worktree owner whatever
   its rows say.
5. While a review form is still to come, Penguin waits for it when Logic, Data matching or Stored
   data is set to worktree owner review, as those kinds read the form.

`policyRoute` in `packages/protocol/src/validation.ts` holds the rule. Each decision's signed record
carries the route under `review_policy`: the preset, whether a row was changed, whether admin mode
locked it, who decided, the rule and the kinds whose checks marked the part.

## Where the names appear

| Place | What it shows |
|---|---|
| Plan inbox (`GET /api/plan-parts`) | Each part's `route`: who decides, the rule and the kinds |
| `get_work` | `reviewPolicy` and, on each part, `routing` with `reason`, `kinds` and `types` in these names |
| Records | `approve_plan_part` and `migration_part_decided` carry `review_policy`; `approve_overlap` names the owner Penguin told; each caller item record names the stage's reason when the worktree owner decides |
| Code | `VALIDATION_KINDS`, `VALIDATION_KIND_LABEL`, `reasonKind` and `blockCheckKind` in `validation.ts` |
