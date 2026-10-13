# Validation

Penguin decides whether a change may reach main by running checks. Every check falls under one of six
kinds of validation. The dashboard, the `get_work` answer, the signed records and these docs use the
same six names. This page defines each kind: what it checks, the tool that runs it, who decides a
result by default and how a sandbox's review policy changes that.

A sandbox is one Penguin project: its base repo and the forks its agents work in. Each sandbox has
one review policy ([review-policies.md](review-policies.md)).

## Kinds

| Kind | What it checks | Tool that runs it | Who decides by default (Dev) |
|---|---|---|---|
| Tests | The scopes' tests pass on the merged tree that holds the fix. The block checks pass: the merge, lint, format, type check, dependency diff and retiring calls | The check runner: the plan's facts run, each part's trial and each block run (`git merge-tree`, the scope's `test_command`, `ruff`, `pyright`, the dependency diff) | A failure always goes back to the agent. Penguin approves no part whose tests have not passed, under every policy |
| Logic | The owner's agent fills in a review form saying each declared invariant still holds | `submit_review`, validated by Penguin and recorded by the check runner (`review-submit.ts`, `review-record.ts`) | The part's owner, when the form reports an invariant broken or not holding, or the runner refuses it |
| Data matching | A side-by-side run of main and the fork gives the same output on each protected invariant's examples | The check runner's side-by-side run over `penguin/invariants.json` examples, in the review or the part's trial | The part's owner, when a protected invariant differs |
| Stored data | A changed stored shape that another scope reads comes with a migration or backfill in the originating change | The review record's changed stored shapes, read against the plan's `storeMarker` | The originating feature's person, when the plan names no migration or backfill |
| Protected paths and place | The fix writes no path a scope's owner protects in `penguin/scopes.json` and changes no file outside the part's scopes | `partRouting` over the part's diff and the scope map; the block check `overlap` compares the writes of two blocks | The part's owner, or the protecting person for a protected path |
| Overlapping starts | A new feature's declared area does not overlap another person's running feature | The overlap lock at each declaration and checkpoint (`overlap-lock.ts`) | The person who owns the covering feature approves the start |

Protected paths and Place are one kind. The review policy keeps them as two rows, so a sandbox may let
Penguin decide one and not the other.

## How a result is decided

1. Penguin runs the checks of each kind that apply to the part or the start.
2. A failed test sends the part back to the agent. Nothing else is decided until the tests pass.
3. Each other kind whose check does not pass marks the part with that kind's type of approval.
4. The sandbox's review policy names, for each type, Penguin or a person. A part goes to a person
   when any of its types is set to person. Penguin approves it when every one of its types is set to
   Penguin, or when no check marked it. The owners are told of every approval Penguin makes.
5. While a review form is still to come, Penguin waits for it when Logic, Data matching or Stored
   data is set to person, as those kinds read the form.

`policyRoute` in `packages/protocol/src/validation.ts` holds the rule. Each decision's signed record
carries the route under `review_policy`: the preset, whether a row was changed, whether admin mode
locked it, who decided, the rule and the kinds whose checks marked the part.

## Where the names appear

| Place | What it shows |
|---|---|
| Plan inbox (`GET /api/plan-parts`) | Each part's `route`: who decides, the rule and the kinds |
| `get_work` | `reviewPolicy` and, on each part, `routing` with `reason`, `kinds` and `types` in these names |
| Records | `approve_plan_part`, `migration_part_decided` and `approve_overlap` carry `review_policy` |
| Code | `VALIDATION_KINDS`, `VALIDATION_KIND_LABEL`, `reasonKind` and `blockCheckKind` in `validation.ts` |
