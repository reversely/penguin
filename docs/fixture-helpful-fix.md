# Helpful-fix fixture

The helpful-fix fixture is a small Git repository for case 2 in [the README](../README.md#use-cases): the helpful fix.
Priya owns the shared date helper `start_of_day()` . Priya changes it to
return a UTC midnight to fix a bug in Priya's own ingestion batches. That change breaks Jun's weekly
report and Sam's reminder scheduling. `examples/helpful-fix/build.py` builds the repository from the
source directories next to the builder. `examples/helpful-fix/features.json` lists the base commit
and each feature: its id, owner, role, fork branch, declared area and commits. Every build produces
the same commit SHAs.
`examples/helpful-fix/pins.json` records them.

## Branches and tags

| Ref | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: three scopes declared in `penguin/scopes.json` with their owners, agent identities and contracts. `penguin/invariants.json` declares the analytics and messaging invariants. `shared/dates.py` holds `start_of_day()`, which returns midnight in the UTC offset of the datetime it receives. |
| `owner-priya-checkpoint` (tag) | Priya | `start_of_day()` returns midnight UTC of the UTC day. Two events recorded at one instant with different offsets fall into one daily ingestion batch. `ingestion/tests/test_batches.py` adds `test_events_at_one_instant_share_a_batch`. |
| `owner-jun-checkpoint` (tag) | Jun | The weekly activity report in `analytics/weekly.py` with `test_weekly.py`. The report converts each event to its user's UTC offset and calls `start_of_day()`. The penguin files add the contract `weekly_report` and its examples file. |
| `owner-sam-checkpoint` (tag) | Sam | Reminder scheduling in `messaging/reminders.py` with `test_reminders.py`. The scheduler converts the current time to the contact's UTC offset and adds the reminder hour to `start_of_day()`. `reminder_times()` lists each contact's next reminder as text. The penguin files add both contracts and the examples file. |
| `owner-priya`, tagged `owner-priya-local-day` | Priya | On `owner-priya-checkpoint`: `start_of_local_day(moment, utc_offset)` in `shared/dates.py`, declared as a contract. Priya's merge plan is proposed at this checkpoint |
| `owner-jun` | Jun | On `owner-jun-checkpoint`: the weekly report buckets events with `start_of_local_day()` |
| `owner-sam` | Sam | On `owner-sam-checkpoint`: reminder scheduling starts from `start_of_local_day()` |

Priya's scope `ingestion` owns the paths `ingestion/` and `shared/`. Jun's scope `analytics` and
Sam's scope `messaging` each declare a dependency on `ingestion` because they import
`shared.dates`. Each feature is a fork of `main`: its checkpoint starts from `main` and its fix
commit from the checkpoint. Each fix commit changes only paths in its owner's scope. Priya's second
commit also adds `start_of_local_day` to the contracts of Priya's scope. Every scope's tests pass on each checkpoint
alone. They also pass on `owner-priya` alone. `owner-jun` and `owner-sam` import
`start_of_local_day()`, which only `owner-priya` adds. Their tests run on a tree merged with
`owner-priya`. `pins.json` records the SHA of every branch head and tag. It also maps each failing
test to the commit that fixes it.

## Expected failures

Merging the three checkpoints fails two tests, one in Jun's scope and one in Sam's scope. The
ingestion tests pass on the merged tree. Each test sets its user's UTC offset itself, so the host
timezone does not change the result. The case names no test IDs.

| Pytest node ID | Merged tree | Failure |
|---|---|---|
| `analytics/tests/test_weekly.py::test_evening_activity_west_of_utc_stays_on_its_local_day` | `owner-priya-checkpoint` with `owner-jun-checkpoint` | A user at UTC-08:00 is active at 20:30 on Monday 9 February 2026, which is 04:30 UTC on Tuesday. `start_of_day()` returns the UTC midnight, so the report counts the activity on Tuesday. |
| `messaging/tests/test_reminders.py::test_fires_at_the_local_hour_west_of_utc` | `owner-priya-checkpoint` with `owner-sam-checkpoint` | A contact at UTC-08:00 asks for a 09:00 reminder at 08:00 local time. The scheduler adds 9 hours to the UTC midnight and gets 09:00 UTC, which has already passed. It schedules 09:00 UTC on the next day, which is 01:00 local time. |

## Fixes

The fixes follow case 2. Priya adds `start_of_local_day()`. Jun and Sam switch
their own code to it. Merged with `owner-priya`, each fix makes its own test pass. Merged with
`owner-priya` alone, without Jun's or Sam's switch, each test still fails.

| Pytest node ID | Fix commit | Fix |
|---|---|---|
| `analytics/tests/test_weekly.py::test_evening_activity_west_of_utc_stays_on_its_local_day` | `owner-jun` | The report takes each event's day from `start_of_local_day(event.at, offset)` with the user's UTC offset. The Monday evening activity counts on Monday. |
| `messaging/tests/test_reminders.py::test_fires_at_the_local_hour_west_of_utc` | `owner-sam` | The scheduler adds the reminder hour to `start_of_local_day(now, offset)` with the contact's UTC offset. The reminder fires at 09:00 local time, 17:00 UTC. |

`owner-priya` holds the helper that both fixes import. Priya reviews the helper. Jun and Sam review
the changes in their own scopes.

## Under the new procedure

In the approved design ([design.md](design.md#procedure)) this case runs as follows:

1. **Open.** The feature's area is `shared/dates` with the `start_of_day()` contract. Penguin lists
   Jun's weekly report and Sam's reminders as callers.
2. **Plan.** The signature stays the same, so the contract diff alone shows nothing. Penguin's
   side-by-side run shows `start_of_day()` returning a different day for users west of UTC, which
   makes the change a behaviour change. Priya's agent adds `start_of_local_day()` in its own feature
   and reports that commit, `owner-priya-local-day`, as its checkpoint. It then proposes switching Jun's and Sam's calls to the new helper. Each new call also passes the
   user's offset, so the switch is a behavioural fix that Priya's agent writes, not a codemod.
3. **Advance notice.** Jun's and Sam's agents each review their part. Each part's trial tree, the
   affected fork with the switch applied and `owner-priya-local-day` merged in, holds the helper, so
   both scopes' tests pass and both forms are accepted. Every check is clean, so Penguin approves
   both parts and tells Jun and Sam.
4. **Build.** Priya's agent writes the switch into Jun's and Sam's existing forks. Today Jun and Sam
   write the switch themselves (`owner-jun`, `owner-sam`), so those commits are the expected result.
   A pure rename of `start_of_day`, with no new argument, is mechanical; #94's exit check shows a
   LibCST codemod making that rename in every affected fork with no agent.
5. **Block promotion.** One promotion. Neither Jun's report nor Sam's reminders ever runs on the UTC
   helper. Neither Jun nor Sam is asked; each is told of Penguin's approval.

## Invariants, contracts and features

The base commit's `penguin/invariants.json` holds two invariants in the format in
[design.md](design.md#invariants-and-examples). Each statement follows the test that checks it.
That test's one-line docstring repeats the statement, so a merge plan states each break in the
invariant's words.

| Id | Scope | Statement | Protected | Recorded examples |
|---|---|---|---|---|
| `evening-activity-local-day` | analytics | Evening activity west of UTC stays on its local day | no | Jun's fork adds `analytics/examples/weekly_report.json`: daytime activity in UTC, evening activity at UTC-08:00 |
| `reminder-local-hour` | messaging | A reminder fires at the contact's local hour | no | Sam's fork adds `messaging/examples/reminder_times.json`: a contact in London and a contact at UTC-08:00, each asking for 09:00 |

`main` also names `ingestion/examples/daily_batches.json` for Priya's scope. Its two cases run
`daily_batches` on an afternoon event recorded in UTC and on an evening event recorded at UTC-08:00.
The file bears on no invariant. It shows the behaviour change of `start_of_day()` to Priya's own
review.

A side-by-side run passes inputs as JSON. The shared date helpers therefore include
`parse_instant`, `parse_day` and `parse_utc_offset`, which build a `datetime`, a `date` and a
`timedelta` from ISO 8601 text. Each examples file builds its arguments by calling them. Sam's
reminders add `reminder_times`, which returns each contact's next reminder as ISO 8601 text, because
the side-by-side run encodes a returned `datetime` without its value.

`penguin/scopes.json` declares each scope's contracts. Ingestion declares `daily_batches`, `Event`,
`start_of_day`, `require_offset` and the three parse helpers. Analytics declares `events_per_user`.
Messaging declares `Contact` and `local_timezone`. Priya's second commit adds `start_of_local_day`.

`features.json` lists Priya's feature "Start each day at UTC midnight in start_of_day" as the
originating feature on the fork `owner-priya`. Its second commit, tagged `owner-priya-local-day`,
carries `"plan": true`: the preview seed (`scripts/preview/seed.ts`) reports it as Priya's checkpoint
and proposes the plan there, as PRD case 2 orders it. Jun's weekly report (`owner-jun`) and Sam's reminder
scheduling (`owner-sam`) are the running features. Jun's checkpoint adds the contract `weekly_report`
with its examples file. Sam's checkpoint adds `next_reminder` and `reminder_times` with theirs. Jun's
examples entry goes first in `penguin/invariants.json` and Sam's goes last, so the two forks merge
without a conflict.

`reviews/analytics.json` and `reviews/messaging.json` hold the review forms Jun's and Sam's agents
submit on Priya's feature. Each reports its scope's invariant as holding. Penguin checks a form's
evidence in the reviewed feature's fork, which is Priya's. The tests that state the two invariants
live in Jun's and Sam's forks, so each row cites its scope's contract on main as evidence:
`analytics/totals.py::events_per_user` and `messaging/contacts.py::local_timezone`. The builder does
not commit the forms.

## Impact and review on this fixture

The results below come from `penguin-bridge impact`, `penguin-bridge review` and
`penguin-bridge check` on a fresh build. A review of a running feature compares the fork's
checkpoint with a block tree: a fork head with Priya's head merged onto it.

`penguin-bridge impact --base main --head owner-priya-checkpoint`, with Jun's and Sam's checkpoints
as forks, reports one modified function, `start_of_day`, under the contract
`shared/dates.py::start_of_day`. The signature stays the same. Both forks call the function, so both
forks run tests.

| Review | Base | Fork | Side-by-side differences | Verdict and exceptions |
|---|---|---|---|---|
| Ingestion | `main` | `owner-priya-checkpoint` | The evening event at UTC-08:00 moves from the 2026-02-09 batch to the 2026-02-10 batch | Accepted. No exception |
| Analytics | `owner-jun-checkpoint` | `owner-priya-checkpoint` merged onto it | Evening activity at UTC-08:00 counts on Monday 9 February on the base and on Tuesday 10 February on the fork | Accepted. The reported break goes to Jun as a `broken_invariant` |
| Analytics | `owner-jun-checkpoint` | `owner-priya` merged onto `owner-jun` | None | Accepted with `test_evening_activity_west_of_utc_stays_on_its_local_day` as evidence. No exception |
| Messaging | `owner-sam-checkpoint` | `owner-priya-checkpoint` merged onto it | The contact at UTC-08:00 gets a reminder at 17:00 UTC on 9 February on the base and at 09:00 UTC on 10 February on the fork | Accepted. The reported break goes to Sam as a `broken_invariant` |
| Messaging | `owner-sam-checkpoint` | `owner-priya` merged onto `owner-sam` | None | Accepted with `test_fires_at_the_local_hour_west_of_utc` as evidence. No exception |

`penguin-bridge check` on the three checkpoints passes overlap, merge, dependencies, lint, format and
the type check on every merged tree. It fails one test on Jun's merged tree and one on Sam's. On the
three fixed heads every check passes.

## Manual reproduction

The steps need Git 2.38 or later for `git merge-tree --write-tree`. They also need Python 3.11 or
later with pytest. The test commands are the `test_command` values in `penguin/scopes.json`, run
from the root of the tree under test.

1. From the Penguin checkout, install the environment and put its Python first on `PATH`:

   ```sh
   uv sync
   export PATH="$PWD/.venv/bin:$PATH"
   ```

2. Build the fixture into a new directory and compare the refs with `pins.json`:

   ```sh
   python examples/helpful-fix/build.py /tmp/penguin-helpful-fix
   cat examples/helpful-fix/pins.json
   ```

   The builder prints one line per branch and tag: the ref name and its commit SHA.

3. Check each checkpoint alone. For each tag and for `owner-priya`, extract the ref into its own
   directory and run the three scope test commands:

   ```sh
   cd /tmp/penguin-helpful-fix
   mkdir ../owner-jun-checkpoint
   git archive owner-jun-checkpoint | tar -x -C ../owner-jun-checkpoint
   cd ../owner-jun-checkpoint
   python -m pytest ingestion shared
   python -m pytest analytics
   python -m pytest messaging
   cd /tmp/penguin-helpful-fix
   ```

   Every command exits 0.

4. Merge the three checkpoints and run every scope's tests on the merged tree. `git merge-tree`
   merges two commits, so the first merged tree becomes a commit before the second merge:

   ```sh
   git merge-tree --write-tree owner-priya-checkpoint owner-jun-checkpoint
   git commit-tree <tree SHA printed above> -p owner-priya-checkpoint -p owner-jun-checkpoint -m "Merge the Priya and Jun checkpoints"
   git merge-tree --write-tree <commit SHA printed above> owner-sam-checkpoint
   mkdir ../merged-checkpoints
   git archive <tree SHA printed above> | tar -x -C ../merged-checkpoints
   cd ../merged-checkpoints
   python -m pytest ingestion shared
   python -m pytest analytics
   python -m pytest messaging
   cd /tmp/penguin-helpful-fix
   ```

   `git merge-tree` prints a single tree SHA because each merge has no conflicts. The ingestion run
   exits 0. The analytics run reports `1 failed, 3 passed`. The messaging run reports
   `1 failed, 4 passed`. Their short test summaries list these tests as `FAILED`:

   ```text
   analytics/tests/test_weekly.py::test_evening_activity_west_of_utc_stays_on_its_local_day
   messaging/tests/test_reminders.py::test_fires_at_the_local_hour_west_of_utc
   ```

5. Merge the three fixed branches the same way and run every scope's tests on the merged tree:

   ```sh
   git merge-tree --write-tree owner-priya owner-jun
   git commit-tree <tree SHA printed above> -p owner-priya -p owner-jun -m "Merge owner-priya and owner-jun"
   git merge-tree --write-tree <commit SHA printed above> owner-sam
   mkdir ../combined
   git archive <tree SHA printed above> | tar -x -C ../combined
   cd ../combined
   python -m pytest ingestion shared
   python -m pytest analytics
   python -m pytest messaging
   ```

   Every command exits 0.

`uv run pytest -m slow` runs the same steps in `tests/test_helpful_fix_reproduction.py`. It asserts
that every scope passes on each checkpoint alone and on `owner-priya` alone. It asserts that the
merged checkpoints fail exactly the two tests above with the host timezone set to `UTC`,
`Asia/Tokyo` and `America/Los_Angeles`. It asserts that `owner-priya` merged with Jun's or Sam's
checkpoint still fails that owner's test. It asserts that each fix merged with `owner-priya` passes
and that the combined run on the fixed branches passes. It also asserts that `pins.json` maps each
test to its fix commit and that each fix commit changes only its owner's scope paths.

## Changing the fixture

A change to a source directory under `examples/helpful-fix/` changes the SHA of the commit built
from it. It also changes the SHA of every commit that starts from that commit. Run
`uv run pre-commit run --all-files` before rebuilding, because ruff can rewrite a fixture source
file. Then rebuild into an empty directory and copy the printed SHAs into the `branches`, `tags` and
`fixes` objects of `pins.json`. A new commit goes into `features.json`. `examples/ruff.toml` makes
ruff in this repository sort the fixture's imports as ruff does in the built repository. `tests/test_helpful_fix_builder.py` fails until `pins.json` matches
a fresh build. The detect-secrets hook reads each SHA in `pins.json` as a possible secret. Run
`uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record the
new SHAs as known values.
