# Helpful-fix fixture

The helpful-fix fixture is a small Git repository for case 2 in [the README](../README.md#use-cases): the helpful fix.
Priya owns the shared date helper `start_of_day()` . Priya changes it to
return a UTC midnight to fix a bug in Priya's own ingestion batches. That change breaks Jun's weekly
report and Sam's reminder scheduling. `examples/helpful-fix/build.py` builds the repository from the
source directories next to the builder. Every build produces the same commit SHAs.
`examples/helpful-fix/pins.json` records them.

## Branches and tags

| Ref | Owner | Commit contents |
|---|---|---|
| `main` | none | The base commit: three scopes declared in `penguin/scopes.json` with their owners and agent identities. `shared/dates.py` holds `start_of_day()`, which returns midnight in the UTC offset of the datetime it receives. |
| `owner-priya-checkpoint` (tag) | Priya | `start_of_day()` returns midnight UTC of the UTC day. Two events recorded at one instant with different offsets fall into one daily ingestion batch. `ingestion/tests/test_batches.py` adds `test_events_at_one_instant_share_a_batch`. |
| `owner-jun-checkpoint` (tag) | Jun | The weekly activity report in `analytics/weekly.py` with `test_weekly.py`. The report converts each event to its user's UTC offset and calls `start_of_day()`. |
| `owner-sam-checkpoint` (tag) | Sam | Reminder scheduling in `messaging/reminders.py` with `test_reminders.py`. The scheduler converts the current time to the contact's UTC offset and adds the reminder hour to `start_of_day()`. |
| `owner-priya` | Priya | On `owner-priya-checkpoint`: `start_of_local_day(moment, utc_offset)` in `shared/dates.py` |
| `owner-jun` | Jun | On `owner-jun-checkpoint`: the weekly report buckets events with `start_of_local_day()` |
| `owner-sam` | Sam | On `owner-sam-checkpoint`: reminder scheduling starts from `start_of_local_day()` |

Priya's scope `ingestion` owns the paths `ingestion/` and `shared/`. Jun's scope `analytics` and
Sam's scope `messaging` each declare a dependency on `ingestion` because they import
`shared.dates`. Each checkpoint starts from `main`. Each fix commit starts from its owner's
checkpoint and changes only paths in its owner's scope. Every scope's tests pass on each checkpoint
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
   makes the change a behaviour change. Priya's agent adds `start_of_local_day()` in its own feature.
   It proposes switching Jun's and Sam's calls to the new helper. Penguin classifies that switch as
   mechanical: a codemod on each call site.
3. **Advance notice.** Jun and Sam each approve their part. Their review forms cite the two tests in
   [Expected failures](#expected-failures).
4. **Build.** Penguin's codemod writes the switch into Jun's and Sam's existing forks. No agent
   writes a fix. Today Jun and Sam write the switch themselves (`owner-jun`, `owner-sam`), so those
   commits become the codemod's expected output.
5. **Block promotion.** One promotion. Neither Jun's report nor Sam's reminders ever runs on the UTC
   helper. Jun and Sam are each asked once, for approval.

Before it can run this way, the fixture needs three additions:

- `penguin/invariants.json` in the base commit, with the local-day and local-hour invariants the two
  tests check
- contracts per scope in `penguin/scopes.json`, starting with `start_of_day()`
- Jun's and Sam's work as running features: forks of `main` in place of the `owner-*-checkpoint` tags

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
   `1 failed, 3 passed`. Their short test summaries list these tests as `FAILED`:

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
`fixes` objects of `pins.json`. `tests/test_helpful_fix_builder.py` fails until `pins.json` matches
a fresh build. The detect-secrets hook reads each SHA in `pins.json` as a possible secret. Run
`uv run detect-secrets scan --baseline .secrets.baseline` after changing `pins.json` to record the
new SHAs as known values.
